/**
 * ai-factory/resume-v1.test.ts — minimal end-to-end `/factory-resume` V1.
 *
 * Verification targets (delivery-focused):
 *   1. Read-only inspection and cancellation change no state and call no agent.
 *   2. A clean checkpoint continues without replaying accepted phases.
 *   3. WAITING_CAPACITY resumes using a replacement preset.
 *   4. An approved interrupted Engineer creates exactly one new attempt and
 *      does not loop back into the approval gate.
 *   5. Stale approval and duplicate ownership are rejected.
 *   6. A resumed run reaches DONE with its final report and historical evidence
 *      preserved.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig, replacementConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import factoryExtension from "../../src/ai-factory/index.js";
import { type LeaseProbe, LeaseStore, resetProcessOwnership } from "../../src/ai-factory/lease.js";
import { FACTORY_DIR, FactoryStore } from "../../src/ai-factory/store.js";
import { ctx as baseCtx, hermeticDir, makePi } from "../helpers/boot-extension.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const cleanups: Array<() => void> = [];
const hermetic: Array<ReturnType<typeof hermeticDir>> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const h of hermetic.splice(0)) h.restore();
  resetProcessOwnership();
  vi.restoreAllMocks();
});

function makeDir(): string {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return t.dir;
}

function workdir(): string {
  const h = hermeticDir({});
  hermetic.push(h);
  return h.dir;
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

function make(store: FactoryStore, runId: string, dir: string, config = defaultFactoryConfig(), transport = new FakeTransport()) {
  const clock = new FakeClock();
  const controller = FactoryController.create({ transport, clock, store, config }, runId, "task", dir);
  return { controller, transport, clock, store, config };
}

async function driveToExecution(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
  m.transport.completeLastPacket(packets.proposal);
  await flush();
  m.transport.completeLastPacket(packets.approve);
  await flush();
  expect(m.controller.getState().state).toBe("EXECUTION");
}

describe("resume V1 — verification", () => {
  it("1. read-only inspection and cancellation change no state and call no agent", async () => {
    const cwd = workdir();
    const { pi, commands, lifecycle } = makePi();
    const handlers = new Map<string, (d: any) => void>();
    const emitted: string[] = [];
    const spawns: unknown[] = [];
    const bus = {
      on: (channel: string, handler: (d: any) => void) => { handlers.set(channel, handler); return () => handlers.delete(channel); },
      emit: (channel: string, data: any) => { emitted.push(channel); handlers.get(channel)?.(data); },
    };
    handlers.set("subagents:rpc:ping", (d) => bus.emit(`subagents:rpc:ping:reply:${d.requestId}`, { success: true, data: { version: 2 } }));
    handlers.set("subagents:rpc:spawn", (d) => {
      spawns.push(d);
      bus.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: true, data: { id: `child-${spawns.length}` } });
    });
    handlers.set("subagents:rpc:consume", (d) => bus.emit(`subagents:rpc:consume:reply:${d.requestId}`, { success: true, data: {} }));
    pi.events = bus;
    factoryExtension(pi);
    await lifecycle.get("session_start")({}, baseCtx({ cwd }));
    bus.emit("subagents:ready", {});

    const notifications: Array<{ message: string; type?: string }> = [];
    const ui = {
      custom: vi.fn(async () => undefined), input: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false), editor: vi.fn(async () => undefined),
      notify: vi.fn((message: string, type?: string) => { notifications.push({ message, type }); }),
      setStatus: vi.fn(), setWidget: vi.fn(), addAutocompleteProvider: vi.fn(),
    };
    const ctx = {
      mode: "tui", hasUI: true, cwd,
      ui,
      modelRegistry: { getAvailable: () => [{ provider: "p", id: "model", name: "model" }] },
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      getSystemPrompt: () => "parent",
    } as any;

    // Start a run and drive it to EXECUTION (Engineer in flight).
    await commands.get("factory").handler("task t", ctx);
    await flush();
    bus.emit("subagents:completed", { id: "child-1", status: "completed", result: JSON.stringify(packets.proposal) });
    await flush();
    bus.emit("subagents:completed", { id: "child-2", status: "completed", result: JSON.stringify(packets.approve) });
    await flush();
    const started = notifications.find((n) => n.message.includes("Factory run started"))!.message;
    const runId = started.match(/runId: (\S+)/)![1];
    const stateFile = join(cwd, FACTORY_DIR, `${runId}.json`);
    const before = readFileSync(stateFile, "utf8");
    const spawnCount = spawns.length;

    // Read-only preview + cancel (confirm returns false): nothing changes.
    await commands.get("factory-resume").handler(runId, ctx);
    await flush();
    expect(notifications.some((n) => n.message.includes("Resume cancelled"))).toBe(true);
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect(spawns.length).toBe(spawnCount);
    expect(notifications.some((n) => n.message.includes("approval required") || n.message.includes("next action"))).toBe(true);
  });

  it("2. a clean checkpoint continues without replaying accepted phases", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-2", dir);
    // Drive DISCOVERY → INITIAL_ARCHITECT, then simulate a crash between the
    // proposal persisting and the Architect's spawned commit: clear inFlight.
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    const persisted = store.load("run-2")!;
    persisted.inFlight = undefined;
    store.save(persisted);
    expect(store.load("run-2")!.results.proposal).toBeDefined();

    // Resume: the accepted proposal phase is NOT replayed (no second Lead).
    const transport2 = new FakeTransport();
    const restored = FactoryController.restore(
      { transport: transport2, clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-2",
      { resume: false },
    );
    expect(restored).toBeDefined();
    expect(restored!.resume().kind).toBe("ok");
    await flush();
    expect(transport2.spawned.filter((s) => s.phase === "discovery.lead")).toHaveLength(0);
    expect(transport2.spawned.filter((s) => s.phase === "initial.architect")).toHaveLength(1);
    // The run continues to completion.
    transport2.completeLastPacket(packets.approve);
    await flush();
    expect(restored!.getState().state).toBe("EXECUTION");
  });

  it("3. WAITING_CAPACITY resumes using a replacement preset", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const transport = new FakeTransport();
    transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "quota exhausted" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    const original = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
      defaultRetryAfterMs: 120_000,
    });
    const m = make(store, "run-3", dir, original, transport);
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    // Replacement preset: a different primary with a local fallback.
    const preset = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "p/new1", fallbacks: ["local/llama"] }, maxTurns: 90 } },
      maxRepairRounds: 99, // must be ignored: workflow budgets are preserved
    });
    // The original config is preserved as history; only future-child settings change.
    const effective = replacementConfig(m.controller.getState().config, preset);
    expect(effective.roles.engineer.targets.primary).toBe("p/new1");
    expect(effective.roles.engineer.maxTurns).toBe(90);
    expect(effective.maxRepairRounds).toBe(m.controller.getState().config.maxRepairRounds);
    expect(effective.isolated).toBe(m.controller.getState().config.isolated);

    m.controller.applyPresetReplacement("test-preset", preset);
    expect(store.load("run-3")!.config.roles.engineer.targets.primary).toBe("p/a"); // history kept
    expect(store.load("run-3")!.presetReplacement?.preset).toBe("test-preset");

    // Capacity frees; the run resumes automatically at the preserved deadline
    // and the FUTURE Engineer spawn uses the replacement target.
    m.transport.spawnHandler = (req) => ({ ok: true, agentId: `agent-free-${req.phase}` });
    const nextRetryAt = m.controller.getState().waiting!.nextRetryAt;
    m.clock.advance(nextRetryAt + 1);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    const engineerSpawns = m.transport.spawned.filter((s) => s.role === "engineer");
    expect(engineerSpawns.at(-1)!.model).toBe("p/new1");
  });

  it("4. an approved interrupted Engineer creates exactly one new attempt and does not loop back into approval", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-4", dir);
    await driveToExecution(m);
    const oldAgentId = m.controller.getState().inFlight!.agentId;

    // Process restart: a fresh controller restores the interrupted run.
    const transport2 = new FakeTransport();
    const restored = FactoryController.restore(
      { transport: transport2, clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-4",
    );
    expect(restored).toBeDefined();
    // Automatic resume is refused; only approval may authorize the replay.
    expect(restored!.resume().kind).toBe("approvalRequired");
    const elig = restored!.getRecoveryEligibility();
    const result = restored!.resumeWithApproval(elig.checkpointId);
    expect(result.kind).toBe("ok");

    // Exactly one new attempt was created and it advances (no approval loop).
    await flush();
    const attempts = restored!.getState().attempts!.filter((a) => a.phase === "execution.engineer");
    expect(attempts).toHaveLength(2);
    expect(restored!.getState().parked).toBe(false);
    expect(restored!.getState().inFlight).toBeDefined();
    expect(restored!.getState().inFlight!.agentId).not.toBe(oldAgentId);
    // The resumed Engineer prompt instructs inspection of existing files.
    const prompt = transport2.spawned.find((s) => s.phase === "execution.engineer")!.prompt;
    expect(prompt).toContain("Inspect the existing files");
    // A second use of the same token is stale — the approval was consumed.
    expect(restored!.resumeWithApproval(elig.checkpointId).kind).toBe("staleApproval");

    // The run completes: the new Engineer + Reviewer continue without another gate.
    transport2.completeLastPacket(packets.engineer);
    await flush();
    expect(restored!.getState().state).toBe("REVIEW");
  });

  it("5. stale approval and duplicate ownership are rejected", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-5", dir);
    await driveToExecution(m);
    const restored = FactoryController.restore(
      { transport: new FakeTransport(), clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-5",
      { resume: false },
    )!;
    // Stale / wrong approval token is rejected.
    expect(restored.resumeWithApproval("wrong-token").kind).toBe("staleApproval");
    // A second use of an already-consumed token is stale (after the first
    // resume's drive has settled, the checkpoint advanced).
    const elig = restored.getRecoveryEligibility();
    expect(restored.resumeWithApproval(elig.checkpointId).kind).toBe("ok");
    await flush();
    expect(restored.resumeWithApproval(elig.checkpointId).kind).toBe("staleApproval");

    // Duplicate ownership: while the run is owned by a live process (simulated
    // by a real lease store in this process), a foreign contender is refused.
    const ownerLease = new LeaseStore({ cwd: dir, clock: new FakeClock() });
    expect(ownerLease.acquire("run-5").ok).toBe(true);
    const probe = new FakeProbe();
    probe.alive.add(1001);
    probe.identities.set(1001, "proc-1001");
    const foreign = new LeaseStore({
      cwd: dir, clock: new FakeClock(),
      identity: { hostname: "host-a", pid: 2002, processIdentity: "proc-2002" },
      probe,
    });
    const attempt = foreign.acquire("run-5");
    expect(attempt.ok).toBe(false);
    // Releasing with the wrong token must not remove the current owner's lease.
    expect(ownerLease.release("run-5", "nope")).toBe(false);
    ownerLease.release("run-5", ownerLease.readLease("run-5")!.owner.token);
  });

  it("6. a resumed run reaches DONE with its final report and historical evidence preserved", async () => {
    const dir = makeDir();
    const store = new FactoryStore(dir);
    const m = make(store, "run-6", dir);
    // Drive to REVIEW (engineer completed), then interrupt with the reviewer in flight.
    m.controller.start();
    await flush();
    m.transport.completeLastPacket(packets.proposal);
    await flush();
    m.transport.completeLastPacket(packets.approve);
    await flush();
    m.transport.completeLastPacket(packets.engineer);
    await flush();
    expect(m.controller.getState().state).toBe("REVIEW");
    // Simulate a crash between the Engineer settling and the Reviewer's spawned
    // commit: clear inFlight so the restored controller sees a clean boundary.
    const persisted = store.load("run-6")!;
    persisted.inFlight = undefined;
    store.save(persisted);

    // Restart mid-review: the accepted proposal/approve/engineer evidence is
    // preserved and the run continues from the reviewer.
    const transport2 = new FakeTransport();
    const restored = FactoryController.restore(
      { transport: transport2, clock: new FakeClock(), store: new FactoryStore(dir), config: defaultFactoryConfig() },
      "run-6",
      { resume: false },
    );
    expect(restored).toBeDefined();
    expect(restored!.resume().kind).toBe("ok");
    await flush();
    expect(restored!.getState().results.proposal).toBeDefined();
    expect(restored!.getState().results.initialArchitect).toBeDefined();
    expect(restored!.getState().results.engineers).toHaveLength(1);
    // The reviewer was NOT replayed as an Engineer, and no completed phase re-ran.
    expect(transport2.spawned.filter((s) => s.phase === "discovery.lead")).toHaveLength(0);
    expect(transport2.spawned.filter((s) => s.phase === "execution.engineer")).toHaveLength(0);

    // Complete the remaining pipeline.
    transport2.completeLastPacket(packets.reviewerPass);
    await flush();
    transport2.completeLastPacket(packets.integration);
    await flush();
    transport2.completeLastPacket(packets.accept);
    await flush();
    transport2.completeLastPacket(packets.finalReport);
    await flush();
    expect(restored!.getState().state).toBe("DONE");
    const done = store.load("run-6")!;
    expect(done.results.finalReport?.packet.result).toBe("ACCEPT");
    expect(done.results.proposal?.packet.goal).toBe("Implement the widget");
    expect(done.results.engineers).toHaveLength(1);
  });
});
