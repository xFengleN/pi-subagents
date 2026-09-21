/**
 * ai-factory/recovery-approval.test.ts — Explicit recovery approval via resumeWithApproval().
 *
 * Tests the new `resumeWithApproval()` method on FactoryController and the
 * `checkpointId` field on FactoryRecoveryEligibility. Verifies:
 *   - Approval for a specific checkpoint binds correctly.
 *   - Stale approvals are rejected when the run advances.
 *   - Live children block approval (duplicate).
 *   - Terminal states reject any approval.
 *   - Rejected approvals do not mutate state.
 *   - WAITING_CAPACITY resumes without approval but still validates the token.
 *   - Approvals do not persist across new interruptions.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import type { FactoryConfig } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

let runCounter = 0;

function make(opts: { config?: Partial<FactoryConfig>; task?: string } = {}) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  const config = mergeFactoryConfig(defaultFactoryConfig(), opts.config as Record<string, unknown>);
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config },
    `run-${++runCounter}`,
    opts.task ?? "test task",
    store.dir,
  );
  return { transport, clock, store: store.store, config, controller, dir: store.dir, cleanup: store.cleanup };
}

async function startRun(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
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
  cleanups.push(m.cleanup);
  return m;
}

/**
 * Drive a run to a given checkpoint, then restore it into a fresh idle
 * controller via `restore(..., { resume: false })`.
 */
