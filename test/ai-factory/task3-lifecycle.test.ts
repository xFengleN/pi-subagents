/**
 * ai-factory/task3-lifecycle.test.ts — Task 3: controller lifecycle, spawn /
 * disposal safety, and durable attempt journaling.
 *
 * Deterministic fixtures (deferred spawns, fake probes, shared fake
 * transports) establish race behavior without arbitrary sleeps.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { type LeaseProbe, LeaseStore, type MachineIdentity, resetProcessOwnership } from "../../src/ai-factory/lease.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import type { SpawnOutcome } from "../../src/ai-factory/transport.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetProcessOwnership();
});

function makeDir(): string {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return t.dir;
}

function make(store: FactoryStore, runId: string, dir: string, transport = new FakeTransport(), clock = new FakeClock()) {
  const controller = FactoryController.create(
    { transport, clock, store, config: defaultFactoryConfig() },
    runId,
    "task",
    dir,
  );
  return { controller, transport, clock, store };
}

/** Drive a controller through DISCOVERY + INITIAL_ARCHITECT into EXECUTION. */
async function driveToExecution(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
  m.transport.completeLastPacket(packets.proposal);
  await flush();
  m.transport.completeLastPacket(packets.approve);
  await flush();
  expect(m.controller.getState().state).toBe("EXECUTION");
}

/** A deferred spawn outcome the test resolves explicitly. */
function deferredSpawn(): { promise: Promise<SpawnOutcome>; resolve: (v: SpawnOutcome) => void } {
  let resolve!: (v: SpawnOutcome) => void;
  const promise = new Promise<SpawnOutcome>((r) => { resolve = r; });
  return { promise, resolve };
}

class FakeProbe implements LeaseProbe {
  alive = new Set<number>();
  unknown = new Set<number>();
  identities = new Map<number, string>();

  liveness(pid: number) {
    if (this.unknown.has(pid)) return { state: "unknown" as const, reason: "permission denied (simulated)" };
    return this.alive.has(pid) ? ({ state: "alive" as const }) : ({ state: "dead" as const });
  }

  processIdentity(pid: number): string | undefined {
    return this.identities.get(pid);
  }
}

function ident(host: string, pid: number, proc?: string): MachineIdentity {
  return { hostname: host, pid, ...(proc !== undefined ? { processIdentity: proc } : {}) };
}

function leaseStore(dir: string, identity: MachineIdentity, probe: FakeProbe): LeaseStore {
  return new LeaseStore({ cwd: dir, clock: new FakeClock(), identity, probe });
}

