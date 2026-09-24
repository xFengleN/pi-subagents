import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { formatFactoryReport } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { validatePersistedFactoryRunState } from "../../src/ai-factory/recovery-model.js";
import { createRequirementCatalog, validateArchitectTargetApproval, validateTargets } from "../../src/ai-factory/targets.js";
import type { ArchitectInitialResult, FactoryConfig, FactoryTarget, LeadProposalPacket } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
let serial = 0;
function make(targets: FactoryTarget[], overrides: Partial<FactoryConfig> = {}) {
  const fixture = tempStore();
  cleanups.push(fixture.cleanup);
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const deps = { transport, clock, store: fixture.store, config: mergeFactoryConfig(defaultFactoryConfig(), overrides as Record<string, unknown>) };
  const controller = FactoryController.create(deps, `target-${++serial}`, "Implement all requested targets", fixture.dir);
  return { controller, fixture, transport, clock, deps, targets };
}
const target = (id: string, dependsOn: string[] = []): FactoryTarget => ({ id, description: `Deliver ${id}`, dependsOn, acceptanceCriteria: [`Test ${id}`] });
function proposalFor(targets: FactoryTarget[], extra: Record<string, unknown> = {}) {
  const proposal = { ...packets.proposal, workPackages: targets.map((item) => item.id), targets, humanRequirements: ["Implement all requested targets"], ...extra };
  return { ...proposal, requirementCatalog: createRequirementCatalog(proposal.humanRequirements, proposal.constraints) };
}

function architectApproval(proposal: ReturnType<typeof proposalFor>, targets: FactoryTarget[], extra: Record<string, unknown> = {}) {
  const requirements = proposal.requirementCatalog.map((requirement) => requirement.text);
  return {
    ...packets.approve,
    constraints: proposal.constraints,
    approvedTargets: targets,
    planAssessment: {
      verdict: "complete",
      missionRequirements: requirements,
      missionDependencies: proposal.humanDependencies ?? [],
      requirementCoverage: proposal.requirementCatalog.map((requirement) => ({ requirementId: requirement.id, targetIds: targets.map((item) => item.id) })),
      preservedConstraintIds: proposal.requirementCatalog.filter((requirement) => requirement.source === "human_constraint").map((requirement) => requirement.id),
      uncoveredRequirements: [],
    },
    ...extra,
  };
}

async function approveWithPlan(m: ReturnType<typeof make>, proposed: FactoryTarget[], approved: FactoryTarget[], extra: Record<string, unknown> = {}): Promise<void> {
  const proposal = proposalFor(proposed, extra);
  m.controller.start();
  await flush();
  m.transport.completeLastPacket(proposal);
  await flush();
  m.transport.completeLastPacket(architectApproval(proposal, approved));
  await flush();
}

async function approve(m: ReturnType<typeof make>): Promise<void> {
  await approveWithPlan(m, m.targets, m.targets);
}
async function review(m: ReturnType<typeof make>, id: string, verdict: unknown = packets.reviewerPass): Promise<void> {
  expect(m.transport.spawned.at(-1)?.phase).toBe("execution.engineer");
  expect(m.transport.spawned.at(-1)?.prompt).toContain(`Work package: ${id}`);
  m.transport.completeLastPacket({ ...packets.engineer, workPackageId: id, changedFiles: [`${id}.ts`] });
  await flush();
  m.transport.completeLastPacket(verdict);
  await flush();
}

