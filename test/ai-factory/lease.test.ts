/**
 * ai-factory/lease.test.ts — Task 2: exclusive per-run ownership and fenced
 * persistence.
 *
 * Deterministic fixtures (injected identities/probes) model independent
 * processes without real sleeps. One integration test uses a real child
 * process to exercise the OS-backed liveness probe end-to-end.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import {
  FactoryLeaseError,
  type LeaseProbe,
  LeaseStore,
  type MachineIdentity,
  processStartIdentity,
  resetProcessOwnership,
} from "../../src/ai-factory/lease.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import { createFactoryCheckpoint } from "../../src/ai-factory/recovery-model.js";
import { assessRecoveryEligibility } from "../../src/ai-factory/state.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import type { SpawnOutcome } from "../../src/ai-factory/transport.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  // The ownership registry is process-global by design; tests that drive runs
  // must reset it so a prior test's outstanding activity cannot leak into the
  // next test that reuses a run id.
  resetProcessOwnership();
});

function makeDir(): string {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return t.dir;
}

/** A scriptable liveness/identity probe standing in for a foreign process. */
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

/** A structurally valid, non-persisted v2 snapshot for store-level writes. */
function makeState(runId: string, cwd: string): FactoryRunState {
  const state: FactoryRunState = {
    version: 2,
    runId,
    createdAt: 0,
    updatedAt: 0,
    task: "task",
    cwd,
    config: defaultFactoryConfig(),
    state: "DISCOVERY",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 0,
    architectEscalations: 0,
    leadEscalations: 0,
    results: { engineers: [], reviewers: [] },
    metrics: emptyFactoryMetrics(0),
    errors: [],
    parked: false,
    stateRevision: 1,
    attempts: [],
  };
  state.checkpoint = createFactoryCheckpoint(state, state.stateRevision);
  return state;
}

