import { describe, expect, it } from "vitest";
import { formatFactoryReport, formatResumePreview } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { createFactoryCheckpoint, planFactoryRecovery } from "../../src/ai-factory/recovery-model.js";
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

function make(mode: "lean" | "verified_execution", verificationStatus: "passed" | "failed" | "owner_pending" | "unavailable" | ((id: string) => "passed" | "failed" | "owner_pending" | "unavailable") = "passed") {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  const verified: string[] = [];
  const controller = FactoryController.create({
    transport, clock, store: store.store, config: defaultFactoryConfig(),
    verifyTarget: async (_cwd, id) => { verified.push(id); return { status: typeof verificationStatus === "function" ? verificationStatus(id) : verificationStatus, evidence: `verified ${id}`, command: "true" }; },
  }, `execution-${mode}`, "Implement the widget", store.dir, mode);
  return { transport, controller, store, verified, clock };
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

async function reachIntegratedReview(m: ReturnType<typeof make>, packet: unknown = integratedPass): Promise<void> {
  await start(m);
  await completeTwoTargets(m);
  await complete(m, packet);
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

  it("normalizes the reproduced VERIFIED EXECUTION per-target Architect gate and continues", async () => {
    const m = make("verified_execution");
    const ids = ["T1-TAB-FOCUS-ROUTING", "T2-ANCHORED-VIRTUAL-PAGING", "T3-REGRESSION-EXPECTATION-UPDATE"];
    const gatedTargets = ids.map((id, index) => ({
      id,
      description: `${id} implementation`,
      dependsOn: [],
      acceptanceCriteria: [`${id} works`],
      requiresArchitectAcceptance: index < 2,
    }));
    try {
      await start(m);
      await complete(m, {
        ...contract,
        workPackages: ids,
        targets: gatedTargets,
        verification: Object.fromEntries(ids.map((id) => [id, { command: "true", evidence: `${id} passes` }])),
      });
      const accepted = m.controller.getState();
      expect(accepted.results.executionProposal?.packet.targets?.every((target) => target.requiresArchitectAcceptance !== true)).toBe(true);
      expect(accepted.targetPlan?.targets.every((target) => target.requiresArchitectAcceptance !== true)).toBe(true);
      await complete(m, engineer(ids[0]));
      const saved = m.store.store.load("execution-verified_execution");
      expect(saved?.targetPlan?.outcomes[ids[0]]).toMatchObject({ status: "passed", verification: { status: "passed" } });
      expect(saved?.targetPlan?.currentTargetId).toBe(ids[1]);
      expect(phases(m)).toContain("execution.engineer");
      expect(phases(m)).not.toContain("escalation.architect");
    } finally {
      m.store.cleanup();
    }
  });

  it("stops clearly when an Engineer reports a genuine architecture escalation in VERIFIED EXECUTION", async () => {
    const m = make("verified_execution");
    try {
      await start(m);
      await complete(m, { ...contract, targets: [{ ...contract.targets[0], id: "T1" }], workPackages: ["T1"], verification: { T1: { command: "true", evidence: "T1 check" } } });
      await complete(m, { ...engineer("T1"), architecturalEscalationRequired: true });
      expect(m.controller.getState().state).toBe("STOPPED");
      expect(m.controller.getState().stoppedReason).toContain("VERIFIED EXECUTION has no per-target Architect gate");
      expect(m.verified).toEqual([]);
      expect(phases(m)).not.toContain("escalation.architect");
    } finally {
      m.store.cleanup();
    }
  });

  it("reproduces and rejects the legacy pseudo-target live-preview verification entry", async () => {
    const m = make("verified_execution");
    const targets = ["T1", "T2", "T3"].map((id) => ({ id, description: `${id} implementation`, dependsOn: [], acceptanceCriteria: [`${id} works`] }));
    await start(m);
    await complete(m, {
      ...contract,
      workPackages: targets.map((target) => target.id),
      targets,
      verification: {
        T1: { command: "npm test -- T1", evidence: "T1 focused test passes" },
        T2: { command: "npm test -- T2", evidence: "T2 paging tests pass" },
        T3: { command: "npm test -- T3", evidence: "T3 regression suite passes" },
        "live-preview": { command: "node verify-live-preview.mjs", evidence: "HTTP 200, workspace SHA matches, tailnet-only exposure" },
      },
    });
    const state = m.controller.getState();
    expect(state.state).toBe("STOPPED");
    expect(state.stoppedReason).toContain("Execution contract must define verification for every target");
    expect(state.stoppedReason).toContain("Execution contract contains verification for an unknown target");
    expect(phases(m)).not.toContain("execution.engineer");
    expect(state.results.engineers).toHaveLength(0);
    expect(state.results.reviewers).toHaveLength(0);
    const report = formatFactoryReport(state);
    expect(report).toContain("Unclassified verification entries (rejected; not run)");
    expect(report).toContain("live-preview:");
    expect(report).not.toContain("Target evidence");
    m.store.cleanup();
  });

  it("executes multiple explicit run-level checks separately and completes VERIFIED EXECUTION", async () => {
    const m = make("verified_execution");
    const runVerification = [
      { name: "Live preview", command: "node verify-live-preview.mjs", evidence: "HTTP 200, workspace SHA matches, tailnet-only exposure" },
      { name: "Whole-run regression", command: "npm test -- regression", evidence: "Integrated regression matrix passes" },
      { name: "Artifact identity", command: "shasum -a 256 dist/app.js", evidence: "Artifact hash matches expected identity" },
      { name: "Deployment exposure", command: "node verify-exposure.mjs", evidence: "Service remains tailnet-only" },
    ];
    const targets = ["T1", "T2", "T3"].map((id) => ({ id, description: `${id} implementation`, dependsOn: [], acceptanceCriteria: [`${id} works`], requiresArchitectAcceptance: true }));
    const targetVerification = {
      T1: { command: "npm test -- T1", evidence: "T1 focused test passes" },
      T2: { command: "npm test -- T2", evidence: "T2 paging tests pass" },
      T3: { command: "npm test -- T3", evidence: "T3 regression suite passes", ownerAcceptance: "Owner verifies the real iPad workflow after technical acceptance" },
    };
    await start(m);
    await complete(m, { ...contract, workPackages: targets.map((target) => target.id), targets, verification: targetVerification, runVerification });
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().results.executionProposal?.packet.runVerification).toEqual(runVerification);
    expect(m.controller.getState().results.executionProposal?.packet.targets?.every((target) => target.requiresArchitectAcceptance !== true)).toBe(true);
    await complete(m, engineer("T1"));
    await complete(m, engineer("T2"));
    await complete(m, engineer("T3"));
    expect(m.verified).toEqual(["T1", "T2", "T3", "Live preview", "Whole-run regression", "Artifact identity", "Deployment exposure"]);
    expect(m.controller.getState().results.runVerification?.map((item) => item.status)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(phases(m).at(-1)).toBe("integrated.review");
    expect(phases(m)).not.toContain("escalation.architect");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Integrated/run-level verification output (never target outcomes)");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Live preview");
    await complete(m, integratedPass);
    await complete(m, packets.integration);
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Integrated/run-level verification evidence");
    await complete(m, conformanceAccept);
    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");
    expect(phases(m)).toContain("conformance.architect");
    expect(m.transport.spawned.at(-1)?.prompt).toContain("Integrated/run-level verification");
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    const report = formatFactoryReport(m.controller.getState());
    expect(report).toContain("Target evidence");
    expect(report).toContain("Integrated/run verification");
    expect(report).toContain("Live preview: passed");
    expect(report).toContain("Whole-run regression: passed");
    expect(report).toContain("Artifact identity: passed");
    expect(report).toContain("Deployment exposure: passed");
    expect(report).toContain("Owner-pending acceptance");
    expect(report).toContain("Owner verifies the real iPad workflow");
    m.store.cleanup();
  });

  it("retries an invalid integrated-review packet, then continues after a valid PASS", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    expect(phases(m).at(-1)).toBe("integrated.review");

    await complete(m, { verdict: "PASS" });
    expect(m.controller.getState().results.integratedReview).toBeUndefined();
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(1);
    expect(m.controller.getState().state).toBe("INTEGRATED_REVIEW");
    expect(m.clock.pendingTimerCount()).toBe(1);
    m.clock.advance(1_000);
    await flush();
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(2);
    expect(phases(m).at(-1)).toBe("integrated.review");
    expect(m.controller.getState().attempts?.at(-1)?.noPacketRetry).toBe(true);
    await complete(m, integratedPass);
    expect(phases(m).at(-1)).toBe("integration.lead");
    expect(m.controller.getState().state).not.toBe("STOPPED");
    m.store.cleanup();
  });

  it("keeps transient retries separate from the persisted no-packet retry", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    await complete(m, { verdict: "PASS" });
    m.clock.advance(1_000);
    await flush();
    expect(m.controller.getState().attempts?.at(-1)?.noPacketRetry).toBe(true);
    m.transport.failLast("timeout");
    await flush();
    m.clock.advance(1_000);
    await flush();
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(3);
    expect(m.controller.getState().attempts?.at(-1)?.noPacketRetry).toBeUndefined();
    await complete(m, integratedPass);
    expect(phases(m).at(-1)).toBe("integration.lead");
    m.store.cleanup();
  });

  it("fails after the integrated-review packet retry is exhausted without spawning an orphan", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    await complete(m, { verdict: "PASS" });
    expect(m.controller.getState().state).toBe("INTEGRATED_REVIEW");
    expect(m.clock.pendingTimerCount()).toBe(1);
    m.clock.advance(1_000);
    await flush();
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(2);
    await complete(m, null);
    expect(m.controller.getState().state).toBe("FAILED");
    expect(m.controller.getState().errors.at(-1)?.message).toContain("Integrated Reviewer did not produce a valid packet");
    expect(formatFactoryReport(m.controller.getState())).toContain("Failure class: reviewer packet/runtime validation");
    expect(phases(m).filter((phase) => phase === "integrated.review")).toHaveLength(2);
    expect(m.transport.stopped).toEqual([]);
    m.store.cleanup();
  });

  it("recovers a settled invalid Integrated Reviewer checkpoint without replaying passed targets", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, { ...contract, runVerification: [{ name: "integration check", command: "true", evidence: "integration passes" }] });
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    await complete(m, { verdict: "PASS" });
    expect(m.controller.getState().state).toBe("INTEGRATED_REVIEW");
    expect(m.controller.getState().inFlight).toBeUndefined();
    expect(m.controller.getState().results.integratedReview).toBeUndefined();

    m.controller.dispose();
    const interrupted = m.store.store.load(m.controller.getState().runId);
    expect(interrupted).toBeDefined();
    if (!interrupted) throw new Error("Expected persisted interrupted run");
    interrupted.parked = false;
    interrupted.metrics.roles.reviewer.retries = 0;
    interrupted.metrics.totalRetries = 0;
    interrupted.stateRevision = (interrupted.stateRevision ?? 0) + 1;
    interrupted.checkpoint = createFactoryCheckpoint(interrupted, interrupted.stateRevision);
    m.store.store.save(interrupted);
    const recoveryPlan = planFactoryRecovery(interrupted);
    expect(recoveryPlan).toMatchObject({ decision: "automatic", phase: "integrated.review" });
    expect(formatResumePreview(interrupted, recoveryPlan)).toContain("next action: safe automatic continuation");

    const transport = new FakeTransport();
    const clock = new FakeClock();
    const restored = FactoryController.restore({
      transport, clock, store: m.store.store, config: defaultFactoryConfig(),
      verifyTarget: async (_cwd, id) => { m.verified.push(id); return { status: "passed", evidence: `verified ${id}`, command: "true" }; },
    }, interrupted.runId, { resume: false });
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Expected interrupted run to restore");
    expect(restored.getRecoveryEligibility()).toMatchObject({ eligible: true, requiresApproval: false });
    expect(restored.resume()).toMatchObject({ kind: "ok", state: "INTEGRATED_REVIEW" });
    await flush();
    expect(transport.spawned.map((item) => item.phase)).toEqual(["integrated.review"]);
    expect(restored.getState().attempts?.at(-1)?.noPacketRetry).toBe(true);
    expect(m.verified.filter((id) => id === "wp-1" || id === "wp-2")).toHaveLength(2);
    expect(m.verified.filter((id) => id === "integration check")).toHaveLength(1);
    transport.completeLastPacket(integratedPass);
    await flush();
    await flush();
    expect(restored.getState().state).toBe("INTEGRATION");
    expect(transport.spawned.map((item) => item.phase)).toEqual(["integrated.review", "integration.lead"]);
    restored.dispose();
    m.store.cleanup();
  });

  it("does not spend the packet retry budget when the retry fails to spawn", async () => {
    const m = make("verified_execution");
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    await complete(m, { verdict: "PASS" });
    m.clock.advance(1_000);
    await flush();
    expect(m.transport.spawned.filter((item) => item.phase === "integrated.review")).toHaveLength(2);
    expect(m.controller.getState().attempts?.at(-1)?.noPacketRetry).toBe(true);

    m.controller.dispose();
    const interrupted = m.store.store.load(m.controller.getState().runId);
    expect(interrupted).toBeDefined();
    if (!interrupted) throw new Error("Expected persisted reviewer retry");
    interrupted.inFlight = undefined;
    interrupted.parked = false;
    const retry = interrupted.attempts?.at(-1);
    expect(retry?.noPacketRetry).toBe(true);
    if (!retry) throw new Error("Expected retry attempt");
    retry.provenance = "settled_without_valid_packet";
    retry.recoveryRisk = "uncertain_outcome";
    retry.agentId = undefined;
    retry.packetValidated = undefined;
    retry.settledAt = m.clock.now();
    interrupted.stateRevision = (interrupted.stateRevision ?? 0) + 1;
    interrupted.checkpoint = createFactoryCheckpoint(interrupted, interrupted.stateRevision);
    m.store.store.save(interrupted);
    const recoveryPlan = planFactoryRecovery(interrupted);
    expect(recoveryPlan).toMatchObject({ decision: "automatic", phase: "integrated.review" });
    expect(recoveryPlan.terminal).toBeUndefined();
    expect(formatResumePreview(interrupted, recoveryPlan)).toContain("next action: safe automatic continuation");

    const transport = new FakeTransport();
    const restored = FactoryController.restore({
      transport, clock: new FakeClock(), store: m.store.store, config: defaultFactoryConfig(),
    }, interrupted.runId, { resume: false });
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Expected reviewer retry to restore");
    expect(restored.resume()).toMatchObject({ kind: "ok", state: "INTEGRATED_REVIEW" });
    expect(transport.spawned.map((item) => item.phase)).toEqual(["integrated.review"]);
    expect(restored.getState().attempts?.at(-1)?.noPacketRetry).toBeUndefined();
    restored.dispose();
    m.store.cleanup();
  });

  it("routes a VERIFIED PASS with only informational concerns to the Final Architect", async () => {
    const m = make("verified_execution");
    const testConcerns = [
      "Headless browser evidence is not real iPad Safari; physical-device acceptance remains owner-pending.",
      "The Final Architect gate has not run yet and is the next expected gate.",
    ];
    const contradiction = {
      assumption: "No authoritative assumption was disproved; no architecture contradiction applies.",
      repositoryEvidence: "All checks passed; continuation is not blocked.",
      affectedTargetIds: ["wp-1"],
      cannotContinueBecause: "Not applicable; continuation is not blocked.",
      ownerDecisionNeeded: "None.",
    };
    await start(m);
    await complete(m, contract);
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    await complete(m, { ...integratedPass, testConcerns, architectureContradiction: contradiction });
    expect(m.controller.getState().state).toBe("INTEGRATION");
    expect(m.controller.getState().results.integratedReview?.packet.architectureContradiction).toBeUndefined();

    await complete(m, {
      ...packets.integration,
      reviewerFindingsAcceptedRisk: ["Owner acceptance remains pending; not a blocking issue."],
      reviewerFindingsUnresolved: [
        "Physical iPad Safari acceptance remains owner-pending.",
        "Final Architect has not run and is the next gate.",
      ],
    });
    expect(m.controller.getState().state).toBe("FINAL_ARCHITECT");
    expect(m.controller.getState().results.integratedReview?.packet.architectureContradiction).toBeUndefined();
    expect(m.controller.getState().architectureContradiction).toBeUndefined();
    expect(m.controller.getState().results.integration?.packet.reviewerFindingsUnresolved.length).toBeGreaterThan(0);
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m).at(-1)).toBe("conformance.architect");
    const architectPrompt = m.transport.spawned.at(-1)?.prompt ?? "";
    expect(architectPrompt).toContain(testConcerns[0]);
    expect(architectPrompt).toContain(testConcerns[1]);
    expect(architectPrompt).not.toContain("No authoritative assumption was disproved");
    m.store.cleanup();
  });

  it.each([
    ["blocking findings", { ...integratedPass, blockingFindings: ["unresolved regression defect"] }],
    ["required repairs", { ...integratedPass, requiredRepairs: ["repair the broken target"] }],
  ] as const)("stops VERIFIED EXECUTION on PASS with %s", async (_label, review) => {
    const m = make("verified_execution");
    await reachIntegratedReview(m, review);
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().results.integration).toBeUndefined();
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("stops VERIFIED EXECUTION on an explicit architectural issue despite PASS", async () => {
    const m = make("verified_execution");
    const contradiction = {
      assumption: "The implementation must use the shared storage model.",
      repositoryEvidence: "The repository prohibits that storage model for this feature.",
      affectedTargetIds: ["wp-1"],
      cannotContinueBecause: "The contract cannot safely be implemented as approved.",
      ownerDecisionNeeded: "Choose a supported storage model.",
    };
    await reachIntegratedReview(m, { ...integratedPass, architecturalIssue: true, architectureContradiction: contradiction });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().architectureContradiction).toEqual(contradiction);
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m)).not.toContain("integration.lead");
    m.store.cleanup();
  });

  it("stops VERIFIED EXECUTION on an explicit blocking integration disposition", async () => {
    const m = make("verified_execution");
    await reachIntegratedReview(m);
    await complete(m, {
      ...packets.integration,
      reviewerFindingsUnresolved: ["unresolved contract violation"],
      blockingReviewerFindings: ["unresolved contract violation"],
    });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("explicit blocking Reviewer condition");
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("stops on the Integrated Reviewer's explicit architecture-contradiction verdict", async () => {
    const m = make("verified_execution");
    const contradiction = {
      assumption: "The approved architecture requires the unsupported backend.",
      repositoryEvidence: "The backend does not exist in this repository.",
      affectedTargetIds: ["wp-1"],
      cannotContinueBecause: "The approved design cannot be implemented safely.",
      ownerDecisionNeeded: "Choose a supported backend.",
    };
    await reachIntegratedReview(m, {
      ...integratedPass,
      verdict: "ARCHITECTURE_CONTRADICTION",
      architectureContradiction: contradiction,
    });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("stops on a non-PASS Reviewer outcome with an unresolved blocking repair", async () => {
    const m = make("verified_execution");
    await reachIntegratedReview(m, {
      ...integratedRepairT2,
      affectedTargetIds: [],
      blockingFindings: ["unresolved contract defect"],
    });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("repair scope is invalid");
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(phases(m)).not.toContain("conformance.architect");
    m.store.cleanup();
  });

  it("stops before integrated review when an explicit run-level check fails", async () => {
    const m = make("verified_execution", (id) => id === "Live preview" ? "failed" : "passed");
    await start(m);
    await complete(m, {
      ...contract,
      runVerification: [{ name: "Live preview", command: "node verify-live-preview.mjs", evidence: "Preview responds and has the expected workspace identity" }],
    });
    await complete(m, engineer("wp-1"));
    await complete(m, engineer("wp-2"));
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().results.runVerification).toEqual([{
      name: "Live preview", command: "node verify-live-preview.mjs", status: "failed", evidence: "failed: verified Live preview",
    }]);
    expect(phases(m)).not.toContain("integrated.review");
    expect(formatFactoryReport(m.controller.getState())).toContain("Live preview: failed");
    m.store.cleanup();
  });

  it("rejects a misspelled target verification key", async () => {
    const m = make("verified_execution");
    const targets = ["T1", "T2"].map((id) => ({ id, description: id, dependsOn: [], acceptanceCriteria: ["works"] }));
    await start(m);
    await complete(m, { ...contract, targets, workPackages: ["T1", "T2"], verification: {
      T1: { command: "true", evidence: "T1 passes" },
      T22: { command: "true", evidence: "typo must not be accepted" },
    } });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("verification for an unknown target");
    expect(formatFactoryReport(m.controller.getState())).toContain("T2: missing target verification instruction");
    expect(formatFactoryReport(m.controller.getState())).toContain("T22:");
    expect(phases(m)).not.toContain("execution.engineer");
    m.store.cleanup();
  });

  it("does not let run-level checks satisfy missing target verification", async () => {
    const m = make("verified_execution");
    const targets = ["T1", "T2"].map((id) => ({ id, description: id, dependsOn: [], acceptanceCriteria: ["works"] }));
    await start(m);
    await complete(m, {
      ...contract,
      targets,
      workPackages: ["T1", "T2"],
      verification: { T1: { command: "true", evidence: "T1 passes" } },
      runVerification: [{ name: "Live preview", command: "true", evidence: "live check passes" }],
    });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("verification for every target");
    expect(phases(m)).not.toContain("execution.engineer");
    m.store.cleanup();
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
    expect(report).toContain("Planned target verification (not run)");
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

  it("sends benign unresolved non-blocking findings through VERIFIED final Architect acceptance", async () => {
    const m = make("verified_execution");
    const finding = "Consider extracting the widget helper for readability.";
    const review = {
      ...integratedPass,
      nonBlockingFindings: [finding],
      testConcerns: ["The helper name could be clearer."],
    };
    const integration = {
      ...packets.integration,
      reviewerFindingsUnresolved: [finding, "The helper name could be clearer."],
      factualAssessment: "Final Acceptance Architect verdict: ACCEPT",
    };
    const ids = ["R1", "R2", "R3"];
    await start(m);
    await complete(m, {
      ...contract,
      targets: ids.map((id) => ({ id, description: id, dependsOn: [], acceptanceCriteria: ["works"] })),
      workPackages: ids,
      verification: Object.fromEntries(ids.map((id) => [id, { command: "true", evidence: `${id} verified` }])),
      runVerification: [{ name: "Live preview", command: "true", evidence: "served artifact identity" }],
    });
    for (const id of ids) await complete(m, engineer(id));
    expect(m.controller.getState().results.runVerification?.[0]?.status).toBe("passed");
    await complete(m, review);
    expect(m.controller.getState().results.integratedReview?.packet.verdict).toBe("PASS");
    await complete(m, integration);
    expect(m.controller.getState().state).toBe("FINAL_ARCHITECT");
    expect(phases(m).at(-1)).toBe("conformance.architect");
    expect(m.controller.getState().results.finalArchitect).toBeUndefined();
    expect(m.store.store.load(m.controller.getRunId())?.results.integration?.packet.factualAssessment).not.toContain("Final Acceptance Architect verdict: ACCEPT");
    const preGateReport = formatFactoryReport(m.controller.getState());
    expect(preGateReport).toContain("Final Architect: not recorded");
    expect(preGateReport).not.toContain("Final Acceptance Architect verdict: ACCEPT");
    const historical = m.controller.getSnapshot();
    historical.results.integration!.packet.factualAssessment = "VERDICT: ACCEPT (technically). Final Acceptance Architect verdict: ACCEPT";
    expect(formatFactoryReport(historical)).not.toContain("Final Acceptance Architect verdict: ACCEPT");
    expect(formatFactoryReport(historical)).not.toContain("VERDICT: ACCEPT");
    await complete(m, conformanceAccept);
    expect(m.controller.getState().results.finalArchitect?.packet.verdict).toBe("ACCEPT");
    await complete(m, packets.finalReport);
    expect(m.controller.getState().state).toBe("DONE");
    expect(formatFactoryReport(m.controller.getState())).toContain("Final Architect: ACCEPT");
    m.store.cleanup();
  });

  it("reports a final Architect rejection accurately after benign unresolved findings", async () => {
    const m = make("verified_execution");
    const finding = "Consider extracting the widget helper for readability.";
    await start(m);
    await completeTwoTargets(m);
    await complete(m, { ...integratedPass, nonBlockingFindings: [finding] });
    await complete(m, { ...packets.integration, reviewerFindingsUnresolved: [finding], factualAssessment: "Final Acceptance Architect verdict: ACCEPT" });
    await complete(m, {
      ...conformanceRejectT2,
      verdict: "ARCHITECTURE_CONTRADICTION",
      architectureContradiction: {
        assumption: "The widget can remain in one module",
        repositoryEvidence: "The repository requires isolated widget modules",
        affectedTargetIds: ["wp-2"],
        cannotContinueBecause: "The accepted design violates a repository invariant",
        ownerDecisionNeeded: "Choose a compatible module boundary",
      },
    });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().stoppedReason).toContain("architecture contradiction");
    expect(formatFactoryReport(m.controller.getState())).toContain("Final Architect: ARCHITECTURE_CONTRADICTION");
    expect(formatFactoryReport(m.controller.getState())).not.toContain("Final Acceptance Architect verdict: ACCEPT");
    m.store.cleanup();
  });

  it("keeps LEAN's existing stop rule for genuinely unresolved integration findings", async () => {
    const m = make("lean");
    await start(m);
    await completeTwoTargets(m);
    await complete(m, integratedPass);
    await complete(m, { ...packets.integration, reviewerFindingsUnresolved: ["unresolved contract violation"] });
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(phases(m)).not.toContain("conformance.architect");
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