describe("AI Factory — persisted serial targets", () => {
  it("executes three dependent targets and gates mission integration until all pass", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"]), target("WP2", ["WP1"])]);
    await approve(m);
    for (const id of ["WP0", "WP1"]) {
      await review(m, id);
      expect(m.controller.getState().results.integration).toBeUndefined();
      expect(m.controller.getState().state).toBe("EXECUTION");
      expect(m.fixture.store.load(m.controller.getRunId())?.targetPlan?.outcomes[id].status).toBe("passed");
    }
    await review(m, "WP2");
    expect(m.transport.spawned.at(-1)?.phase).toBe("integration.lead");
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(3);
    expect(m.controller.getState().targetPlan?.targets.map((t) => t.id)).toEqual(["WP0", "WP1", "WP2"]);
    expect(m.controller.getState().results.initialArchitect?.packet.approvedTargets).toEqual(m.targets);
    expect(m.controller.getState().results.initialArchitect?.packet.planAssessment?.verdict).toBe("complete");
  });

  it("keeps mission validation, final acceptance, and reporting in Factory lifecycle", async () => {
    const targets = [target("T1"), target("T2"), target("T3", ["T2"])];
    const m = make(targets);
    await approve(m);
    for (const id of ["T1", "T2", "T3"]) await review(m, id);

    expect(m.transport.spawned.at(-1)?.phase).toBe("integration.lead");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Run the requested mission-level tests/checks");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("do not delegate this lifecycle phase to an extra implementation target");
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["T1", "T2", "T3"] });
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("final.architect");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("final architecture/acceptance checkpoint");
    m.transport.completeLastPacket(packets.accept);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("final_synthesis.lead");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("final human-facing completion report");
    m.transport.completeLastPacket(packets.finalReport);
    await flush();

    expect(m.controller.getState().state).toBe("DONE");
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "execution.engineer")).toHaveLength(3);
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "final_synthesis.lead")).toHaveLength(1);
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer" && spawn.prompt.includes("Work package: T4"))).toBe(false);
  });

  it("executes the Architect-corrected dependency graph rather than the Lead proposal", async () => {
    const proposed = [target("WP1"), target("WP0")];
    const corrected = [target("WP1", ["WP0"]), target("WP0")];
    const m = make(proposed);
    await approveWithPlan(m, proposed, corrected);
    expect(m.controller.getState().targetPlan?.targets).toEqual(corrected);
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP0");
    await review(m, "WP0");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
  });

  it("repairs only the active target; never replays a passed predecessor", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    await approve(m);
    await review(m, "WP0");
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP1" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("missing error handling");
    await review(m, "WP1");
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(3);
    expect(m.controller.getState().targetPlan?.outcomes.WP0.status).toBe("passed");
  });

  it("Lead continuation spawns one fresh Engineer for the same target", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])], { maxRepairRounds: 0, maxLeadEscalations: 1 });
    await approve(m);
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.lead");
    m.transport.completeLastPacket({ verdict: "continue", guidance: "Fix this target", reason: "bounded correction" });
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("execution.engineer");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP0");
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "execution.engineer")).toHaveLength(2);
  });

  it("fails an exhausted target, blocks dependents, and continues independent work", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"]), target("WP2")], { maxRepairRounds: 0, maxLeadEscalations: 0 });
    await approve(m);
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();
    expect(m.controller.getState().targetPlan?.outcomes.WP0.status).toBe("failed");
    expect(m.controller.getState().targetPlan?.outcomes.WP1.status).toBe("blocked");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP2");
    await review(m, "WP2");
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(2);
    const report = formatFactoryReport(m.controller.getState());
    expect(report).toContain("WP0: failed");
    expect(report).toContain("WP1: blocked");
    expect(report).toContain("WP2: passed");
    expect(report).toContain("Proposed: 3; completed and reviewed: 1; failed: 1; blocked: 1");
    expect(report).not.toContain("Terminal classification: completed accepted run");
  });

  it("does not persist validated Engineer provenance without its packet and safely resumes the next target", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    const snapshots: ReturnType<typeof m.controller.getState>[] = [];
    const save = m.fixture.store.save.bind(m.fixture.store);
    m.fixture.store.save = (state, token) => {
      snapshots.push(structuredClone(state));
      save(state, token);
    };
    await approve(m);
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    const acceptedSuccessor = snapshots.find((state) => state.state === "EXECUTION" && state.targetPlan?.currentTargetId === undefined && state.targetPlan.outcomes.WP0.status === "passed");
    expect(acceptedSuccessor).toBeDefined();
    m.controller.dispose();
    m.fixture.store.save(acceptedSuccessor!);
    const restoredTransport = new FakeTransport();
    const restored = FactoryController.restore({ ...m.deps, transport: restoredTransport }, m.controller.getRunId(), { resume: false })!;
    expect(restored.getRecoveryEligibility().requiresApproval).toBe(false);
    expect(restored.resume().kind).toBe("ok");
    await flush();
    expect(restoredTransport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
    expect(restoredTransport.spawned.filter((spawn) => spawn.phase === "execution.engineer")).toHaveLength(1);
    restored.dispose();

    for (const state of snapshots) {
      for (const attempt of state.attempts ?? []) {
        if (attempt.provenance !== "settled_validated_packet" || attempt.role !== "engineer") continue;
        expect(state.results.engineers.some((item) => item.outcome.agentId === attempt.agentId)).toBe(true);
      }
    }
  });

  it("requires owner approval for a validated Engineer attempt missing its packet", async () => {
    const m = make([target("WP0")]);
    await approve(m);
    const snapshot = m.fixture.store.load(m.controller.getRunId())!;
    const attempt = snapshot.attempts!.at(-1)!;
    expect(attempt.phase).toBe("execution.engineer");
    snapshot.inFlight = undefined;
    attempt.provenance = "settled_validated_packet";
    attempt.packetValidated = true;
    attempt.recoveryRisk = "validated_packet";
    m.controller.dispose();
    m.fixture.store.save(snapshot);

    const restoredTransport = new FakeTransport();
    const restored = FactoryController.restore({ ...m.deps, transport: restoredTransport }, snapshot.runId)!;
    await flush();
    expect(restored.getRecoveryEligibility().requiresApproval).toBe(true);
    expect(restored.resume().kind).toBe("approvalRequired");
    expect(restoredTransport.spawned).toHaveLength(0);
    restored.dispose();
  });

  it("does not replay completed targets when resuming an interrupted successor", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    await approve(m);
    await review(m, "WP0");
    const existing = m.transport.spawned.filter((s) => s.phase === "execution.engineer").length;
    m.controller.dispose();
    const restoredTransport = new FakeTransport();
    const restored = FactoryController.restore({ ...m.deps, transport: restoredTransport }, m.controller.getRunId(), { resume: false })!;
    const eligibility = restored.getRecoveryEligibility();
    expect(eligibility.requiresApproval).toBe(true);
    expect(eligibility.checkpointId).toContain("target=WP1");
    expect(restored.resumeWithApproval(eligibility.checkpointId).kind).toBe("ok");
    await flush();
    expect(restoredTransport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
    expect(restoredTransport.spawned).toHaveLength(1);
    expect(existing).toBe(2);
    expect(restored.getState().targetPlan?.outcomes.WP0.status).toBe("passed");
    restored.dispose();
  });

  it("requires an explicit scope for multi-target remediation, then revalidates affected dependents", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"]), target("WP2")]);
    await approve(m);
    for (const id of ["WP0", "WP1", "WP2"]) await review(m, id);
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1", "WP2"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.remediate, affectedTargetIds: ["WP0"] });
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("remediation.engineer");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP0");
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0", changedFiles: ["WP0-fixed.ts"] });
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("review.reviewer");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Revalidation after upstream correction");
    expect(m.controller.getState().targetPlan?.outcomes.WP2.status).toBe("passed");
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("final_recheck.architect");
    expect(m.controller.getState().targetPlan?.outcomes.WP1.reviewerAgentId).toBe(m.controller.getState().results.reviewers.at(-1)?.outcome.agentId);
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(3);
  });

  it("refuses ambiguous mission-level corrections instead of dispatching WP0 again", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    await approve(m);
    await review(m, "WP0");
    await review(m, "WP1");
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1"] });
    await flush();
    m.transport.completeLastPacket(packets.remediate);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("no safe, unique target");
    expect(m.transport.spawned.filter((s) => s.phase === "remediation.engineer")).toHaveLength(0);
  });

  it("revalidates transitive dependents in topological order and reports interrupted review honestly", async () => {
    const m = make([target("WP0"), target("WP2", ["WP1"]), target("WP1", ["WP0"])]);
    await approve(m);
    for (const id of ["WP0", "WP1", "WP2"]) await review(m, id);
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1", "WP2"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.remediate, affectedTargetIds: ["WP0"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    expect(m.controller.getState().targetPlan?.revalidationIds).toEqual(["WP1", "WP2"]);
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP1");
    m.controller.stop("Operator stopped before dependent revalidation");
    const report = formatFactoryReport(m.controller.getState());
    expect(report).toContain("WP1: revalidating");
    expect(report).toContain("WP2: awaiting revalidation");
    expect(report).toContain("completed and reviewed: 1");
    expect(report).toContain("awaiting revalidation: 2");
    expect(report).not.toContain("WP2: passed");
  });

  it("keeps independent dependents eligible after a sibling fails revalidation", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"]), target("WP2", ["WP0"]), target("WP3", ["WP1", "WP2"])], { maxRepairRounds: 0, maxLeadEscalations: 0 });
    await approve(m);
    for (const id of ["WP0", "WP1", "WP2", "WP3"]) await review(m, id);
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1", "WP2", "WP3"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.remediate, affectedTargetIds: ["WP0"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();

    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();
    expect(m.controller.getState().targetPlan?.outcomes.WP1.status).toBe("failed");
    expect(m.controller.getState().targetPlan?.outcomes.WP2.status).toBe("active");
    expect(m.controller.getState().targetPlan?.outcomes.WP3.status).toBe("blocked");
    expect(m.controller.getState().targetPlan?.outcomes.WP3.blockedBy).toContain("WP1");
    expect(m.transport.spawned.at(-1)?.phase).toBe("review.reviewer");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP2");

    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().targetPlan?.outcomes.WP2.status).toBe("passed");
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "final_recheck.architect")).toHaveLength(0);
  });

  it("marks scoped remediation and its dependents failed when Engineer work is partial and Reviewer rejects", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    await approve(m);
    await review(m, "WP0");
    await review(m, "WP1");
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.remediate, affectedTargetIds: ["WP0"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.engineer, status: "partially_completed", workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();

    const state = m.controller.getState();
    expect(state.state).toBe("STOPPED");
    expect(state.targetPlan?.outcomes.WP0.status).toBe("failed");
    expect(state.targetPlan?.outcomes.WP1.status).toBe("blocked");
    const report = formatFactoryReport(state);
    expect(report).toContain("WP0: failed");
    expect(report).toContain("WP1: blocked");
    expect(report).not.toContain("WP0: passed");
    expect(report).not.toContain("WP1: passed");
  });

  it("revalidation failure is not converted into final acceptance", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])], { maxRepairRounds: 0, maxLeadEscalations: 0 });
    await approve(m);
    await review(m, "WP0");
    await review(m, "WP1");
    m.transport.completeLastPacket({ ...packets.integration, completedWorkPackages: ["WP0", "WP1"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.remediate, affectedTargetIds: ["WP0"] });
    await flush();
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP0" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    m.transport.completeLastPacket(packets.reviewerNeedsFix);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().targetPlan?.outcomes.WP1.status).toBe("failed");
    expect(m.transport.spawned.filter((s) => s.phase === "final_recheck.architect")).toHaveLength(0);
  });

  it("invokes a per-target Architect gate only when the approved target requires it", async () => {
    const m = make([target("WP0"), { ...target("WP1", ["WP0"]), requiresArchitectAcceptance: true }, target("WP2", ["WP1"])]);
    await approve(m);
    await review(m, "WP0");
    await review(m, "WP1");
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.architect");
    expect(m.controller.getState().targetPlan?.outcomes.WP1.architectAgentId).toBeUndefined();
    expect(m.transport.spawned.some((spawn) => spawn.prompt.includes("Work package: WP2"))).toBe(false);
    m.transport.completeLastPacket(packets.approve);
    await flush();
    expect(m.controller.getState().targetPlan?.outcomes.WP1.architectAgentId).toBeDefined();
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP2");
  });

  it("blocks unapproved changes to a completed target during Architect reassessment", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])], { maxRepairRounds: 0 });
    await approve(m);
    await review(m, "WP0");
    m.transport.completeLastPacket({ ...packets.engineer, workPackageId: "WP1" });
    await flush();
    m.transport.completeLastPacket(packets.reviewerArchitectural);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.architect");
    m.transport.completeLastPacket({ ...packets.correct, approvedTargets: [{ ...target("WP0"), description: "Changed accepted contract" }, target("WP1", ["WP0"])] });
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().targetPlan?.outcomes.WP0.status).toBe("passed");
    expect(m.controller.getState().stoppedReason).toContain("previously passed contracts");
  });

  it("rejects corrupt plan evidence without throwing or dispatching", async () => {
    const m = make([target("WP0"), target("WP1", ["WP0"])]);
    await approve(m);
    await review(m, "WP0");
    const snapshot = structuredClone(m.fixture.store.load(m.controller.getRunId())!);
    snapshot.targetPlan!.outcomes.WP0.reviewerAgentId = "invented-pass";
    expect(validatePersistedFactoryRunState(snapshot, m.fixture.dir).issues.join(" ")).toContain("matching Reviewer PASS evidence");
    snapshot.targetPlan!.targets[1].description = "Tampered after approval";
    expect(validatePersistedFactoryRunState(snapshot, m.fixture.dir).issues.join(" ")).toContain("does not match the initial Architect-approved plan");
    (snapshot.targetPlan!.targets as unknown[])[0] = null;
    expect(() => validatePersistedFactoryRunState(snapshot, m.fixture.dir)).not.toThrow();
    expect(validatePersistedFactoryRunState(snapshot, m.fixture.dir).ok).toBe(false);
    m.controller.dispose();
    writeFileSync(m.fixture.store.pathFor(m.controller.getRunId()), JSON.stringify(snapshot));
    expect(m.fixture.store.load(m.controller.getRunId())).toBeUndefined();
    expect(FactoryController.restore(m.deps, m.controller.getRunId())).toBeUndefined();
  });

  it("rejects cycles, missing dependencies and duplicate identities", () => {
    expect(validateTargets([target("A", ["B"]), target("B", ["A"])]).join(" ")).toContain("cycle");
    expect(validateTargets([target("A", ["missing"])]).join(" ")).toContain("missing");
    expect(validateTargets([target("A"), target("A")]).join(" ")).toContain("duplicate");
  });

  it("does not execute a multi-target proposal without explicit Architect plan approval", async () => {
    const m = make([]);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket({ ...packets.proposal, workPackages: ["WP0", "WP1"] });
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("complete approvedTargets plan");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("rejects a structurally incomplete coverage mapping", async () => {
    const targets = [target("WP0"), target("WP1", ["WP0"])];
    const proposal = proposalFor(targets);
    const packet = architectApproval(proposal, targets);
    packet.planAssessment.requirementCoverage.pop();
    const m = make(targets);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket(packet);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("no target coverage");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("stops when Architect coverage identifies a missing human requirement", async () => {
    const targets = [target("WP0"), target("WP1", ["WP0"])];
    const proposal = proposalFor(targets, { humanRequirements: ["Keep existing file formats readable"] });
    const assessment = architectApproval(proposal, targets).planAssessment;
    assessment.verdict = "incomplete";
    assessment.uncoveredRequirements.push("Export projects in the requested format");
    const m = make(targets);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket({ ...architectApproval(proposal, targets), planAssessment: assessment });
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("uncovered requirements");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("refines T1-T3 without changing stable identities or losing requirement coverage", async () => {
    const proposed = [
      { ...target("T1"), description: "Slug utility", acceptanceCriteria: ["Original slug behavior"] },
      { ...target("T2"), description: "Readings parser", acceptanceCriteria: ["Original parser behavior"] },
      { ...target("T3", ["T2"]), description: "CLI report", acceptanceCriteria: ["Original report behavior"] },
    ];
    const approved = [
      { ...target("T1"), description: "Implement and validate slug normalization", acceptanceCriteria: ["Normalize requested labels", "Test edge cases"] },
      { ...target("T2"), description: "Implement and validate the readings decoder", acceptanceCriteria: ["Decode each source row", "Reject invalid row shapes"] },
      { ...target("T3", ["T2"]), description: "Deliver the deterministic report", acceptanceCriteria: ["Aggregate the parser records", "Verify sample totals"] },
    ];
    const m = make(proposed);
    const proposal = proposalFor(proposed);
    const architect = architectApproval(proposal, approved);
    architect.planAssessment.missionRequirements = ["The source data can be decoded safely", "The downstream report uses valid parsed records"];
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket(architect);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().targetPlan?.targets).toEqual(approved);
    expect(architect.planAssessment.requirementCoverage.map((item) => item.requirementId)).toEqual(proposal.requirementCatalog.map((item) => item.id));
    expect(architect.planAssessment.preservedConstraintIds).toEqual(proposal.requirementCatalog.filter((item) => item.source === "human_constraint").map((item) => item.id));
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "initial.architect")).toHaveLength(1);
  });

  it("rejects an unauthorized T4 implementation target before Engineer dispatch", async () => {
    const proposed = [target("T1"), target("T2"), target("T3", ["T2"])];
    const unauthorized = [...proposed, target("T4", ["T1", "T2", "T3"])];
    const proposal = proposalFor(proposed);
    const architect = architectApproval(proposal, unauthorized);
    const m = make(proposed);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket(architect);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("added unproposed implementation target T4");
    expect(m.controller.getState().stoppedReason).toContain("request an owner-authorized revised plan");
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "initial.architect")).toHaveLength(1);
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("fails closed with actionable CLARIFY when an implementation deliverable needs a new target", async () => {
    const proposed = [target("T1"), target("T2"), target("T3", ["T2"])];
    const requirement = "Add a new export format that no proposed implementation target owns";
    const proposal = proposalFor(proposed, { humanRequirements: [requirement] });
    const missingId = proposal.requirementCatalog.find((item) => item.text === requirement)!.id;
    const architect = {
      ...architectApproval(proposal, proposed),
      verdict: "CLARIFY" as const,
      clarificationQuestions: [`${missingId}: ${requirement}; T1-T3 cannot own this deliverable. Request an owner-authorized revised Lead plan.`],
    };
    const m = make(proposed);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket(architect);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain(`${missingId}: ${requirement}`);
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "initial.architect")).toHaveLength(1);
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("accepts an Architect correction to an inferred, non-human dependency", async () => {
    const proposed = [target("WP0"), target("WP1"), target("WP2", ["WP0"])];
    const corrected = [target("WP0"), target("WP1"), target("WP2", ["WP1"])];
    const m = make(proposed);
    await approveWithPlan(m, proposed, corrected);
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().targetPlan?.targets).toEqual(corrected);
  });

  it("preserves every explicit Lead constraint in Architect approval", async () => {
    const proposed = [target("WP0"), target("WP1", ["WP0"])];
    const proposal = proposalFor(proposed, { constraints: [...packets.proposal.constraints, "Plain JavaScript only"] });
    const architect = architectApproval(proposal, proposed);
    architect.constraints = architect.constraints.filter((constraint) => constraint !== "Plain JavaScript only");
    const constraintId = proposal.requirementCatalog.find((requirement) => requirement.text === "Plain JavaScript only")!.id;
    architect.planAssessment.preservedConstraintIds = architect.planAssessment.preservedConstraintIds?.filter((id) => id !== constraintId) ?? [];
    const m = make(proposed);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(proposal);
    await flush();
    m.transport.completeLastPacket(architect);
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("Architect omitted explicit human constraint identity");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("rejects unknown or duplicate Architect requirement identities", async () => {
    const targets = [target("WP0"), target("WP1", ["WP0"])];
    for (const mutation of ["unknown", "duplicate"] as const) {
      const proposal = proposalFor(targets);
      const architect = architectApproval(proposal, targets);
      if (mutation === "unknown") architect.planAssessment.requirementCoverage[0] = { requirementId: "REQ-999", targetIds: ["WP0"] };
      else architect.planAssessment.requirementCoverage.push({ requirementId: architect.planAssessment.requirementCoverage[0].requirementId, targetIds: ["WP1"] });
      const m = make(targets);
      m.controller.start();
      await flush();
      m.transport.completeLastPacket(proposal);
      await flush();
      m.transport.completeLastPacket(architect);
      await flush();
      expect(m.controller.getState().state).toBe("STOPPED");
      expect(m.controller.getState().stoppedReason).toContain(mutation === "unknown" ? "unknown requirement identity" : "mapped requirement identity more than once");
      expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
    }
  });

  it("replays the sanitized live drill packets through identity-aware validation", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/factory-next-requirement-coverage-drill.json", import.meta.url), "utf8")) as {
      proposal: LeadProposalPacket;
      architect: ArchitectInitialResult;
    };
    const historicalAssessment = fixture.architect.planAssessment!;
    const catalog = createRequirementCatalog(fixture.proposal.humanRequirements ?? [], fixture.proposal.constraints);
    const replayProposal = { ...fixture.proposal, requirementCatalog: catalog };
    const replayAssessment = {
      ...historicalAssessment,
      preservedConstraintIds: catalog.filter((requirement) => requirement.source === "human_constraint").map((requirement) => requirement.id),
      requirementCoverage: catalog.map((requirement) => {
        const text = requirement.text.toLowerCase();
        const targetIds = text.includes("slug") ? ["slug-utility"]
          : /parser|readings\.csv|blank lines|malformed/.test(text) ? ["readings-parser"]
            : /report|total|watts|cli|sample data/.test(text) ? ["cli-report"]
              : fixture.architect.approvedTargets!.map((target) => target.id);
        return { requirementId: requirement.id, targetIds };
      }),
    };
    const rawIssues = validateArchitectTargetApproval(
      fixture.proposal,
      fixture.architect.approvedTargets!,
      historicalAssessment,
      fixture.architect.constraints,
    );
    expect(rawIssues.some((issue) => issue.includes("removed a proposed criterion"))).toBe(true);
    expect(rawIssues.some((issue) => issue.includes("omitted a Lead/user requirement"))).toBe(true);
    expect(validateArchitectTargetApproval(replayProposal, fixture.architect.approvedTargets!, replayAssessment, fixture.architect.constraints)).toEqual([]);
  });

  it("rejects an Architect correction that changes stable target identities", async () => {
    const proposed = [target("WP0"), target("WP1", ["WP0"])];
    const renamed = [target("WP0"), target("WPX", ["WP0"])];
    const m = make(proposed);
    await approveWithPlan(m, proposed, renamed);
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("added unproposed implementation target WPX");
    expect(m.controller.getState().stoppedReason).toContain("omitted proposed implementation target WP1");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("does not let Architect correction remove an explicit human dependency", async () => {
    const proposed = [target("WP0"), target("WP1", ["WP0"])];
    const corrected = [target("WP0"), target("WP1")];
    const m = make(proposed);
    await approveWithPlan(m, proposed, corrected, { humanDependencies: [{ targetId: "WP1", dependsOn: "WP0" }] });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("does not preserve identified human dependency");
    expect(m.transport.spawned.some((spawn) => spawn.phase === "execution.engineer")).toBe(false);
  });

  it("uses the economical single-target path for a descriptive legacy work package", async () => {
    const m = make([]);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket({ ...packets.proposal, workPackages: ["Add a portable widget implementation"] });
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("execution.engineer");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Work package: WP0");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Add a portable widget implementation");
    expect(m.transport.spawned.filter((spawn) => spawn.phase === "initial.architect")).toHaveLength(1);
  });

  it("rejects a structurally invalid Architect-approved graph before implementation", async () => {
    const proposed = [target("A"), target("B")];
    const approved = [target("A", ["B"]), target("B", ["A"])];
    const m = make(proposed);
    await approveWithPlan(m, proposed, approved);
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(0);
    expect(m.controller.getState().stoppedReason).toContain("dependency cycle");
  });
});