describe("per-run lease acquisition", () => {
  it("A. two independent contenders: exactly one acquires the run", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");

    const a = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const b = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);

    const ra = a.acquire("run-1");
    expect(ra.ok).toBe(true);

    const rb = b.acquire("run-1");
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.reason).toMatch(/live process 1001/);

    // The on-disk lease still belongs to A.
    expect(a.readLease("run-1")?.owner.pid).toBe(1001);
  });

  it("B. the losing contender performs no state write", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");

    const aStore = new FactoryStore(dir, { leaseStore: leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe) });
    const tokenA = aStore.acquireLease("run-1");
    expect(tokenA).toBeDefined();
    aStore.save(makeState("run-1", dir), tokenA);
    const persistedAfterA = readdirSync(join(dir, ".pi/factory"));

    const bStore = new FactoryStore(dir, { leaseStore: leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe) });
    expect(() => bStore.acquireLease("run-1")).toThrow(FactoryLeaseError);
    // Any fenced write by the loser is refused.
    expect(() => bStore.save(makeState("run-1", dir), "loser-token")).toThrow(FactoryLeaseError);

    // The directory is untouched by B's attempt.
    expect(readdirSync(join(dir, ".pi/factory"))).toEqual(persistedAfterA);
  });

  it("C. a live same-host owner is not displaced merely because no registry is visible", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    expect(a.acquire("run-1").ok).toBe(true);

    // The lease decision consults the process probe only — never an agent /
    // manager registry (which would be invisible across processes anyway).
    const b = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    const rb = b.acquire("run-1");
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.reason).toMatch(/live process 1001/);
  });

  it("D. a demonstrably dead same-host owner can be reclaimed", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    expect(a.acquire("run-1").ok).toBe(true);

    // A's process dies.
    probe.alive.delete(1001);

    const b = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    const rb = b.acquire("run-1");
    expect(rb.ok).toBe(true);
    if (rb.ok) expect(rb.lease.owner.pid).toBe(1002);
    expect(a.readLease("run-1")?.owner.pid).toBe(1002);
  });

  it("D2. a dead owner without any recorded process identity is also reclaimable", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);

    const a = leaseStore(dir, ident("host-a", 1001), probe);
    expect(a.acquire("run-1").ok).toBe(true);
    probe.alive.delete(1001);

    const b = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    expect(b.acquire("run-1").ok).toBe(true);
  });

  it("E. foreign-host ownership is rejected with an actionable diagnostic", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const foreign = leaseStore(dir, ident("host-elsewhere", 1001, "proc-1001"), probe);
    expect(foreign.acquire("run-1").ok).toBe(true);

    const local = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    const r = local.acquire("run-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("run-1");
      expect(r.reason).toMatch(/another host/);
      expect(r.reason).toContain("host-elsewhere");
    }
  });

  it("E2. unverifiable liveness (permission error) refuses reclamation", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.unknown.add(2001);
    probe.identities.set(2001, "proc-2001");

    const owner = leaseStore(dir, ident("host-a", 2001, "proc-2001"), probe);
    expect(owner.acquire("run-2").ok).toBe(true);

    const contender = leaseStore(dir, ident("host-a", 2002, "proc-2002"), probe);
    const r = contender.acquire("run-2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot verify/);
  });

  it("E3. an alive pid with no recorded identity is ambiguous and refused", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(3001);

    const bare = leaseStore(dir, ident("host-a", 3001), probe);
    expect(bare.acquire("run-3").ok).toBe(true);

    const contender = leaseStore(dir, ident("host-a", 3002, "proc-3002"), probe);
    const r = contender.acquire("run-3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/live process 3001/);
  });

  it("E4. a corrupt lease file is never destroyed silently", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".pi/factory"), { recursive: true });
    writeFileSync(join(dir, ".pi/factory/run-4.lease.json"), "{ not json", "utf8");

    const contender = leaseStore(dir, ident("host-a", 4001, "proc-4001"), new FakeProbe());
    const r = contender.acquire("run-4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unverifiable/i);
    // The corrupt file is left untouched.
    expect(readdirSync(join(dir, ".pi/factory"))).toEqual(["run-4.lease.json"]);
  });

  it("I. release and re-acquisition work under safe conditions", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");

    const a = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const ra = a.acquire("run-1");
    expect(ra.ok).toBe(true);

    // Releasing with a wrong token must not remove the current owner's lease.
    expect(a.release("run-1", "wrong-token")).toBe(false);
    expect(a.readLease("run-1")).toBeDefined();

    if (ra.ok) expect(a.release("run-1", ra.lease.owner.token)).toBe(true);
    expect(a.readLease("run-1")).toBeUndefined();

    // A different contender can now acquire.
    const b = leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe);
    expect(b.acquire("run-1").ok).toBe(true);
  });

  it("same-process re-acquisition (session-switch adoption) re-tokens the lease", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const first = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const ra = first.acquire("run-1");
    expect(ra.ok).toBe(true);

    // A later LeaseStore representing the same process adopts and re-tokens.
    const second = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const rb = second.acquire("run-1");
    expect(rb.ok).toBe(true);
    if (ra.ok && rb.ok) expect(rb.lease.owner.token).not.toBe(ra.lease.owner.token);
  });
});

describe("fenced persistence", () => {
  it("F. a stale owner cannot commit after losing the lease", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");

    const aStore = new FactoryStore(dir, { leaseStore: leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe) });
    const tokenA = aStore.acquireLease("run-1")!;
    aStore.save(makeState("run-1", dir), tokenA); // revision 1

    // A dies; B reclaims and gets a new token.
    probe.alive.delete(1001);
    const bStore = new FactoryStore(dir, { leaseStore: leaseStore(dir, ident("host-a", 1002, "proc-1002"), probe) });
    const tokenB = bStore.acquireLease("run-1")!;
    expect(tokenB).not.toBe(tokenA);

    // A's later commit is fenced out by the token.
    const stale = makeState("run-1", dir);
    stale.stateRevision = 2;
    expect(() => aStore.save(stale, tokenA)).toThrow(/stale ownership token/);

    // B's write succeeds and advances the revision.
    bStore.save(makeState("run-1", dir), tokenB);
    expect(bStore.load("run-1")?.stateRevision).toBe(2);
  });

  it("G. a stale state revision is rejected, not silently overwritten", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const store = new FactoryStore(dir, { leaseStore: leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe) });
    const token = store.acquireLease("run-1")!;
    store.save(makeState("run-1", dir), token); // revision 1

    const behind = makeState("run-1", dir);
    behind.stateRevision = 0;
    expect(() => store.save(behind, token)).toThrow(/stale state revision/);

    // The persisted revision is untouched.
    expect(store.load("run-1")?.stateRevision).toBe(1);
  });

  it("H. read-only state inspection does not acquire ownership or mutate files", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    const ls = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const store = new FactoryStore(dir, { leaseStore: ls });

    // Seed a persisted run through a plain store (no lease involved).
    new FactoryStore(dir).save(makeState("run-1", dir));

    expect(store.load("run-1")?.runId).toBe("run-1");
    expect(store.loadStrict("run-1")?.runId).toBe("run-1");
    expect(store.list()).toContain("run-1");

    // No lease file exists for the inspected run; nothing was written.
    expect(ls.readLease("run-1")).toBeUndefined();
    expect(readdirSync(join(dir, ".pi/factory")).some((f) => f.endsWith(".lease.json"))).toBe(false);
  });

  it("list() excludes lease files", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    const ls = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    new FactoryStore(dir).save(makeState("run-1", dir));
    expect(ls.acquire("run-1").ok).toBe(true);

    expect(new FactoryStore(dir).list()).toEqual(["run-1"]);
  });
});

