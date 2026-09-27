import { describe, expect, it } from "vitest";
import { formatFactoryReport } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { createRequirementCatalog } from "../../src/ai-factory/targets.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const targets = [
  { id: "wp-1", description: "foundation", dependsOn: [], acceptanceCriteria: ["works"] },
  { id: "wp-2", description: "integration", dependsOn: ["wp-1"], acceptanceCriteria: ["works"] },
];
const contract = {
  goal: "Implement the widget", repositoryFindings: "repo inspected", currentArchitecture: "one module",
  assumptions: [], proposedSolution: "widget", constraints: [], humanRequirements: ["Implement the widget"], missionRequirements: [], workPackages: ["wp-1", "wp-2"],
  dependencies: "wp-2 depends on wp-1", risks: [], acceptanceCriteria: ["works"], architecturalQuestions: [],
  targets, verification: {
    "wp-1": { evidence: "foundation check", command: "true" },
    "wp-2": { evidence: "integration check", command: "true" },
  },
};
// Sanitized subset of the returned human requirements and constraints from
// factory_mui7s4g0_PF8H7Z. The corrected contract omits model-authored IDs so
// Factory can assign the existing deterministic REQ-NNN inventory.
const liveReplayContract = {
  ...contract,
  humanRequirements: [
    "Implement a reusable CSV parser that returns structured records in source order.",
    "For the supplied sample, totals must be apple: 7, banana: 2, overall: 9.",
    "Provide an independent reusable text utility that converts labels into normalized inventory IDs.",
  ],
  constraints: [
    "Work only inside the current disposable project directory.",
    "Do not install packages.",
  ],
};
const liveAcceptanceContract = {
  ...contract,
  goal: "Build the inventory utility",
  proposedSolution: "Three reusable dependency-free modules",
  humanRequirements: ["Implement a reusable CSV parser", "Aggregate inventory using the parser", "Add an independent slug utility"],
  constraints: ["Use plain JavaScript and Node built-ins only"],
  missionRequirements: [
    "Include the Integrated Reviewer verdict in the final report.",
    "Report incomplete or owner-pending verification, if any.",
    "Stop after validation and final reporting.",
  ],
  workPackages: ["CSV parser", "Inventory aggregation", "Slug utility"],
  targets: [
    { id: "CSV_PARSER", description: "Implement parser", dependsOn: [], acceptanceCriteria: ["Parses required input"] },
    { id: "INVENTORY", description: "Aggregate quantities", dependsOn: ["CSV_PARSER"], acceptanceCriteria: ["Uses parser"] },
    { id: "SLUG", description: "Normalize labels", dependsOn: [], acceptanceCriteria: ["Produces stable IDs"] },
  ],
  humanDependencies: [],
  dependencies: "Inventory uses the CSV parser; slug utility is independent.",
  verification: {
    CSV_PARSER: { command: "node --test test/csv.test.js", evidence: "Parser tests pass" },
    INVENTORY: { command: "node --test test/inventory.test.js", evidence: "Aggregation tests pass" },
    SLUG: { command: "node --test test/slug.test.js", evidence: "Slug tests pass" },
  },
};
const engineer = (id: string) => ({ ...packets.engineer, workPackageId: id });
const integratedPass = { verdict: "PASS", affectedTargetIds: [], blockingFindings: [], nonBlockingFindings: [], requiredRepairs: [], testConcerns: [], architecturalIssue: false };
const integratedRepairT2 = { verdict: "REPAIR_REQUIRED", affectedTargetIds: ["wp-2"], blockingFindings: ["wp-2 is incomplete"], nonBlockingFindings: [], requiredRepairs: ["repair wp-2"], testConcerns: [], architecturalIssue: false };
const conformanceAccept = { verdict: "ACCEPT", blockingIssues: [], requiredChanges: [], doNotChange: [], requiredEvidence: [] };
const conformanceRejectT2 = { verdict: "NEEDS_REMEDIATION", affectedTargetIds: ["wp-2"], integrationOnly: false, blockingIssues: ["wp-2 needs repair"], requiredChanges: ["repair wp-2"], doNotChange: [], requiredEvidence: [] };

