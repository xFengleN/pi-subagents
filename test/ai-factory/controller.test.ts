/**
 * ai-factory/controller.test.ts — Phase 1 core: the deterministic state machine,
 * the mandatory Architect checkpoints, the bounded repair loop, and the
 * no-hidden-model-call guards.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import type { FactoryConfig } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

let runCounter = 0;

function make(opts: { config?: Partial<FactoryConfig>; task?: string } = {}) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  const config = mergeFactoryConfig(defaultFactoryConfig(), opts.config as Record<string, unknown>);
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config },
    `run-${++runCounter}`,
    opts.task ?? "Implement the widget",
    store.dir,
  );
  return { transport, clock, store, config, controller };
}

/** Drive the run until the next spawn after the last fired completion. */
async function startRun(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
}

/** Spawned phases so far, in order. */
function phases(m: ReturnType<typeof make>): string[] {
  return m.transport.spawned.map((s) => s.phase);
}

function complete(m: ReturnType<typeof make>, packet: unknown): void {
  m.transport.completeLastPacket(packet);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeWithCleanup(opts: { config?: Partial<FactoryConfig>; task?: string } = {}) {
  const m = make(opts);
  cleanups.push(m.store.cleanup);
  return m;
}

describe("AI Factory controller — state machine", () => {
  it("1. Engineer cannot run before the initial Architect approval", async () => {
    const m = makeWithCleanup();
    await startRun(m);

    // DISCOVERY: Lead reconnaissance.
    expect(phases(m)).toEqual(["discovery.lead"]);
    complete(m, packets.proposal);
    await flush();
    expect(m.controller.getState().state).toBe("INITIAL_ARCHITECT");

    // The mandatory initial Architect gate: Engineer must NOT have spawned yet.
    expect(m.controller.getState().state).toBe("INITIAL_ARCHITECT");
    expect(phases(m)).toEqual(["discovery.lead", "initial.architect"]);
    expect(m.controller.getState().results.engineers).toHaveLength(0);

    // Only after approval does EXECUTION begin.
    complete(m, packets.approve);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(phases(m).at(-1)).toBe("execution.engineer");
  });

  it("2. Initial Architect is invoked exactly once during normal startup", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    const architectSpawns = m.transport.spawned.filter((s) => s.phase === "initial.architect");
    expect(architectSpawns).toHaveLength(1);
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    expect(m.transport.spawned.filter((s) => s.phase === "initial.architect")).toHaveLength(1);
  });

  it("3. Architect CORRECT replaces/updates the proposed plan deterministically", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.correct);
    await flush();

    // Effective architecture now carries the corrected plan.
    expect(m.controller.getState().effectiveArchitecture).toBe("corrected architecture: two modules");
    const engineerPrompt = m.transport.spawned.find((s) => s.phase === "execution.engineer")?.prompt ?? "";
    expect(engineerPrompt).toContain("corrected architecture: two modules");
  });

  it("4. Worker context does not inherit the full parent conversation by default", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    // Spawn everything through REVIEW and assert every child is fresh-context.
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    for (const req of m.transport.spawned) {
      expect(req).not.toHaveProperty("inheritContext");
      expect(req.isolated).toBe(true); // no parent extensions/skills leak in
    }
  });

  it("5. Engineer completion is represented by a compact packet, not a transcript", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();

    const engineer = m.controller.getState().results.engineers[0];
    expect(engineer.outcome.packet.summary).toBe("implemented widgets");
    expect(engineer.outcome.packet.workPackageId).toBe("wp-1");
    expect(engineer.outcome.agentId).toBeTypeOf("string");
    // The persisted state holds the packet, never a child transcript.
    const persisted = m.store.store.load(m.controller.getRunId())!;
    expect(persisted.results.engineers[0].outcome.packet.summary).toBe("implemented widgets");
    expect(JSON.stringify(persisted)).not.toContain("full engineer transcript");
  });

  it("6. Reviewer PASS advances without a Lead model call (no decision model)", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    const spawnCountBefore = m.transport.spawned.length;

    complete(m, packets.reviewerPass);
    await flush();

    // The transition to INTEGRATION is decided by code, and the only new spawn
    // is the integration Lead run — not a "Lead, what next?" consult.
    expect(m.controller.getState().state).toBe("INTEGRATION");
    expect(m.transport.spawned.length).toBe(spawnCountBefore + 1);
    expect(m.transport.spawned.at(-1)?.phase).toBe("integration.lead");
  });

  it("7. Reviewer NEEDS_FIX reinvokes Engineer through the bounded local loop", async () => {
    const m = makeWithCleanup({ config: { maxRepairRounds: 1 } });
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().repairRound).toBe(1);
    expect(m.transport.spawned.at(-1)?.phase).toBe("execution.engineer");
    // The re-invoked Engineer receives ONLY the concrete findings.
    const repairPrompt = m.transport.spawned.at(-1)?.prompt ?? "";
    expect(repairPrompt).toContain("add error handling");
  });

  it("8. Review-loop limit is enforced", async () => {
    const m = makeWithCleanup({ config: { maxRepairRounds: 1 } });
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix); // round 0 -> repair round 1
    await flush();
    complete(m, packets.engineer); // repair engineer
    await flush();
    complete(m, packets.reviewerNeedsFix); // still not fixed, budget exhausted
    await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().repairRound).toBe(1);
    // No third plain engineer; the exhausted loop escalates to Lead instead.
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(2);
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.lead");
  });

  it("9. Lead does not act as a message relay in the Engineer/Reviewer loop", async () => {
    const m = makeWithCleanup({ config: { maxRepairRounds: 1 } });
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();

    // Between the two reviewer verdicts, only Engineer/Reviewer roles ran.
    const loopRoles = m.transport.spawned.slice(2, -1).map((s) => s.role);
    expect(loopRoles).toEqual(["engineer", "reviewer", "engineer", "reviewer"]);
  });

  it("10. Final Architect is always invoked", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();

    expect(m.controller.getState().state).toBe("FINAL_ARCHITECT");
    expect(m.transport.spawned.at(-1)?.phase).toBe("final.architect");
  });

  it("11. Final Architect ACCEPT finalizes through the Lead synthesis, then DONE", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();
    complete(m, packets.accept);
    await flush();

    // ACCEPT never goes straight to DONE: one bounded final Lead synthesis runs.
    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");
    expect(m.transport.spawned.at(-1)?.phase).toBe("final_synthesis.lead");

    complete(m, packets.finalReport);
    await flush();

    expect(m.controller.getState().state).toBe("DONE");
    expect(m.controller.getState().results.finalReport?.packet.result).toBe("ACCEPT");
    expect(m.controller.getState().metrics.runEndedAt).toBeTypeOf("number");
  });

  it("12. Final Architect rejection enters remediation (bounded)", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();
    complete(m, packets.remediate);
    await flush();

    expect(m.controller.getState().state).toBe("REMEDIATION");
    expect(m.controller.getState().remediationRounds).toBe(1);
  });

  it("13. Remediation count is enforced and ACCEPT completes after the recheck", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();
    complete(m, packets.remediate);
    await flush();

    expect(m.transport.spawned.at(-1)?.phase).toBe("remediation.engineer");
    complete(m, packets.engineer);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("remediation.reviewer");
    complete(m, packets.reviewerPass);
    await flush();
    expect(m.controller.getState().state).toBe("FINAL_ARCHITECT_RECHECK");

    complete(m, packets.accept);
    await flush();
    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");
    // Exactly one final synthesis on the remediated path too.
    expect(m.transport.spawned.filter((s) => s.phase === "final_synthesis.lead")).toHaveLength(1);
    complete(m, packets.finalReportRemediated);
    await flush();
    expect(m.controller.getState().state).toBe("DONE");
    expect(m.controller.getState().remediationRounds).toBe(1);
    expect(m.controller.getState().results.finalReport?.packet.result).toBe("ACCEPT (after remediation)");
  });

  it("14. A second failure after budget exhaustion ends STOPPED, not a loop", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();
    complete(m, packets.remediate);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.remediate); // final recheck rejects again
    await flush();

    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().remediationRounds).toBe(1);
    expect(m.transport.spawned.filter((s) => s.phase === "remediation.engineer")).toHaveLength(1);
  });

  it("15. Deterministic transitions trigger no model request — only role agents ever spawn", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.integration);
    await flush();
    complete(m, packets.accept);
    await flush();
    complete(m, packets.finalReport);
    await flush();

    // Every spawned phase is a real role run. There is no "oracle" or
    // "decide-next-step" phase anywhere — the state machine never spends a
    // model turn merely to authorize a transition.
    const allowedPhases = new Set([
      "discovery.lead", "initial.architect", "execution.engineer", "review.reviewer",
      "integration.lead", "final.architect", "final_synthesis.lead",
    ]);
    for (const phase of phases(m)) expect(allowedPhases.has(phase), `unexpected phase ${phase}`).toBe(true);
    // The canonical happy path invokes exactly seven role runs: the six
    // implementation roles plus the one final Lead synthesis.
    expect(phases(m)).toEqual([
      "discovery.lead", "initial.architect", "execution.engineer", "review.reviewer",
      "integration.lead", "final.architect", "final_synthesis.lead",
    ]);
  });
});