describe("controller lease wiring", () => {
  function leaseBacked(dir: string, identity: MachineIdentity, probe: FakeProbe): { store: FactoryStore; lease: LeaseStore } {
    const lease = leaseStore(dir, identity, probe);
    return { store: new FactoryStore(dir, { leaseStore: lease }), lease };
  }

  it("create acquires a lease; a live contender cannot create the same run", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.alive.add(1002);
    probe.identities.set(1001, "proc-1001");

    const a = leaseBacked(dir, ident("host-a", 1001, "proc-1001"), probe);
    const controller = FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store: a.store, config: defaultFactoryConfig() },
      "run-1",
      "task",
      dir,
    );
    expect(a.lease.readLease("run-1")).toBeDefined();

    const b = leaseBacked(dir, ident("host-a", 1002, "proc-1002"), probe);
    expect(() =>
      FactoryController.create(
        { transport: new FakeTransport(), clock: new FakeClock(), store: b.store, config: defaultFactoryConfig() },
        "run-1",
        "task",
        dir,
      ),
    ).toThrow(FactoryLeaseError);

    controller.dispose();
  });

  it("restore refuses to drive a run owned by a live foreign process", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseBacked(dir, ident("host-a", 1001, "proc-1001"), probe);
    const controller = FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store: a.store, config: defaultFactoryConfig() },
      "run-1",
      "task",
      dir,
    );
    expect(a.lease.readLease("run-1")).toBeDefined();

    const b = leaseBacked(dir, ident("host-a", 1002, "proc-1002"), probe);
    const restored = FactoryController.restore(
      { transport: new FakeTransport(), clock: new FakeClock(), store: b.store, config: defaultFactoryConfig() },
      "run-1",
    );
    expect(restored).toBeUndefined();

    controller.dispose();
  });

  it("a lease is not released while an in-flight spawn may still create a child", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseBacked(dir, ident("host-a", 1001, "proc-1001"), probe);
    const transport = new FakeTransport();
    const controller = FactoryController.create(
      { transport, clock: new FakeClock(), store: a.store, config: defaultFactoryConfig() },
      "run-1",
      "task",
      dir,
    );
    controller.start();
    await flush();
    transport.completeLastPacket(packets.proposal);
    await flush();
    transport.completeLastPacket(packets.approve);
    await flush();
    expect(controller.getState().inFlight).toBeDefined();

    controller.dispose();
    // Ownership is retained: the child is still unresolved.
    expect(a.lease.readLease("run-1")).toBeDefined();
  });

  it("a lease is released once the run has settled and the controller disposes", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseBacked(dir, ident("host-a", 1001, "proc-1001"), probe);
    const transport = new FakeTransport();
    const controller = FactoryController.create(
      { transport, clock: new FakeClock(), store: a.store, config: defaultFactoryConfig() },
      "run-1",
      "task",
      dir,
    );
    controller.start();
    await flush();
    transport.completeLastPacket(packets.proposal);
    await flush();
    transport.completeLastPacket(packets.approve);
    await flush();
    transport.completeLastPacket(packets.engineer);
    await flush();
    transport.completeLastPacket(packets.reviewerPass);
    await flush();
    transport.completeLastPacket(packets.integration);
    await flush();
    transport.completeLastPacket(packets.accept);
    await flush();
    transport.completeLastPacket(packets.finalReport);
    await flush();
    expect(controller.getState().state).toBe("DONE");

    controller.dispose();
    expect(a.lease.readLease("run-1")).toBeUndefined();
  });

  it("a controller commit after losing the lease is fenced out and the controller goes inert", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");

    const a = leaseBacked(dir, ident("host-a", 1001, "proc-1001"), probe);
    const transport = new FakeTransport();
    const controller = FactoryController.create(
      { transport, clock: new FakeClock(), store: a.store, config: defaultFactoryConfig() },
      "run-1",
      "task",
      dir,
    );
    controller.start();
    await flush();
    transport.completeLastPacket(packets.proposal);
    await flush();
    transport.completeLastPacket(packets.approve);
    await flush();
    expect(controller.getState().inFlight).toBeDefined();
    expect(controller.hasOwnership()).toBe(true);
    const persistedBefore = a.store.load("run-1")?.stateRevision;

    // A dies and B reclaims the lease.
    probe.alive.delete(1001);
    const b = leaseBacked(dir, ident("host-a", 1002, "proc-1002"), probe);
    expect(b.lease.acquire("run-1").ok).toBe(true);

    // The stale controller's next settle cannot persist: it fails closed
    // (inert) and the persisted state is untouched.
    transport.completeLastPacket(packets.engineer);
    await flush();
    expect(controller.hasOwnership()).toBe(false);
    expect(a.store.load("run-1")?.stateRevision).toBe(persistedBefore);
    expect(a.store.load("run-1")?.state).toBe("EXECUTION");

    // B remains the owner and can still write a newer revision.
    const nextState = makeState("run-1", dir);
    nextState.stateRevision = persistedBefore! + 1;
    nextState.checkpoint = createFactoryCheckpoint(nextState, nextState.stateRevision);
    b.store.save(nextState, b.lease.readLease("run-1")!.owner.token);
    expect(b.store.load("run-1")?.stateRevision).toBeGreaterThan(persistedBefore!);
  });
});