function make(mode: "lean" | "verified_execution", verificationStatus: "passed" | "failed" | "owner_pending" | "unavailable" = "passed") {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  const verified: string[] = [];
  const controller = FactoryController.create({
    transport, clock, store: store.store, config: defaultFactoryConfig(),
    verifyTarget: async (_cwd, id) => { verified.push(id); return { status: verificationStatus, evidence: `verified ${id}`, command: "true" }; },
  }, `execution-${mode}`, "Implement the widget", store.dir, mode);
  return { transport, controller, store, verified };
}

async function start(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
}
async function complete(m: ReturnType<typeof make>, packet: unknown): Promise<void> {
  m.transport.completeLastPacket(packet);
  await flush();
  await flush();
}
function phases(m: ReturnType<typeof make>): string[] { return m.transport.spawned.map((item) => item.phase); }

async function completeTwoTargets(m: ReturnType<typeof make>): Promise<void> {
  await complete(m, contract);
  await complete(m, engineer("wp-1"));
  await complete(m, engineer("wp-2"));
}

describe("execution workflows", () => {
  it.each(["lean", "verified_execution"] as const)("accepts live-drill lifecycle metadata without targets or owner dependencies in %s", async (mode) => {
    const m = make(mode);
    await start(m);
    await complete(m, liveAcceptanceContract);
    const state = m.controller.getState();
    expect(state.state).toBe("EXECUTION");
    expect(state.targetPlan?.targets.map((target) => target.id)).toEqual(["CSV_PARSER", "INVENTORY", "SLUG"]);
    expect(state.targetPlan?.targets.find((target) => target.id === "INVENTORY")?.dependsOn).toEqual(["CSV_PARSER"]);
    expect(state.targetPlan?.targets.some((target) => target.id === "FINAL_REPORT")).toBe(false);
    expect(state.results.executionProposal?.packet.humanDependencies).toEqual([]);
    expect(state.results.executionProposal?.packet.missionRequirements).toEqual(liveAcceptanceContract.missionRequirements);
    expect(Object.keys(state.results.executionProposal?.packet.verification ?? {})).toEqual(["CSV_PARSER", "INVENTORY", "SLUG"]);
    expect(Object.values(state.results.executionProposal?.packet.verification ?? {}).some((item) => item.ownerPending === true)).toBe(false);
    expect(phases(m)).not.toContain("initial.architect");
    m.store.cleanup();
  });
  it.each(["lean", "verified_execution"] as const)("accepts a sanitized live-run proposal under %s with Factory-assigned identities", async (mode) => {
    const m = make(mode);
    await start(m);
    await complete(m, liveReplayContract);
    const state = m.controller.getState();
    expect(state.results.executionProposal?.packet.requirementCatalog).toEqual(createRequirementCatalog(liveReplayContract.humanRequirements, liveReplayContract.constraints));
    expect(state.results.executionProposal?.packet.requirementCatalog?.map((item) => item.id)).toEqual(["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005"]);
    expect(m.store.store.load(`execution-${mode}`)?.results.executionProposal?.packet.requirementCatalog).toEqual(createRequirementCatalog(liveReplayContract.humanRequirements, liveReplayContract.constraints));
    expect(state.attempts?.find((attempt) => attempt.phase === "execution.proposal")).toMatchObject({ provenance: "settled_validated_packet", packetValidated: true });
    expect(phases(m)).toContain("execution.engineer");
    expect(phases(m)).not.toContain("initial.architect");
    m.store.cleanup();
  });

  it("reaches DONE after reporting instructions say stop after final reporting", async () => {
    const m = make("lean");
    await start(m);
    await complete(m, liveAcceptanceContract);
    await complete(m, engineer("CSV_PARSER"));
    await complete(m, engineer("INVENTORY"));
    await complete(m, engineer("SLUG"));
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    const finalPrompt = m.transport.spawned.at(-1)?.prompt ?? "";
    expect(finalPrompt).toContain("conditional request to report incomplete/manual/owner-pending verification \"if any\" means report only actual recorded evidence");
    expect(finalPrompt).toContain("The Integrated Reviewer verdict is an LLM workflow result, never owner/manual verification");
    expect(finalPrompt).toContain("Controller-owned warning evidence");
    expect(finalPrompt).toContain("never copy them into mission-level warnings");
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("keeps an invalid model-authored catalog unpersisted with uncertain safe provenance", async () => {
    const m = make("lean");
    await start(m);
    await complete(m, {
      ...liveReplayContract,
      requirementCatalog: [
        { id: "REQ-001", text: "Parser requirement", source: "human_requirement" },
        { id: "REQ-002", text: "Sample totals", source: "human_requirement" },
        { id: "REQ-003", text: "Text utility", source: "human_requirement" },
        { id: "CON-001", text: "Work only in this project", source: "human_constraint" },
        { id: "CON-002", text: "Do not install packages", source: "human_constraint" },
      ],
    });
    const state = m.controller.getState();
    expect(state.results.executionProposal).toBeUndefined();
    expect(state.state).toBe("DISCOVERY");
    expect(state.attempts?.at(-1)).toMatchObject({ provenance: "settled_without_valid_packet", recoveryRisk: "uncertain_outcome", packetValidated: false });
    expect(m.store.store.load("execution-lean")?.results.executionProposal).toBeUndefined();
    m.controller.dispose();
    m.store.cleanup();
  });
  it("does not advance a dependent target after failed or unavailable deterministic verification", async () => {
    for (const status of ["failed", "unavailable"] as const) {
      const m = make("lean", status);
      await start(m);
      await complete(m, contract);
      await complete(m, engineer("wp-1"));
      expect(m.controller.getState().state).toBe("STOPPED");
      expect(phases(m).filter((phase) => phase === "execution.engineer")).toHaveLength(1);
      expect(phases(m)).not.toContain("integrated.review");
      m.store.cleanup();
    }
  });

  it("keeps post-implementation owner acceptance separate from machine verification through final acceptance", async () => {
    const m = make("verified_execution");
    const ownerCheck = "Owner runs the human iPad Safari acceptance checklist after technical delivery.";
    const targetContract = {
      ...contract,
      workPackages: ["PWA20-T6"],
      targets: [{ id: "PWA20-T6", description: "Live delivery and owner checklist", dependsOn: [], acceptanceCriteria: ["Complete live delivery evidence"] }],
      verification: {
        "PWA20-T6": { command: "true", evidence: "Live E2E delivery verification", ownerPending: true, ownerAcceptance: ownerCheck },
      },
      humanDependencies: [],
    };
    await start(m);
    await complete(m, targetContract);
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().results.executionProposal?.packet.humanDependencies).toEqual([]);
    expect(m.controller.getState().results.executionProposal?.packet.blockingHumanDependencies).toBeUndefined();
    await complete(m, engineer("PWA20-T6"));
    expect(m.controller.getState().targetPlan?.outcomes["PWA20-T6"].verification?.status).toBe("passed");
    expect(phases(m).at(-1)).toBe("integrated.review");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("not a Factory gate");
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    expect(m.transport.spawned.at(-1)?.prompt).toContain("do not reject an otherwise conforming implementation");
    await complete(m, conformanceAccept);
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    const report = formatFactoryReport(m.controller.getState());
    expect(report).toContain("Technical Factory acceptance");
    expect(report).toContain("ACCEPTED; the listed owner/manual acceptance remains pending");
    expect(report).toContain(`PWA20-T6: ${ownerCheck}`);
    expect(report).not.toContain("Owner acceptance: passed");
    m.store.cleanup();
  });

  it("preserves genuine blocking human prerequisites", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, { ...contract, blockingHumanDependencies: { "wp-1": "Owner must provide the required hardware before implementation." } });
    const state = m.controller.getState();
    expect(state.state).toBe("STOPPED");
    expect(state.stoppedReason).toContain("Owner must provide the required hardware");
    expect(phases(m)).not.toContain("execution.engineer");
    const report = formatFactoryReport(state);
    expect(report).toContain("Execution did not begin.");
    expect(report).toContain("Blocking human dependencies");
    expect(report).toContain("wp-1: Owner must provide the required hardware");
    m.store.cleanup();
  });

  it("reports invalid pre-Engineer proposals as planned, not completed, evidence", async () => {
    const m = make("verified_execution");
    const ownerCheck = "Owner runs the human iPad Safari acceptance checklist after technical delivery.";
    await start(m);
    await complete(m, {
      ...contract,
      workPackages: ["PWA20-T6"],
      targets: [{ id: "PWA20-T6", description: "Live delivery and owner checklist", dependsOn: [], acceptanceCriteria: ["Complete live delivery evidence"] }],
      humanDependencies: [{ targetId: "PWA20-T6", dependsOn: ownerCheck }],
      verification: { "PWA20-T6": { command: "node verify-live.mjs", evidence: "Live E2E verification and human iPad checklist", ownerPending: true } },
    });
    const state = m.controller.getState();
    expect(state.state).toBe("STOPPED");
    expect(state.stoppedReason).toContain("Execution contract omitted user dependency");
    expect(phases(m)).not.toContain("execution.engineer");
    const report = formatFactoryReport(state);
    expect(report).toContain("Stop phase: execution.proposal");
    expect(report).toContain("Proposal status: produced, rejected by contract validation");
    expect(report).toContain("Engineer executions: 0");
    expect(report).toContain("Reviewer executions: 0");
    expect(report).toContain("Implementation evidence: none");
    expect(report).toContain("Planned targets (not executed)");
    expect(report).toContain("Planned verification (not run)");
    expect(report).toContain('PWA20-T6: planned command "node verify-live.mjs"');
    expect(report).toContain("Planned owner-pending acceptance (not performed)");
    expect(report).not.toContain("Target evidence");
    expect(report).not.toContain("Owner-pending acceptance\n");
    m.store.cleanup();
  });

  it("records legacy owner-only verification as pending rather than fabricating acceptance", async () => {
    const m = make("lean", "owner_pending");
    await start(m);
    await complete(m, { ...contract, verification: {
      "wp-1": { evidence: "manual owner check", ownerPending: true },
      "wp-2": { evidence: "manual owner check", ownerPending: true },
    } });
    await complete(m, engineer("wp-1"));
    expect(m.controller.getState().targetPlan?.outcomes["wp-1"].verification?.status).toBe("owner_pending");
    expect(m.controller.getState().targetPlan?.outcomes["wp-1"].status).not.toBe("passed");
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(phases(m)).not.toContain("integrated.review");
    m.store.cleanup();
  });

  it("stops instead of silently invoking an Architect when Engineer flags structural escalation", async () => {
    const m = make("lean");
    await start(m);
    await complete(m, contract);
    await complete(m, { ...engineer("wp-1"), architecturalEscalationRequired: true });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("owner decision");
    expect(phases(m)).not.toContain("escalation.architect");
    m.store.cleanup();
  });

  it("rejects a partial-scope integrated PASS rather than approving every target", async () => {
    const m = make("lean");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, { ...integratedPass, affectedTargetIds: ["wp-1"] });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(phases(m)).not.toContain("integration.lead");
    m.store.cleanup();
  });

  it("does not accept an integration packet with unresolved Reviewer findings", async () => {
    const m = make("lean");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedPass);
    await complete(m, { ...packets.integration, reviewerFindingsUnresolved: ["unresolved contract violation"] });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(phases(m)).not.toContain("final_synthesis.lead");
    m.store.cleanup();
  });

  it("stops an incomplete Engineer before target verification or the dependent target", async () => {
    const m = make("lean");
    await start(m);
    await complete(m, contract);
    await complete(m, { ...engineer("wp-1"), status: "partially_completed" });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.verified).toEqual([]);
    expect(phases(m).filter((phase) => phase === "execution.engineer")).toHaveLength(1);
    m.store.cleanup();
  });
  it("completes LEAN without an invented Architect gate and verifies both dependent targets", async () => {
    const m = make("lean");
    await start(m);
    await completeTwoTargets(m);
    expect(m.verified).toEqual(["wp-1", "wp-2"]);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    expect(phases(m)).not.toContain("conformance.architect");
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    expect(phases(m)).not.toContain("initial.architect");
    expect(phases(m)).not.toContain("review.reviewer");
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("repairs only T2, then globally re-reviews the final two-target state", async () => {
    const m = make("verified_execution");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedRepairT2);
    expect(phases(m).filter((phase) => phase === "execution.engineer")).toHaveLength(3);
    await complete(m, engineer("wp-2"));
    expect(m.verified).toEqual(["wp-1", "wp-2", "wp-2"]);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    await complete(m, conformanceAccept);
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    expect(phases(m).filter((phase) => phase === "conformance.architect")).toHaveLength(1);
    expect(phases(m)).not.toContain("initial.architect");
    expect(phases(m)).not.toContain("review.reviewer");
    expect(m.controller.getState().targetPlan?.outcomes["wp-1"].reviewerAgentId).toBeDefined();
    expect(m.controller.getState().targetPlan?.outcomes["wp-2"].reviewerAgentId).toBeDefined();
    m.store.cleanup();
  });

  it("repairs every affected target in dependency order before one global re-review", async () => {
    const m = make("lean");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, { ...integratedRepairT2, affectedTargetIds: ["wp-1", "wp-2"] });
    expect(phases(m).at(-1)).toBe("execution.engineer");
    await complete(m, engineer("wp-1"));
    expect(phases(m).at(-1)).toBe("execution.engineer");
    await complete(m, engineer("wp-2"));
    expect(m.verified).toEqual(["wp-1", "wp-2", "wp-1", "wp-2"]);
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(2);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    m.store.cleanup();
  });

  it("runs scoped remediation, verifies it, globally re-reviews, and stops on rejected recheck", async () => {
    const m = make("verified_execution");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    await complete(m, conformanceRejectT2);
    await complete(m, engineer("wp-2"));
    expect(m.verified).toEqual(["wp-1", "wp-2", "wp-2"]);
    await complete(m, integratedPass);
    await complete(m, { ...conformanceRejectT2, blockingIssues: ["still broken"] });
    expect(m.controller.getState().state).toBe("STOPPED");
    m.store.cleanup();
  });

  it("stops on a final conformance architecture contradiction without redesign", async () => {
    const m = make("verified_execution");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    const contradiction = { assumption: "required architecture exists", repositoryEvidence: "incompatible repository invariant", affectedTargetIds: ["wp-2"], cannotContinueBecause: "unsafe", ownerDecisionNeeded: "choose interface" };
    await complete(m, { ...conformanceRejectT2, verdict: "ARCHITECTURE_CONTRADICTION", architectureContradiction: contradiction });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().architectureContradiction).toEqual(contradiction);
    expect(phases(m)).not.toContain("remediation.engineer");
    m.store.cleanup();
  });

  it("rechecks an integration-only remediation without replaying completed targets", async () => {
    const m = make("verified_execution");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    await complete(m, { ...conformanceRejectT2, affectedTargetIds: [], integrationOnly: true });
    expect(phases(m).at(-1)).toBe("remediation.engineer");
    await complete(m, engineer("integration"));
    expect(phases(m).at(-1)).toBe("integrated.review");
    await complete(m, integratedPass);
    expect(phases(m).at(-1)).toBe("conformance.recheck");
    await complete(m, conformanceAccept);
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    expect(phases(m).filter((phase) => phase === "execution.engineer")).toHaveLength(2);
    m.store.cleanup();
  });

  it("restores the persisted execution workflow without replaying completed targets", async () => {
    const m = make("lean");
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    expect(m.controller.getState().targetPlan?.outcomes["wp-1"].status).toBe("passed");
    m.controller.dispose();
    const transport = new FakeTransport();
    const resumed = FactoryController.restore({
      transport, clock: new FakeClock(), store: m.store.store, config: defaultFactoryConfig(),
      verifyTarget: async () => ({ status: "passed", evidence: "restored check" }),
    }, m.controller.getRunId());
    expect(resumed?.getState().workflow?.mode).toBe("lean");
    await flush();
    expect(transport.spawned).toHaveLength(0);
    expect(resumed?.getRecoveryEligibility().requiresApproval).toBe(true);
    const checkpoint = resumed!.getRecoveryEligibility().checkpointId;
    expect(resumed!.resumeWithApproval(checkpoint).kind).toBe("ok");
    await flush();
    expect(transport.spawned.filter((item) => item.phase === "execution.engineer")).toHaveLength(1);
    expect(transport.spawned[0].prompt).toContain("wp-2");
    resumed?.dispose();
    m.store.cleanup();
  });

  it("stops immediately on an integrated architecture contradiction", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, { ...contract, architectureContradiction: { assumption: "required architecture", repositoryEvidence: "contradictory repository evidence", affectedTargetIds: ["wp-1"], cannotContinueBecause: "unsafe", ownerDecisionNeeded: "choose" } });
    expect(m.controller.getState().state).toBe("STOPPED");
    m.store.cleanup();
  });
});