describe("Task 3 — persist-before-spawn and attempt journaling", () => {
  it("1. the durable attempt exists before the transport spawn resolves", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const transport = new FakeTransport();
    const deferred = deferredSpawn();
    const base = transport.spawnHandler;
    transport.spawnHandler = (req) => (req.role === "engineer" ? deferred.promise : base(req));

    const m = make(store, "run-1", dir, transport);
    await driveToExecution(m);
    // The engineer spawn is pending; the attempt must already be durable.
    const persisted = store.load("run-1")!;
    const attempt = persisted.attempts!.at(-1)!;
    expect(attempt.phase).toBe("execution.engineer");
    expect(attempt.role).toBe("engineer");
    expect(attempt.provenance).toBe("spawn_requested");
    expect(attempt.configRevision).toBeDefined();
    expect(attempt.recoveryRisk).toBe("workspace_may_have_changed");
    // Not yet persisted as owned work (no inFlight, no spawned provenance).
    expect(persisted.inFlight).toBeUndefined();
    // Every spawn carries the canonical persisted workspace.
    for (const spawn of transport.spawned) expect(spawn.cwd).toBe(dir);

    deferred.resolve({ ok: true, agentId: "agent-1" });
    await flush();
    m.controller.dispose();
  });

  it("2+3. dispose during a delayed spawn: the late child is stopped, never committed as owned work", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const aLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });

    const transport = new FakeTransport();
    const deferred = deferredSpawn();
    const base = transport.spawnHandler;
    transport.spawnHandler = (req) => (req.role === "engineer" ? deferred.promise : base(req));
    const m = make(aStore, "run-2", dir, transport);
    await driveToExecution(m);

    // Session switch: dispose the controller while the spawn RPC is pending.
    m.controller.dispose();
    expect(transport.stopped).not.toContain("agent-late");

    // A late settle cannot advance a disposed controller.
    transport.fireCompleted({ agentId: "agent-late", ok: true, status: "completed", structuredJson: JSON.stringify(packets.engineer) });
    await flush();
    expect(aStore.load("run-2")!.results.engineers).toHaveLength(0);

    // The spawn resolves late with a live child: it is stopped and never
    // imported as owned work.
    deferred.resolve({ ok: true, agentId: "agent-late" });
    await flush();
    expect(transport.stopped).toContain("agent-late");
    const persisted = aStore.load("run-2")!;
    expect(persisted.inFlight).toBeUndefined();
    expect(persisted.state).toBe("EXECUTION");
    expect(persisted.results.engineers).toHaveLength(0);
    const attempt = persisted.attempts!.at(-1)!;
    expect(attempt.provenance).toBe("spawn_requested"); // unresolved, not "spawned"
    expect(attempt.recoveryRisk).toBe("workspace_may_have_changed");

    // The stopped child's termination is unconfirmed: the ownership registry
    // keeps it outstanding, so a same-process takeover is refused.
    const bLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const bStore = new FactoryStore(dir, { leaseStore: bLease });
    expect(() => bStore.acquireLease("run-2")).toThrow(/outstanding|quiescent/);
  });

  it("4. an unconfirmed child stop retains ownership protection through dispose", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const aLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });

    const m = make(aStore, "run-4", dir);
    await driveToExecution(m);
    const engineerId = m.controller.getState().inFlight!.agentId;

    // Stop is best-effort; termination is NOT confirmed.
    m.controller.stop("user stop");
    expect(m.transport.stopped).toContain(engineerId);
    m.controller.dispose();
    expect(aLease.readLease("run-4")).toBeDefined();
    expect(m.controller.getReleaseBlockedReason()).toMatch(/outstanding|unresolved/);

    const bLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const bStore = new FactoryStore(dir, { leaseStore: bLease });
    expect(() => bStore.acquireLease("run-4")).toThrow(/outstanding|quiescent/);
  });

  it("5. a child settling before the spawn reply is imported exactly once (no hang)", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const transport = new FakeTransport();
    const deferred = deferredSpawn();
    const base = transport.spawnHandler;
    transport.spawnHandler = (req) => (req.role === "engineer" ? deferred.promise : base(req));

    const m = make(store, "run-5", dir, transport);
    await driveToExecution(m);

    // The engineer child settles BEFORE its spawn RPC returns.
    transport.fireCompleted({ agentId: "agent-late", ok: true, status: "completed", structuredJson: JSON.stringify(packets.engineer) });
    await flush();
    // Still pending — the run has not hung and has not double-processed.
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().results.engineers).toHaveLength(0);

    // The spawn reply arrives; the buffered settle is imported exactly once.
    deferred.resolve({ ok: true, agentId: "agent-late" });
    await flush();
    expect(m.controller.getState().results.engineers).toHaveLength(1);
    expect(m.controller.getState().state).toBe("REVIEW");
    expect(transport.spawned.filter((s) => s.role === "reviewer")).toHaveLength(1);
    m.controller.dispose();
  });

  it("6. a failed/invalid-packet Engineer blocks on restart — never auto-replays", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-6", dir);
    await driveToExecution(m);

    // The engineer completes with a packet that fails validation (missing
    // required status/fields).
    m.transport.completeLastPacket({ summary: "not a real engineer packet" });
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    // No same-target retry for an Engineer that already started.
    expect(m.transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(1);

    // Restart: the engineer is NOT replayed; the run requires approval.
    const m2Transport = new FakeTransport();
    const restored = FactoryController.restore(
      { transport: m2Transport, clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-6",
    );
    expect(restored).toBeDefined();
    await flush();
    expect(m2Transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(0);
    expect(restored!.getState().state).toBe("EXECUTION");
    expect(restored!.getRecoveryEligibility().requiresApproval).toBe(true);
    m.controller.dispose();
  });

  it("7. a definitive pre-spawn quota rejection preserves automatic capacity recovery with the deadline", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const transport = new FakeTransport();
    transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "quota exhausted" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    const m = make(store, "run-7", dir, transport);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");
    const nextRetryAt = m.controller.getState().waiting!.nextRetryAt;
    // The rejection was definitive (no child): the attempt carries no risk.
    expect(store.load("run-7")!.attempts!.at(-1)!.recoveryRisk).toBe("none");

    // Capacity frees: automatic recovery resumes from the primary at the
    // preserved deadline.
    transport.spawnHandler = (req) => ({ ok: true, agentId: `agent-free-${req.phase}` });
    m.controller.wake();
    await flush();
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY"); // before the deadline
    m.clock.advance(nextRetryAt + 1);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(transport.spawned.filter((s) => s.role === "engineer").length).toBeGreaterThanOrEqual(1);
    m.controller.dispose();
  });

  it("8. a post-start Engineer failure never auto-replays", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-8", dir);
    await driveToExecution(m);
    const engineerId = m.controller.getState().inFlight!.agentId;

    // The started engineer fails with a transient-looking error.
    m.transport.fireFailed({ agentId: engineerId, ok: false, status: "error", error: "network timeout" });
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.controller.getState().parked).toBe(false);
    // Not retried, not fallen back, not capacity-waited: exactly one spawn.
    expect(m.transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(1);
    // The failed attempt carries workspace risk and the agent identity.
    const attempt = store.load("run-8")!.attempts!.at(-1)!;
    expect(attempt.recoveryRisk).toBe("workspace_may_have_changed");
    expect(attempt.agentId).toBe(engineerId);

    // Restart: never auto-replayed.
    const m2Transport = new FakeTransport();
    const restored = FactoryController.restore(
      { transport: m2Transport, clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-8",
    );
    expect(restored).toBeDefined();
    await flush();
    expect(m2Transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(0);
    expect(restored!.getRecoveryEligibility().requiresApproval).toBe(true);
    m.controller.dispose();
  });

  it("9. two controllers receiving one completion cannot both advance", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");
    const aLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });

    // One shared transport delivers the completion to both controllers.
    const shared = new FakeTransport();
    const m = make(aStore, "run-9", dir, shared);
    await driveToExecution(m);
    const engineerId = m.controller.getState().inFlight!.agentId;

    // A dies; B (a different process) reclaims the lease and restores.
    probe.alive.delete(1001);
    const bLease = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    const bStore = new FactoryStore(dir, { leaseStore: bLease });
    const controllerB = FactoryController.restore(
      { transport: shared, clock: new FakeClock(), store: bStore, config: defaultFactoryConfig() },
      "run-9",
    );
    expect(controllerB).toBeDefined();
    expect(controllerB!.getState().inFlight?.agentId).toBe(engineerId);

    // One completion delivered to both subscribers.
    shared.fireCompleted({ agentId: engineerId, ok: true, status: "completed", structuredJson: JSON.stringify(packets.engineer) });
    await flush();

    // A is fenced out (stale token): it cannot persist its in-memory advance.
    expect(m.controller.hasOwnership()).toBe(false);
    const persisted = aStore.load("run-9")!;
    expect(persisted.results.engineers).toHaveLength(1); // B's advance only

    // B is the only controller that can spawn successors: exactly one reviewer.
    controllerB!.start();
    await flush();
    expect(shared.spawned.filter((s) => s.role === "reviewer")).toHaveLength(1);
    m.controller.dispose();
    controllerB!.dispose();
  });

  it("10. a workspace mismatch prevents the spawn before execution", async () => {
    const dir = makeDir();
    const other = makeDir();
    const store = new FactoryStore(dir);
    const transport = new FakeTransport();
    transport.expectedCwd = other; // this transport only runs in `other`

    const m = make(store, "run-10", dir, transport);
    m.controller.start();
    await flush();

    // The request carried the canonical persisted workspace, and the transport
    // rejected the mismatch before any child existed.
    expect(transport.spawned[0]?.cwd).toBe(dir);
    expect(transport.lastAgentId).toBeUndefined();
    expect(m.controller.getState().state).toBe("FAILED");
    m.controller.dispose();
  });
});