describe("real-process liveness probe (integration)", () => {
  it("processStartIdentity is available on this host", () => {
    const id = processStartIdentity(process.pid);
    if (process.platform === "linux" || process.platform === "darwin") expect(id).toBeDefined();
  });

  it("a live real child blocks acquisition; a dead one is reclaimed", async () => {
    const dir = makeDir();
    const runId = "run-real";
    const leasePath = join(dir, ".pi/factory", `${runId}.lease.json`);
    mkdirSync(join(dir, ".pi/factory"), { recursive: true });

    const childScript = `
      const fs = require("node:fs");
      const os = require("node:os");
      const leasePath = process.argv[1];
      const lease = {
        runId: ${JSON.stringify(runId)},
        owner: {
          token: "child-token-1234567890abcdef",
          hostname: os.hostname(),
          pid: process.pid,
          acquiredAt: Date.now(),
        },
      };
      fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + "\\n");
      process.stdout.write("READY\\n");
      process.stdin.resume();
      process.stdin.on("data", (d) => { if (d.toString().includes("EXIT")) process.exit(0); });
    `;
    const child = spawn(process.execPath, ["-e", childScript, leasePath], { stdio: ["pipe", "pipe", "inherit"] });

    const ready = new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        if (chunk.toString().includes("READY")) {
          child.stdout?.off("data", onData);
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`child exited before READY (code ${code})`)));
    });
    await ready;

    // The parent, with the real OS-backed probe, sees a live owner.
    const store = new FactoryStore(dir, { leaseStore: new LeaseStore({ cwd: dir, clock: new FakeClock() }) });
    expect(() => store.acquireLease(runId)).toThrow(/live process/);

    // Let the child exit; the lease becomes reclaimable.
    child.stdin?.write("EXIT\n");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const token = store.acquireLease(runId);
    expect(token).toBeDefined();
    store.releaseLease(runId, token!);
  });
});

