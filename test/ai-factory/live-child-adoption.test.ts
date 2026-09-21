/**
 * ai-factory/live-child-adoption.test.ts — Verified live-child adoption in onRestore().
 *
 * Tests that a restored controller can detect a still-running child via the
 * transport's agentStatus probe and adopt it without re-spawning. Also covers
 * the lost-agent path (absent/terminal child) and duplicate-ownership guard.
 *
 * Known limitation: a child that already settled before restore still goes
 * through the lost-agent re-spawn path — settled-record packet recovery is out
 * of scope for this task.
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

/** Drive a run through DISCOVERY → INITIAL_ARCHITECT → EXECUTION (Engineer in-flight). */
async function driveToExecution(m: { transport: FakeTransport; clock: FakeClock; store: FactoryController["store"]; config: FactoryConfig; dir: string }): Promise<{ controller: FactoryController; runId: string }> {
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
  return { controller, runId: controller.getRunId() };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("Live-child adoption in onRestore()", () => {
  it("a. Restoring with a still-live child: adopt without re-spawning", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    // The Engineer is in-flight.
    const engineerAgentId = m.transport.lastAgentId!;
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Simulate a session switch: the child is still running.
    const m2 = make();
    m2.store = m.store;
    m2.transport.agentStatuses.set(engineerAgentId, "running");
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    );
    expect(restored).toBeDefined();

    // inFlight should be preserved (adopted, not cleared).
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // resume() should reject because the live child already owns the run.
    const result = restored!.resume();
    expect(result.kind).toBe("duplicate");

    // No replacement engineer was spawned.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("b. Receiving the original child's completion advances the run", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    const engineerAgentId = m.transport.lastAgentId!;
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Simulate session switch: child still running.
    const m2 = make();
    m2.store = m.store;
    m2.transport.agentStatuses.set(engineerAgentId, "running");

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    );
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // resume() returns duplicate (live child owns the run).
    expect(restored!.resume().kind).toBe("duplicate");

    // Now fire the original child's completion with a valid engineer packet.
    m2.transport.fireCompleted({
      agentId: engineerAgentId,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packets.engineer),
    });
    await flush();

    // The run should advance past EXECUTION to REVIEW.
    expect(restored!.getState().state).toBe("REVIEW");

    // No new engineer was spawned during the adoption.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("c. Restoring an absent child in EXECUTION: approvalRequired, no spawn", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    const engineerAgentId = m.transport.lastAgentId!;
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Restore with no status set (probe returns undefined → absent child).
    const m2 = make();
    m2.store = m.store;
    // Do NOT set agentStatuses — probe returns undefined.

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    );
    expect(restored).toBeDefined();

    // resume() checks eligibility BEFORE onRestore(). EXECUTION with an absent
    // child requires approval (partial workspace changes possible). No spawn.
    const result = restored!.resume();
    expect(result.kind).toBe("approvalRequired");

    // inFlight is still set (onRestore was never called — no mutation).
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // No new engineer was spawned.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("d. Child settled during restoration: approvalRequired, no spawn", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    const engineerAgentId = m.transport.lastAgentId!;
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Simulate the child having already settled before restore.
    const m2 = make();
    m2.store = m.store;
    m2.transport.agentStatuses.set(engineerAgentId, "completed");

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    );
    expect(restored).toBeDefined();

    // resume() checks eligibility BEFORE onRestore(). EXECUTION with a settled
    // child requires approval (settled-record packet recovery is out of scope).
    // No spawn.
    const result = restored!.resume();
    expect(result.kind).toBe("approvalRequired");

    // inFlight is still set (onRestore was never called — no mutation).
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // No new engineer was spawned.
    const newEngineerSpawns = m2.transport.spawned.filter((s) => s.phase === "execution.engineer");
    expect(newEngineerSpawns).toHaveLength(0);
  });

  it("e. Duplicate live-child ownership: resume() returns duplicate on repeated calls", async () => {
    const m = make();
    const { controller, runId } = await driveToExecution(m);

    const engineerAgentId = m.transport.lastAgentId!;
    expect(controller.getState().inFlight?.agentId).toBe(engineerAgentId);

    // Simulate session switch: child still running.
    const m2 = make();
    m2.store = m.store;
    m2.transport.agentStatuses.set(engineerAgentId, "running");

    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      runId,
      { resume: false },
    );
    expect(restored!.getState().inFlight?.agentId).toBe(engineerAgentId);

    // First resume() returns duplicate.
    expect(restored!.resume().kind).toBe("duplicate");

    // Second resume() also returns duplicate.
    expect(restored!.resume().kind).toBe("duplicate");

    // A second controller restoring the same run with the child live also cannot drive.
    const m3 = make();
    m3.store = m.store;
    // m3 also probes the child as live → adoption → inFlight preserved → guard fires.
    m3.transport.agentStatuses.set(engineerAgentId, "running");
    const restored3 = FactoryController.restore(
      { transport: m3.transport, clock: m3.clock, store: m3.store, config: m3.config },
      runId,
      { resume: false },
    );
    expect(restored3!.getState().inFlight?.agentId).toBe(engineerAgentId);
    expect(restored3!.resume().kind).toBe("duplicate");
  });
});