describe("AI Factory controller — reviewer finding fidelity", () => {
  async function runToIntegration(m: ReturnType<typeof make>, integrationPacket: unknown): Promise<void> {
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    // PASS with a non-blocking advisory finding: no repair is required.
    complete(m, packets.reviewerPassWithNote);
    await flush();
    complete(m, integrationPacket);
    await flush();
  }

  it("7a. preserves a Reviewer non-blocking finding the Lead summarized away", async () => {
    const m = makeWithCleanup();
    // The Lead's packet insists there were no findings (the observed defect).
    await runToIntegration(m, packets.integrationIgnoringNote);

    const integration = m.controller.getState().results.integration!.packet;
    expect(integration.reviewerFindingsAcceptedRisk.join(" ")).toContain("None");
    // The deterministic guard preserved the finding with an explicit disposition.
    expect(integration.reviewerFindingsUnresolved).toContain("rename the helper for clarity");

    // ...and the Final Architect receives it, labelled by disposition.
    const finalArchitect = m.transport.spawned.find((s) => s.phase === "final.architect");
    expect(finalArchitect?.prompt).toContain("rename the helper for clarity");
    expect(finalArchitect?.prompt).toContain("UNRESOLVED");
  });

  it("7b. does not duplicate a finding the Lead already dispositioned", async () => {
    const m = makeWithCleanup();
    await runToIntegration(m, packets.integrationWithDisposition);

    const integration = m.controller.getState().results.integration!.packet;
    expect(integration.reviewerFindingsAcceptedRisk).toContain("rename the helper for clarity");
    expect(integration.reviewerFindingsUnresolved).toEqual([]);
  });
});