/* -------------------------------------------------------------------------- */
/* B1 — unsafe same-process takeover (confirmed review blocker)               */
/* -------------------------------------------------------------------------- */

describe("B1 — same-process takeover requires a quiescent previous generation", () => {
  it("an unresolved spawn blocks takeover by an independent lease-store in the same process", () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const identity = ident("host-a", 1001, "proc-1001");

    // Two INDEPENDENT lease-store instances representing the same process. The
    // registry is module-level, so B cannot bypass it by constructing its own.
    const aLease = leaseStore(dir, identity, probe);
    const bLease = leaseStore(dir, identity, probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });
    const bStore = new FactoryStore(dir, { leaseStore: bLease });

    const tokenA = aStore.acquireLease("run-b1")!;
    // An unresolved spawn is registered before the RPC crosses the transport.
    expect(aStore.beginSpawn("run-b1", tokenA)).toBe(true);

    // Release is refused while outstanding activity exists.
    expect(aStore.releaseLease("run-b1", tokenA)).toBe(false);

    // B cannot take over, and cannot seed a replacement child.
    expect(() => bStore.acquireLease("run-b1")).toThrow(/outstanding|quiescent/);

    // The spawn resolves with a live child — still outstanding.
    aStore.childSpawned("run-b1", tokenA, "agent-C1");
    expect(() => bStore.acquireLease("run-b1")).toThrow(/outstanding|quiescent/);

    // The child settles; the generation is quiescent; takeover is now allowed.
    aStore.endChild("run-b1", tokenA, "agent-C1");
    expect(bStore.acquireLease("run-b1")).toBeDefined();
  });

  it("a disposed controller's unresolved spawn blocks takeover and prevents C2", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const identity = ident("host-a", 1001, "proc-1001");
    const aLease = leaseStore(dir, identity, probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });

    // A's engineer spawn never resolves until we say so.
    let resolveSpawn!: (v: SpawnOutcome) => void;
    const deferred = new Promise<SpawnOutcome>((resolve) => { resolveSpawn = resolve; });
    const transport = new FakeTransport();
    const controller = FactoryController.create(
      { transport, clock: new FakeClock(), store: aStore, config: defaultFactoryConfig() },
      "run-b1c",
      "task",
      dir,
    );
    const baseHandler = transport.spawnHandler;
    transport.spawnHandler = (req) => (req.role === "engineer" ? deferred : baseHandler(req));
    controller.start();
    await flush();
    transport.completeLastPacket(packets.proposal);
    await flush();
    transport.completeLastPacket(packets.approve);
    await flush();
    // A is now awaiting the engineer spawn RPC (unresolved spawn).
    expect(transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(1);

    // Session switch: dispose A; the controllers map is cleared.
    controller.dispose();

    // B (independent lease-store, same process) cannot take over, so its
    // restore refuses and no replacement child is spawned.
    const bLease = leaseStore(dir, identity, probe);
    const bStore = new FactoryStore(dir, { leaseStore: bLease });
    expect(() => bStore.acquireLease("run-b1c")).toThrow(/outstanding|quiescent/);
    const restored = FactoryController.restore(
      { transport: new FakeTransport(), clock: new FakeClock(), store: bStore, config: defaultFactoryConfig() },
      "run-b1c",
    );
    expect(restored).toBeUndefined();

    // A's spawn resolves late with C1.
    resolveSpawn({ ok: true, agentId: "agent-C1" });
    await flush();

    // Exactly one engineer child exists — C2 was never spawned, so there is no
    // concurrent C1/C2 execution.
    expect(transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(1);
    // A still owns the run.
    expect(aLease.readLease("run-b1c")).toBeDefined();
  });

  it("restore never replays a persisted spawn_requested phase merely because inFlight is absent", async () => {
    const dir = makeDir();
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const aLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });

    // A run whose latest attempt is spawn_requested (a crash mid-spawn): no
    // inFlight, no proposal result.
    const token = aStore.acquireLease("run-b1r")!;
    const state = makeState("run-b1r", dir);
    state.attempts = [{
      attemptId: "run-b1r:discovery.lead:1",
      role: "lead",
      phase: "discovery.lead",
      round: 0,
      target: "provider/lead-model",
      provenance: "spawn_requested",
      recoveryRisk: "uncertain_outcome",
      preparedAt: 1,
      spawnRequestedAt: 2,
      packetKind: "proposal",
    }];
    state.checkpoint = createFactoryCheckpoint(state, state.stateRevision);
    aStore.save(state, token);

    // Restore: the run must be parked, not replayed — no lead is spawned.
    const transport = new FakeTransport();
    const restored = FactoryController.restore(
      { transport, clock: new FakeClock(), store: aStore, config: defaultFactoryConfig() },
      "run-b1r",
    );
    expect(restored).toBeDefined();
    await flush();
    expect(restored!.getState().parked).toBe(true);
    expect(transport.spawned).toHaveLength(0);
    expect(restored!.getRecoveryEligibility().requiresApproval).toBe(true);

    // The pure planner classifies the same state as approval_required too.
    const persisted = aStore.load("run-b1r")!;
    expect(persisted.parked).toBe(true);
  });

  it("eligibility requires approval for an unresolved-spawn phase even when parked", () => {
    const dir = makeDir();
    const state = makeState("run-b1e", dir);
    state.state = "EXECUTION";
    state.parked = true;
    state.attempts = [{
      attemptId: "run-b1e:execution.engineer:1",
      role: "engineer",
      phase: "execution.engineer",
      round: 0,
      target: "provider/engineer-model",
      provenance: "spawn_requested",
      recoveryRisk: "workspace_may_have_changed",
      preparedAt: 1,
      spawnRequestedAt: 2,
      packetKind: "engineer",
    }];
    state.checkpoint = createFactoryCheckpoint(state, state.stateRevision);

    const eligibility = assessRecoveryEligibility(state);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.requiresApproval).toBe(true);
    expect(eligibility.reason).toMatch(/unresolved spawn/);
  });
});