async function restoreIdle(
  m: ReturnType<typeof make>,
  runId: string,
): Promise<{ controller: FactoryController; transport: FakeTransport }> {
  const m2 = make();
  m2.store = m.store;
  const controller = FactoryController.restore(
    { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
    runId,
    { resume: false },
  )!;
  cleanups.push(m2.cleanup);
  return { controller, transport: m2.transport };
}

/* -------------------------------------------------------------------------- */
/* checkpointId on FactoryRecoveryEligibility                                 */
/* -------------------------------------------------------------------------- */

describe("checkpointId in FactoryRecoveryEligibility", () => {
  it("terminal DONE produces terminal:DONE", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();
    complete(m, packets.engineer); await flush();
    complete(m, packets.reviewerPass); await flush();
    complete(m, packets.integration); await flush();
    complete(m, packets.accept); await flush();
    complete(m, packets.finalReport); await flush();

    expect(m.controller.getState().state).toBe("DONE");
    const elig = m.controller.getRecoveryEligibility();
    expect(elig.checkpointId).toBe("terminal:DONE");
  });

  it("WAITING_CAPACITY produces WAITING_CAPACITY:<phase>", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });
    await startRun(m);
    complete(m, packets.proposal); await flush();

    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    complete(m, packets.approve); await flush();
    const agent = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    const agent2 = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent2, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");
    const elig = m.controller.getRecoveryEligibility();
    expect(elig.checkpointId).toMatch(/^WAITING_CAPACITY:/);
  });

  it("in-flight EXECUTION produces a checkpointId bound to the agent", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();
    const agentId = m.controller.getState().inFlight!.agentId;
    const elig = m.controller.getRecoveryEligibility();
    expect(elig.checkpointId).toBe(`EXECUTION:execution.engineer:${agentId}`);
  });

  it("parked EXECUTION (no inFlight) produces EXECUTION:parked", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    // Clear inFlight and set parked — simulates a backoff retry with no
    // active agent (the phase was not interrupted, the run was just waiting).
    m.controller.getState().inFlight = undefined;
    m.controller.getState().parked = true;
    const elig = m.controller.getRecoveryEligibility();
    expect(elig.checkpointId).toBe("EXECUTION:parked");
  });

  it("in-flight REMEDIATION produces a checkpointId bound to the agent", async () => {
    const m = makeWithCleanup();
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();
    complete(m, packets.engineer); await flush();
    complete(m, packets.reviewerPass); await flush();
    complete(m, packets.integration); await flush();
    complete(m, packets.remediate); await flush();

    expect(m.controller.getState().state).toBe("REMEDIATION");
    expect(m.controller.getState().inFlight).toBeDefined();
    const agentId = m.controller.getState().inFlight!.agentId;
    const elig = m.controller.getRecoveryEligibility();
    expect(elig.checkpointId).toBe(`REMEDIATION:remediation.engineer:${agentId}`);
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — approval for a specific checkpoint                  */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — approval for a specific checkpoint", () => {
  it("valid checkpoint resumes and re-spawns the interrupted phase", async () => {
    const m = makeWithCleanup();

    // Drive to EXECUTION with the Engineer in-flight.
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("EXECUTION");
    expect(restored.getState().inFlight).toBeDefined();

    // Get the eligibility and its checkpointId (bound to the specific agent).
    const elig = restored.getRecoveryEligibility();
    expect(elig.eligible).toBe(true);
    expect(elig.requiresApproval).toBe(true);
    const agentId = restored.getState().inFlight!.agentId;
    expect(elig.checkpointId).toBe(`EXECUTION:execution.engineer:${agentId}`);

    // Call resumeWithApproval with the correct checkpointId. The approval is
    // consumed and the interrupted phase is re-attempted ONCE with a fresh
    // spawn (no longer re-entering the approval gate).
    const result = restored.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("ok");
    expect(result.state).toBe("EXECUTION");
    expect(restored.getState().parked).toBe(false);

    // The Engineer should have been re-spawned (the new child is in flight).
    await flush();
    expect(restored.getState().inFlight).toBeDefined();
    // Exactly one new attempt was created; the approval token is consumed.
    const attempts = restored.getState().attempts!.filter((a) => a.phase === "execution.engineer");
    expect(attempts).toHaveLength(2);
    expect(restored.resumeWithApproval(elig.checkpointId).kind).toBe("staleApproval");
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — stale approval rejection                            */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — stale approval rejection", () => {
  it("rejects when the run has advanced to a new phase", async () => {
    const m = makeWithCleanup();

    // Drive to EXECUTION with the Engineer in-flight.
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("EXECUTION");

    // Get the eligibility and its checkpointId (bound to the specific agent).
    const elig = restored.getRecoveryEligibility();
    const agentId = restored.getState().inFlight!.agentId;
    expect(elig.checkpointId).toBe(`EXECUTION:execution.engineer:${agentId}`);

    // Simulate the run advancing: clear inFlight and transition to REVIEW
    // (this would happen if the Engineer completed between the eligibility
    // check and the approval call).
    restored.getState().inFlight = undefined;
    restored.getState().state = "REVIEW";
    restored.getState().updatedAt = 1;

    // Now the checkpointId has changed. The old token should be stale.
    const result = restored.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("staleApproval");
    expect((result as { kind: "staleApproval"; reason: string }).reason).toContain("Checkpoint changed");
  });

  it("rejects an obviously wrong checkpointId", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());

    const result = restored.resumeWithApproval("wrong-checkpoint");
    expect(result.kind).toBe("staleApproval");
  });

  it("rejects a stale token when the same phase label recurs with a new agent", async () => {
    const m = makeWithCleanup();

    // Drive to EXECUTION with the first Engineer in-flight.
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    const firstAgentId = m.controller.getState().inFlight!.agentId;

    // Restore and get the checkpointId for the first interruption.
    const { controller: restored1 } = await restoreIdle(m, m.controller.getRunId());
    const elig1 = restored1.getRecoveryEligibility();
    const tokenA = elig1.checkpointId;
    expect(tokenA).toBe(`EXECUTION:execution.engineer:${firstAgentId}`);

    // Simulate a second interruption in the same phase with a different agent.
    // This models: the first Engineer was re-spawned (new agentId), completed,
    // a repair round occurred, and a second Engineer was interrupted.
    const secondAgentId = "agent-second";
    restored1.getState().inFlight!.agentId = secondAgentId;

    // The checkpointId now reflects the new agent.
    const elig2 = restored1.getRecoveryEligibility();
    const tokenB = elig2.checkpointId;
    expect(tokenB).toBe(`EXECUTION:execution.engineer:${secondAgentId}`);
    expect(tokenB).not.toBe(tokenA);

    // Reusing token A (from the first interruption) must be rejected.
    const result2 = restored1.resumeWithApproval(tokenA);
    expect(result2.kind).toBe("staleApproval");

    // No mutation: the second Engineer is still in-flight, no new spawn.
    expect(restored1.getState().inFlight!.agentId).toBe(secondAgentId);
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — duplicate approval (live child)                     */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — duplicate approval with live child", () => {
  it("returns duplicate when the in-flight agent is still running", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Mark the child as live so the liveness probe returns "running".
    const agentId = m.controller.getState().inFlight!.agentId;
    m.transport.agentStatuses.set(agentId, "running");

    const elig = m.controller.getRecoveryEligibility();
    const result = m.controller.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("duplicate");
  });

  it("returns duplicate when the controller is driving", async () => {
    const m = makeWithCleanup();

    // Start the run — this sets driving = true.
    m.controller.start();

    // While driving, call resumeWithApproval. The drive loop is executing
    // so the method should reject as duplicate.
    const elig = m.controller.getRecoveryEligibility();
    const result = m.controller.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("duplicate");

    // Let the drive loop finish.
    await flush();
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — terminal state rejection                            */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — terminal state rejection", () => {
  it("rejects DONE with any checkpointId", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();
    complete(m, packets.engineer); await flush();
    complete(m, packets.reviewerPass); await flush();
    complete(m, packets.integration); await flush();
    complete(m, packets.accept); await flush();
    complete(m, packets.finalReport); await flush();

    expect(m.controller.getState().state).toBe("DONE");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resumeWithApproval("anything");
    expect(result.kind).toBe("terminal");
    expect((result as { kind: "terminal"; reason: string }).reason).toBe("Run already completed");
  });

  it("rejects STOPPED with any checkpointId", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    m.controller.stop("test stop");
    await flush();

    expect(m.controller.getState().state).toBe("STOPPED");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resumeWithApproval("anything");
    expect(result.kind).toBe("terminal");
  });

  it("rejects FAILED with any checkpointId", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    // The engineer spawn RPC is rejected with a hard error before any child
    // can start → the run fails (never a replayable engineer).
    m.transport.spawnHandler = () => ({ ok: false, error: "hard error" } as const);
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("FAILED");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resumeWithApproval("anything");
    expect(result.kind).toBe("terminal");
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — no mutation on rejected approval                    */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — no mutation on rejected approval", () => {
  it("state is unchanged after a stale approval rejection", async () => {
    const m = makeWithCleanup();

    // Drive to EXECUTION with the Engineer in-flight.
    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("EXECUTION");
    expect(restored.getState().inFlight).toBeDefined();

    const beforeState = restored.getSnapshot();
    const beforeInFlight = beforeState.inFlight;

    // Call with a wrong checkpointId.
    const result = restored.resumeWithApproval("wrong-checkpoint");
    expect(result.kind).toBe("staleApproval");

    // Verify state is unchanged.
    const afterState = restored.getSnapshot();
    expect(afterState.state).toBe(beforeState.state);
    expect(afterState.inFlight).toBeDefined();
    expect(afterState.inFlight!.agentId).toBe(beforeInFlight!.agentId);
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — WAITING_CAPACITY                                    */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — WAITING_CAPACITY", () => {
  it("resumes without approval but still validates the token", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    await startRun(m);
    complete(m, packets.proposal); await flush();

    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    complete(m, packets.approve); await flush();
    const agent = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    const agent2 = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent2, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("WAITING_CAPACITY");

    const elig = restored.getRecoveryEligibility();
    expect(elig.eligible).toBe(true);
    expect(elig.requiresApproval).toBe(false);

    // The checkpointId should be valid for WAITING_CAPACITY.
    const result = restored.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("ok");

    // The controller should still be in WAITING_CAPACITY because the retry
    // time has not elapsed yet (clock is at 0).
    expect(restored.getState().state).toBe("WAITING_CAPACITY");

    // Advance the clock past the retry time — the controller should now resume.
    restored.clock.advance(restored.getState().waiting!.nextRetryAt + 1);
    await flush();

    // Now the controller should have moved out of WAITING_CAPACITY.
    expect(restored.getState().state).not.toBe("WAITING_CAPACITY");
  });

  it("rejects wrong checkpointId for WAITING_CAPACITY", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    await startRun(m);
    complete(m, packets.proposal); await flush();

    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    complete(m, packets.approve); await flush();
    const agent = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    const agent2 = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent2, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resumeWithApproval("wrong-checkpoint");
    expect(result.kind).toBe("staleApproval");
  });
});

/* -------------------------------------------------------------------------- */
/* resumeWithApproval() — resume() is unaffected                              */
/* -------------------------------------------------------------------------- */

describe("resumeWithApproval() — resume() is unaffected", () => {
  it("resume() still rejects approval-required states", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal); await flush();
    complete(m, packets.approve); await flush();

    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("EXECUTION");

    // resume() should still reject.
    const result = restored.resume();
    expect(result.kind).toBe("approvalRequired");

    // resumeWithApproval with the correct checkpoint should succeed.
    const elig = restored.getRecoveryEligibility();
    const result2 = restored.resumeWithApproval(elig.checkpointId);
    expect(result2.kind).toBe("ok");
  });

  it("resume() still works for states that do not require approval", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    // Drive to EXECUTION, exhaust targets → WAITING_CAPACITY.
    await startRun(m);
    complete(m, packets.proposal); await flush();

    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    complete(m, packets.approve); await flush();
    const agent = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    const agent2 = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent2, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("WAITING_CAPACITY");

    // resume() should succeed (WAITING_CAPACITY is eligible, no approval).
    const result = restored.resume();
    expect(result.kind).toBe("ok");
  });
});