describe("AI Factory controller — repair-loop escalation paths", () => {
  it("escalates to the Architect when the Reviewer flags an architectural issue after the budget", async () => {
    const m = makeWithCleanup({ config: { maxRepairRounds: 1 } });
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerArchitectural);
    await flush();

    expect(m.controller.getState().state).toBe("ARCHITECT_ESCALATION");
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.architect");

    // Architect corrects; EXECUTION resumes with a fresh repair cycle.
    complete(m, packets.correct);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().repairRound).toBe(0);
    expect(m.controller.getState().effectiveArchitecture).toBe("corrected architecture: two modules");
  });

  it("ARCHITECTURAL_ESCALATION verdict routes straight to the Architect", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, { ...packets.reviewerArchitectural, verdict: "ARCHITECTURAL_ESCALATION" });
    await flush();

    expect(m.controller.getState().state).toBe("ARCHITECT_ESCALATION");
  });

  it("Lead 'stop' ends the run after the exhausted repair loop", async () => {
    const m = makeWithCleanup({ config: { maxRepairRounds: 1 } });
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerNeedsFix);
    await flush();
    expect(m.transport.spawned.at(-1)?.phase).toBe("escalation.lead");

    complete(m, { verdict: "stop", guidance: "too risky" });
    await flush();
    expect(m.controller.getState().state).toBe("STOPPED");
  });

  it("17. Consumed child results are not delivered twice", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    // Record the reviewer's own agent id BEFORE completing it — lastAgentId
    // advances to the next spawn (the integration lead) once PASS fires.
    const reviewerAgentId = m.transport.lastAgentId!;

    const engineersBefore = m.controller.getState().results.engineers.length;
    // First delivery: consumed + stored.
    complete(m, packets.reviewerPass);
    await flush();
    expect(m.transport.consumed).toHaveLength(4); // lead, architect, engineer, reviewer
    expect(m.controller.getState().results.reviewers).toHaveLength(1);

    // Re-delivering the same completion (a stray event) must be a no-op:
    // the result was already consumed, so it is not processed again.
    m.transport.fireCompleted({
      agentId: reviewerAgentId,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packets.reviewerPass),
    });
    await flush();
    expect(m.transport.consumed).toHaveLength(4);
    expect(m.controller.getState().results.reviewers).toHaveLength(1);
    expect(m.controller.getState().results.engineers).toHaveLength(engineersBefore);
  });

  it("spawn-time hard errors fail the run rather than hopping models", async () => {
    const m = makeWithCleanup();
    m.transport.spawnHandler = () => ({ ok: false, error: "Model not found: unknown" });
    await startRun(m);
    await flush();
    expect(m.controller.getState().state).toBe("FAILED");
    expect(m.controller.getState().errors[0].message).toContain("Model not found");
  });
});