/* -------------------------------------------------------------------------- */
/* B2 — premature lease release after stop (confirmed review blocker)         */
/* -------------------------------------------------------------------------- */

describe("B2 — a stop request is not proof of child termination", () => {
  async function driveToInFlightEngineer(dir: string) {
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const aLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), probe);
    const aStore = new FactoryStore(dir, { leaseStore: aLease });
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const controller = FactoryController.create(
      { transport, clock, store: aStore, config: defaultFactoryConfig() },
      "run-b2",
      "task",
      dir,
    );
    controller.start();
    await flush();
    transport.completeLastPacket(packets.proposal);
    await flush();
    transport.completeLastPacket(packets.approve);
    await flush();
    return { aLease, aStore, transport, controller, engineerId: controller.getState().inFlight!.agentId };
  }

  it("dispose after stop with unconfirmed termination retains the lease", async () => {
    const dir = makeDir();
    const { aLease, aStore, transport, controller, engineerId } = await driveToInFlightEngineer(dir);

    // Stop: best-effort child stop, inFlight cleared, termination UNCONFIRMED.
    controller.stop("user stop");
    expect(controller.getState().state).toBe("STOPPED");
    expect(transport.stopped).toContain(engineerId);
    expect(controller.getState().inFlight).toBeUndefined();

    // Dispose must NOT release while the child may still modify the workspace.
    controller.dispose();
    expect(aLease.readLease("run-b2")).toBeDefined();
    expect(controller.getReleaseBlockedReason()).toMatch(/outstanding|unresolved/);

    // A new controller in the same process cannot take over either.
    const bLease = leaseStore(dir, ident("host-a", 1001, "proc-1001"), new FakeProbe());
    expect(() => aStore.acquireLease("run-b2")).toThrow(/outstanding|quiescent/);
    expect(bLease.readLease("run-b2")).toBeDefined();
  });

  it("dispose releases only after termination is independently confirmed", async () => {
    const dir = makeDir();
    const { aLease, transport, controller, engineerId } = await driveToInFlightEngineer(dir);

    controller.stop("user stop");
    expect(controller.getState().state).toBe("STOPPED");

    // Independently confirm termination: the child's settle event arrives.
    transport.fireFailed({ agentId: engineerId, ok: false, status: "stopped", error: "stopped by user" });
    await flush();

    controller.dispose();
    expect(aLease.readLease("run-b2")).toBeUndefined();
  });
});
