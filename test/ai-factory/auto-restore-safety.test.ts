/**
 * ai-factory/auto-restore-safety.test.ts — Safety of automatic restore (onRestore).
 *
 * Verifies that automatic restoration fails closed for interrupted EXECUTION /
 * REMEDIATION phases where an Engineer may have left partial workspace changes.
 * The fix lives in onRestore(): when a lost agent is detected and the phase
 * requires approval, the run is parked with inFlight preserved instead of
 * blindly re-spawning.
 *
 * Also covers: live-child adoption, WAITING_CAPACITY preservation, clean phase
 * boundary recovery, and explicit resume() on a parked run.
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
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function make(opts: { config?: Partial<FactoryConfig>; task?: string } = {}) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  const config = mergeFactoryConfig(defaultFactoryConfig(), opts.config as Record<string, unknown>);
  return { transport, clock, store: store.store, config, dir: store.dir, cleanup: store.cleanup };
}

/**
 * Drive a run through DISCOVERY → INITIAL_ARCHITECT → EXECUTION (Engineer in-flight).
 * Returns the controller, runId, and the engineer agent id.
 */
async function driveToExecution(
  m: { transport: FakeTransport; clock: FakeClock; store: FactoryController["store"]; config: FactoryConfig; dir: string },
): Promise<{ controller: FactoryController; runId: string; engineerAgentId: string }> {
  const controller = FactoryController.create(
    { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
    `run-${++runCounter}`,
    "test task",
    m.dir,
  );
  controller.start();
  await flush();
  m.transport.completeLastPacket(packets.proposal);
  await flush();
  m.transport.completeLastPacket(packets.approve);
  await flush();
  expect(controller.getState().state).toBe("EXECUTION");
  return { controller, runId: controller.getRunId(), engineerAgentId: m.transport.lastAgentId! };
}

/**
 * Drive a run through DISCOVERY → INITIAL_ARCHITECT → EXECUTION (Engineer done)
 * → REVIEW (Reviewer done) → INTEGRATION (Lead done) → FINAL_ARCHITECT → REMEDIATION
 * (Engineer in-flight).
 */
async function driveToRemediation(
  m: { transport: FakeTransport; clock: FakeClock; store: FactoryController["store"]; config: FactoryConfig; dir: string },
): Promise<{ controller: FactoryController; runId: string; remediationAgentId: string }> {
  const controller = FactoryController.create(
    { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
    `run-${++runCounter}`,
    "test task",
    m.dir,
  );
  controller.start();
  await flush();

  // DISCOVERY: Lead
  m.transport.completeLastPacket(packets.proposal);
  await flush();

  // INITIAL_ARCHITECT: Architect
  m.transport.completeLastPacket(packets.approve);
  await flush();

  // EXECUTION: Engineer
  m.transport.completeLastPacket(packets.engineer);
  await flush();

  // REVIEW: Reviewer (NEEDS_FIX to trigger repair round)
  m.transport.completeLastPacket(packets.reviewerNeedsFix);
  await flush();

  // Second EXECUTION: Engineer (completes)
  m.transport.completeLastPacket(packets.engineer);
  await flush();

  // Second REVIEW: Reviewer (PASS)
  m.transport.completeLastPacket(packets.reviewerPass);
  await flush();

  // INTEGRATION: Lead
  m.transport.completeLastPacket(packets.integration);
  await flush();

  // FINAL_ARCHITECT: Architect (NEEDS_REMEDIATION)
  m.transport.completeLastPacket(packets.remediate);
  await flush();

  expect(controller.getState().state).toBe("REMEDIATION");
  return { controller, runId: controller.getRunId(), remediationAgentId: m.transport.lastAgentId! };
}

/**
 * Drive a run to a clean phase boundary (REVIEW with no inFlight).
 *
 * Simulates a process death between the Engineer completing and the Reviewer
 * spawning: the state is REVIEW but inFlight was cleared (the persisted
 * snapshot has no inFlight agent).
 */
async function driveToReview(
  m: { transport: FakeTransport; clock: FakeClock; store: FactoryController["store"]; config: FactoryConfig; dir: string },
): Promise<{ controller: FactoryController; runId: string }> {
  const controller = FactoryController.create(
    { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
    `run-${++runCounter}`,
    "test task",
    m.dir,
  );
  controller.start();
  await flush();

  // DISCOVERY: Lead
  m.transport.completeLastPacket(packets.proposal);
  await flush();

  // INITIAL_ARCHITECT: Architect
  m.transport.completeLastPacket(packets.approve);
  await flush();

  // EXECUTION: Engineer
  m.transport.completeLastPacket(packets.engineer);
  await flush();

  expect(controller.getState().state).toBe("REVIEW");

  // The controller has advanced to REVIEW. inFlight was cleared by onSettled,
  // but the drive loop will spawn the Reviewer. Stop the controller and clear
  // inFlight in the persisted state to simulate a process death between phases.
  controller.dispose();

  // Load, modify, save: clear inFlight so the restored controller sees a clean boundary.
  const persisted = m.store.load(controller.getRunId());
  if (persisted) {
    persisted.inFlight = undefined;
    m.store.save(persisted);
  }

  return { controller, runId: controller.getRunId() };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("Automatic restore safety (onRestore)", () => {
  it("EXECUTION with absent child: stays parked, inFlight preserved, no spawn", async () => {
    const m = make();
    const { controller, runId, engineerAgentId } = await driveToExecution(m);

    // The Engineer is in-flight.
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Restore with no status set (probe returns undefined → absent child).
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // The run should be parked — inFlight preserved, no spawn.
    expect(restored!.getState().state).toBe("EXECUTION");
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);
    expect(restored!.getState().parked).toBe(true);

    // No new engineer was spawned during automatic restore.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("REMEDIATION with absent child: stays parked, inFlight preserved, no spawn", async () => {
    const m = make();
    const { controller, runId, remediationAgentId } = await driveToRemediation(m);

    // The Remediation Engineer is in-flight.
    expect(controller.getState().inFlight?.agentId).toBe(remediationAgentId);

    // Restore with no status set (probe returns undefined → absent child).
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // The run should be parked — inFlight preserved, no spawn.
    expect(restored!.getState().state).toBe("REMEDIATION");
    expect(restored!.getState().inFlight?.agentId).toBe(remediationAgentId);
    expect(restored!.getState().parked).toBe(true);

    // No new remediation engineer was spawned.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "remediation.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("live child (running): adopts without re-spawning", async () => {
    const m = make();
    const { controller, runId, engineerAgentId } = await driveToExecution(m);

    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Restore with the child marked as running.
    const m2 = make();
    m2.store = m.store;
    m2.transport.agentStatuses.set(engineerAgentId, "running");

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // inFlight preserved (adopted).
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // No replacement engineer was spawned.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("WAITING_CAPACITY: preserves existing behavior (schedules wake, no spawn)", async () => {
    const m = make({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
    });

    // Drive to EXECUTION, exhaust targets → WAITING_CAPACITY. Every engineer
    // spawn is rejected with capacity BEFORE a child can start (a definitive
    // pre-spawn rejection, so automatic capacity recovery stays permitted).
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
      `run-${++runCounter}`,
      "test task",
      m.dir,
    );
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();

    expect(controller.getState().state).toBe("WAITING_CAPACITY");
    const nextRetryAt = controller.getState().waiting!.nextRetryAt;

    // Restore into a fresh controller.
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();

    // Should still be WAITING_CAPACITY with preserved timing.
    expect(restored!.getState().state).toBe("WAITING_CAPACITY");
    expect(restored!.getState().waiting!.nextRetryAt).toBe(nextRetryAt);

    // No agent was spawned during restore.
    expect(m2.transport.spawned).toHaveLength(0);

    // A timer should be scheduled.
    expect(m2.clock.pendingTimerCount()).toBeGreaterThan(0);
  });

  it("clean phase boundary (REVIEW with no inFlight): proceeds normally", async () => {
    const m = make();
    const { runId } = await driveToReview(m);

    // Restore into a fresh controller.
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // The restored controller sees a clean boundary: state is REVIEW, no inFlight.
    expect(restored!.getState().state).toBe("REVIEW");
    expect(restored!.getState().inFlight).toBeUndefined();

    // The restored controller should drive and spawn the Reviewer.
    await flush();
    const reviewerSpawns = m2.transport.spawned.filter((s) => s.phase === "review.reviewer");
    expect(reviewerSpawns).toHaveLength(1);
  });

  it("completed phase packets and counters unchanged when recovery is blocked", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    // Record the state before restore.
    const snapshotBefore = controller.getSnapshot();
    const engineerCountBefore = snapshotBefore.results.engineers.length;
    const reviewerCountBefore = snapshotBefore.results.reviewers.length;

    // Restore with absent child (approval required).
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // Packets and counters should be unchanged.
    const snapshotAfter = restored!.getSnapshot();
    expect(snapshotAfter.results.engineers.length).toBe(engineerCountBefore);
    expect(snapshotAfter.results.reviewers.length).toBe(reviewerCountBefore);

    // Metrics should not have been corrupted by the blocked recovery.
    expect(snapshotAfter.metrics.roles.engineer.attempts).toBe(1);
    expect(snapshotAfter.metrics.totalAttempts).toBe(3); // proposal + approve + engineer
  });

  it("explicit resume() on a parked (approval-required) run: returns approvalRequired, no spawn", async () => {
    const m = make();
    const { controller, runId, engineerAgentId } = await driveToExecution(m);

    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Restore with absent child — onRestore parks the run.
    const m2 = make();
    m2.store = m.store;

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
    );
    expect(restored).toBeDefined();

    // The run is parked.
    expect(restored!.getState().parked).toBe(true);
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Explicit resume() should return approvalRequired.
    const result = restored!.resume();
    expect(result.kind).toBe("approvalRequired");

    // No spawn happened.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);

    // State should be unchanged.
    expect(restored!.getState().state).toBe("EXECUTION");
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);
  });
});
