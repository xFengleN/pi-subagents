/**
 * ai-factory/persistence.test.ts — restart/recovery (spec tests 22, 23).
 *
 * A Factory run must survive process interruption: completed phases are never
 * redone (their packets are in the store); only an in-flight or parked phase is
 * resumed. Restart is simulated by constructing a fresh controller from the
 * persisted state with a fresh transport.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

let runCounter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function make() {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  cleanups.push(store.cleanup);
  const config = mergeFactoryConfig(defaultFactoryConfig(), {});
  return { transport, clock, store: store.store, config, dir: store.dir };
}

async function driveHappyPath(m: ReturnType<typeof make>, throughEngineer: boolean): Promise<void> {
  m.transport.completeLastPacket(packets.proposal);
  await flush();
  m.transport.completeLastPacket(packets.approve);
  await flush();
  if (!throughEngineer) return;
  m.transport.completeLastPacket(packets.engineer);
  await flush();
  m.transport.completeLastPacket(packets.reviewerPass);
  await flush();
}

describe("AI Factory — restart/recovery", () => {
  it("22. Restart restores an in-progress run and resumes without redoing completed phases", async () => {
    const m = make();
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    controller.start();
    await flush();
    // Advance through the initial Architect (Lead + Architect completed).
    await driveHappyPath(m, false);
    // Now the Engineer is in flight — "process dies" here.
    expect(controller.getState().state).toBe("EXECUTION");
    expect(m.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(1);

    // --- process restart: new transport, new controller, same store ---
    const m2 = make();
    m2.store = m.store; // same persisted state
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();

    // EXECUTION with an absent child requires approval: the run is parked,
    // inFlight is preserved, and no replacement Engineer is spawned.
    expect(restored!.getState().state).toBe("EXECUTION");
    expect(restored!.getState().inFlight).toBeDefined();
    expect(restored!.getState().parked).toBe(true);
    expect(m2.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(0);

    // Completed phases are NOT re-spawned: no duplicate lead/architect.
    expect(m2.transport.spawned.filter((s) => s.phase === "discovery.lead")).toHaveLength(0);
    expect(m2.transport.spawned.filter((s) => s.phase === "initial.architect")).toHaveLength(0);
  });

  it("22b. Restart restores a parked WAITING_CAPACITY run", async () => {
    const m = make();
    // All engineer targets unavailable → WAITING_CAPACITY.
    const config = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "p/eng", fallbacks: ["p/eng2"] } } },
      defaultRetryAfterMs: 60_000,
    });
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "quota exhausted" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    await flush();
    expect(controller.getState().state).toBe("WAITING_CAPACITY");
    const nextRetryAt = controller.getState().waiting!.nextRetryAt;

    // --- process restart ---
    const m2 = make();
    m2.store = m.store;
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();
    expect(restored!.getState().state).toBe("WAITING_CAPACITY");
    expect(restored!.getState().waiting?.nextRetryAt).toBe(nextRetryAt);

    // Capacity frees; the fake clock wakes the restored run.
    m2.transport.spawnHandler = () => ({ ok: true, agentId: "agent-restored" });
    m2.clock.advance(60_000 + 1);
    await flush();
    expect(restored!.getState().state).not.toBe("WAITING_CAPACITY");
    expect(m2.transport.spawned.filter((s) => s.phase === "execution.engineer").length).toBeGreaterThan(0);
  });

  it("23. Completed side-effectful phases are not duplicated after restart", async () => {
    const m = make();
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    controller.start();
    await flush();
    // Fully complete the initial Architect phase (side-effectful: lead recon +
    // architect checkpoint), then "die".
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    expect(controller.getState().state).toBe("EXECUTION");

    // Persisted results carry the completed packets.
    const persisted = m.store.load(controller.getRunId())!;
    expect(persisted.results.proposal?.packet.goal).toBe("Implement the widget");
    expect(persisted.results.initialArchitect?.packet.verdict).toBe("APPROVE");

    // Restart: completed phases must not run again; the pending Engineer phase
    // is blocked by approval (fail-closed for EXECUTION with absent child).
    const m2 = make();
    m2.store = m.store;
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();

    // Completed phases are NOT re-spawned.
    expect(m2.transport.spawned.filter((s) => s.phase === "discovery.lead")).toHaveLength(0);
    expect(m2.transport.spawned.filter((s) => s.phase === "initial.architect")).toHaveLength(0);
    // The lost Engineer is NOT re-spawned (approval required).
    expect(m2.transport.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(0);
    // Packets are preserved.
    expect(restored!.getState().results.proposal?.packet.goal).toBe("Implement the widget");
    expect(restored!.getState().results.initialArchitect?.packet.verdict).toBe("APPROVE");
    // The run is parked with inFlight preserved.
    expect(restored!.getState().parked).toBe(true);
    expect(restored!.getState().inFlight).toBeDefined();
  });

  it("terminal runs stay terminal after restore (no re-drive)", async () => {
    const m = make();
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    m.transport.completeLastPacket(packets.engineer);
    await flush();
    m.transport.completeLastPacket(packets.reviewerPass);
    await flush();
    m.transport.completeLastPacket(packets.integration);
    await flush();
    m.transport.completeLastPacket(packets.accept);
    await flush();
    m.transport.completeLastPacket(packets.finalReport);
    await flush();
    expect(controller.getState().state).toBe("DONE");

    const m2 = make();
    m2.store = m.store;
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      controller.getRunId(),
    );
    expect(restored!.getState().state).toBe("DONE");
    await flush();
    expect(m2.transport.spawned).toHaveLength(0);
  });

  it("restores with the run's own persisted config, not the current project config", async () => {
    const m = make();
    const persistedConfig = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "p/persisted" } } },
    });
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: persistedConfig },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    // The Engineer was spawned with the persisted config.
    expect(m.transport.spawned.at(-1)?.model).toBe("p/persisted");

    // --- restart, with a project config that has since changed ---
    const m2 = make();
    m2.store = m.store;
    const projectConfig = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "p/project" } } },
    });
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: projectConfig },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();

    // EXECUTION with an absent child requires approval: no spawn during restore.
    expect(m2.transport.spawned).toHaveLength(0);

    // The run's persisted config is preserved (the Engineer would use "p/persisted"
    // if resumed after approval, not the new project config's "p/project").
    expect(restored!.getState().config?.roles.engineer?.targets?.primary).toBe("p/persisted");
  });

  it("restores a run parked on an in-memory backoff retry without deadlocking", async () => {
    const m = make();
    const controller = FactoryController.create(
      { transport: m.transport, clock: m.clock, store: m.store, config: m.config },
      `run-${++runCounter}`,
      "T",
      m.dir,
    );
    // Read-only roles keep transient backoff; Engineer phases never auto-retry
    // an uncertain spawn outcome (Task 3). Park on the Architect instead: its
    // spawn is rejected transiently before any child can start.
    m.transport.spawnHandler = (req) =>
      req.role === "architect" ? ({ ok: false, error: "network timeout" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    // The Architect spawn fails transiently → same-target backoff retry, i.e.
    // parked with retry bookkeeping held ONLY in memory.
    expect(controller.getState().parked).toBe(true);
    expect(controller.getState().state).toBe("INITIAL_ARCHITECT");
    expect(controller.getState().state).not.toBe("WAITING_CAPACITY");

    // --- process restart before the backoff fires ---
    const m2 = make();
    m2.store = m.store;
    const restored = FactoryController.restore(
      { transport: m2.transport, clock: m2.clock, store: m2.store, config: m2.config },
      controller.getRunId(),
    );
    expect(restored).toBeDefined();
    await flush();

    // The retry bookkeeping is gone, but the run must re-attempt the current
    // phase from a fresh spawn rather than sit idle forever.
    expect(m2.transport.spawned.filter((s) => s.phase === "initial.architect")).toHaveLength(1);
    expect(restored!.getState().parked).toBe(false);
    expect(restored!.getState().state).toBe("INITIAL_ARCHITECT");
  });
});
