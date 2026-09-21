/**
 * ai-factory/controller-recovery.test.ts — FactoryController.getRecoveryEligibility() and resume().
 *
 * Verifies:
 *   - getRecoveryEligibility(): read-only assessment for WAITING_CAPACITY and DONE.
 *   - resume(): explicit controller resume for eligible non-terminal runs.
 *     Tests use FactoryController.restore(..., { resume: false }) to create an
 *     idle controller from persisted state, then call resume() on it. This avoids
 *     race conditions between driving/inFlight and the resume check.
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

/** Drive the run until the next spawn after the last fired completion. */
async function startRun(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
}

/** Complete the most recently spawned agent with a packet. */
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

/* -------------------------------------------------------------------------- */
/* getRecoveryEligibility tests                                               */
/* -------------------------------------------------------------------------- */

describe("FactoryController.getRecoveryEligibility()", () => {
  it("WAITING_CAPACITY is eligible without approval", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    // Drive through DISCOVERY and INITIAL_ARCHITECT to reach EXECUTION. Every
    // engineer spawn is REJECTED with capacity before a child can start (a
    // definitive pre-spawn rejection, so automatic capacity recovery stays
    // permitted), exhausting both targets → WAITING_CAPACITY.
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    complete(m, packets.approve);
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    // Now assess recovery eligibility.
    const result = m.controller.getRecoveryEligibility();
    expect(result.eligible).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.reason).toBe("Parked waiting for capacity");

    // Verify the state is still WAITING_CAPACITY (no mutation).
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    // Verify no additional agent was spawned by the assessment.
    const spawnCountBefore = m.transport.spawned.length;
    m.controller.getRecoveryEligibility();
    expect(m.transport.spawned.length).toBe(spawnCountBefore);
  });

  it("DONE is not eligible", async () => {
    const m = makeWithCleanup();

    // Drive the run through to DONE.
    await startRun(m);

    // DISCOVERY: Lead
    complete(m, packets.proposal);
    await flush();
    expect(m.controller.getState().state).toBe("INITIAL_ARCHITECT");

    // Initial Architect
    complete(m, packets.approve);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");

    // Execution: Engineer
    complete(m, packets.engineer);
    await flush();
    expect(m.controller.getState().state).toBe("REVIEW");

    // Review: Reviewer
    complete(m, packets.reviewerPass);
    await flush();
    expect(m.controller.getState().state).toBe("INTEGRATION");

    // Integration: Lead
    complete(m, packets.integration);
    await flush();
    expect(m.controller.getState().state).toBe("FINAL_ARCHITECT");

    // Final Architect: ACCEPT
    complete(m, packets.accept);
    await flush();
    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");

    // Final Synthesis: Lead
    complete(m, packets.finalReport);
    await flush();
    expect(m.controller.getState().state).toBe("DONE");

    // Assess recovery eligibility — should be ineligible.
    const result = m.controller.getRecoveryEligibility();
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run already completed");
    expect(result.requiresApproval).toBe(false);

    // Verify the state is still DONE (no mutation).
    expect(m.controller.getState().state).toBe("DONE");

    // Verify no additional agent was spawned by the assessment.
    const spawnCountBefore = m.transport.spawned.length;
    // Call again — still no spawns.
    const result2 = m.controller.getRecoveryEligibility();
    expect(result2.eligible).toBe(false);
    expect(m.transport.spawned.length).toBe(spawnCountBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* resume() tests                                                             */
/* -------------------------------------------------------------------------- */

describe("FactoryController.resume()", () => {
  /**
   * Helper: drive a run to a given checkpoint, then restore it into a fresh
   * idle controller via `restore(..., { resume: false })`.
   * Returns the restored controller and its transport for inspection.
   */
  async function restoreIdle(
    m: ReturnType<typeof make>,
    runId: string,
  ): Promise<{ controller: FactoryController; transport: FakeTransport }> {
    const m2 = make();
    m2.store = m.store; // same persisted state
    const controller = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    )!;
    cleanups.push(m2.cleanup);
    return { controller, transport: m2.transport };
  }

  it("restored idle controller at INTEGRATION with in-flight Lead requires approval", async () => {
    const m = makeWithCleanup();

    // Drive through DISCOVERY → INITIAL_ARCHITECT → EXECUTION (Engineer completed)
    // → REVIEW (Reviewer completed). The controller transitions to INTEGRATION
    // and immediately spawns the Integration Lead, so inFlight is set.
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();

    expect(m.controller.getState().state).toBe("INTEGRATION");
    // The Integration Lead has spawned — inFlight is set.
    expect(m.controller.getState().inFlight).toBeDefined();

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());

    expect(restored.getState().state).toBe("INTEGRATION");
    expect(restored.getState().inFlight).toBeDefined();

    // resume() rejects: the in-flight Lead may have left partial work.
    const result = restored.resume();
    expect(result.kind).toBe("approvalRequired");
  });

  it("existing controller with live in-flight child rejects duplicate resume", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    // The Engineer has just spawned — inFlight is set.
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Mark the child as live so the liveness probe returns "running".
    const agentId = m.controller.getState().inFlight!.agentId;
    m.transport.agentStatuses.set(agentId, "running");

    const result = m.controller.resume();
    expect(result.kind).toBe("duplicate");
  });

  it("WAITING_CAPACITY preserves retry timing through restore + resume", async () => {
    const m = makeWithCleanup({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    // Drive to EXECUTION, exhaust targets → WAITING_CAPACITY.
    await startRun(m);
    complete(m, packets.proposal);
    await flush();

    // Set the spawn handler BEFORE the Architect completes so the Engineer
    // spawn (triggered by the approve packet) fails on both targets.
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    // The approve packet triggers the Engineer spawn, which fails on the primary.
    complete(m, packets.approve);
    await flush();

    // The controller falls back to the second target, which also fails.
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");
    const nextRetryAt = m.controller.getState().waiting!.nextRetryAt;

    // Restore into a fresh idle controller.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("WAITING_CAPACITY");
    expect(restored.getState().waiting!.nextRetryAt).toBe(nextRetryAt);

    // Resume should succeed (WAITING_CAPACITY is eligible, no approval).
    const result = restored.resume();
    expect(result.kind).toBe("ok");

    // The controller should still be in WAITING_CAPACITY because the retry time
    // has not elapsed yet (clock is at 0).
    expect(restored.getState().state).toBe("WAITING_CAPACITY");

    // The waiting state preserves the retry deadline.
    expect(restored.getState().waiting!.nextRetryAt).toBe(nextRetryAt);

    // Advance the clock past the retry time — the controller should now resume.
    restored.clock.advance(nextRetryAt + 1);
    await flush();

    // Now the controller should have moved out of WAITING_CAPACITY.
    expect(restored.getState().state).not.toBe("WAITING_CAPACITY");
  });

  it("rejects terminal DONE", async () => {
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

    expect(m.controller.getState().state).toBe("DONE");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resume();
    expect(result.kind).toBe("terminal");
    expect(result.reason).toBe("Run already completed");
  });

  it("rejects terminal STOPPED", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    // Stop the run.
    m.controller.stop("test stop");
    await flush();

    expect(m.controller.getState().state).toBe("STOPPED");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resume();
    expect(result.kind).toBe("terminal");
    expect(result.reason).toBe("Run was stopped");
  });

  it("rejects terminal FAILED", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    // The engineer spawn RPC is rejected with a hard error before any child
    // can start → the run fails (never a replayable engineer).
    m.transport.spawnHandler = () => ({ ok: false, error: "hard error" } as const);
    complete(m, packets.approve);
    await flush();

    expect(m.controller.getState().state).toBe("FAILED");

    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    const result = restored.resume();
    expect(result.kind).toBe("terminal");
    expect(result.reason).toBe("Run failed");
  });

  it("rejects approval-required (interrupted EXECUTION)", async () => {
    const m = makeWithCleanup();

    // Drive to EXECUTION with the Engineer in-flight.
    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    // The Engineer has just spawned — inFlight is set.
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().inFlight).toBeDefined();

    // Restore into a fresh idle controller — the inFlight field is preserved
    // in the persisted state, simulating a process restart mid-invocation.
    const { controller: restored } = await restoreIdle(m, m.controller.getRunId());
    expect(restored.getState().state).toBe("EXECUTION");
    expect(restored.getState().inFlight).toBeDefined();

    // resume() should reject because the phase is interrupted (requires approval).
    const result = restored.resume();
    expect(result.kind).toBe("approvalRequired");
    expect(result.reason).toContain("Interrupted");
  });

  it("rejects duplicate resume when child is live", async () => {
    const m = makeWithCleanup();

    await startRun(m);
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    // The Engineer is in-flight. Mark it as live so the liveness probe fires.
    const agentId = m.controller.getState().inFlight!.agentId;
    m.transport.agentStatuses.set(agentId, "running");

    const result = m.controller.resume();
    expect(result.kind).toBe("duplicate");
  });
});
