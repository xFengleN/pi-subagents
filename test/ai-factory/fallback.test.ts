/**
 * ai-factory/fallback.test.ts — availability resilience (spec tests 18–21).
 *
 * Fallback is about the backend being unavailable (rate-limited, exhausted,
 * capacity-blocked) — never about task difficulty. Role semantics do not change
 * during fallback.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import type { FactoryConfig } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

let runCounter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function make(configOverrides: Partial<FactoryConfig> = {}) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  cleanups.push(store.cleanup);
  const config = mergeFactoryConfig(defaultFactoryConfig(), configOverrides as Record<string, unknown>);
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config },
    `run-${++runCounter}`,
    "T",
    store.dir,
  );
  return { transport, clock, store: store.store, config, controller };
}

async function reachEngineerSpawn(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
  m.transport.completeLastPacket(packets.proposal);
  await flush();
  m.transport.completeLastPacket(packets.approve);
  await flush();
  // Now in EXECUTION; the engineer spawn will hit the failure handler.
}

/** Drive to the point where the Lead (DISCOVERY) spawn hits the handler. */
async function reachLeadSpawn(m: ReturnType<typeof make>): Promise<void> {
  m.controller.start();
  await flush();
}

describe("AI Factory — availability fallback", () => {
  it("18. Transient failure retries the same backend within a bound, then falls back", async () => {
    // Read-only roles keep transient retry; Engineer phases never auto-retry
    // an uncertain spawn outcome (Task 3), so this exercises the Lead.
    const m = make({ roles: { lead: { targets: { primary: "p/a", fallbacks: ["p/b"] }, maxTransientRetries: 2, retryDelayMs: 1_000 } } });
    // The primary fails transiently; the fallback is healthy.
    m.transport.spawnHandler = (req) =>
      req.role === "lead" && req.model === "p/a"
        ? ({ ok: false, error: "network timeout" } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);

    await reachLeadSpawn(m);

    // Attempt 1 on the primary fails at spawn time → same-target backoff retry.
    expect(m.transport.spawned.filter((s) => s.role === "lead")).toHaveLength(1);
    expect(m.controller.getState().parked).toBe(true);
    expect(m.clock.pendingTimerCount()).toBeGreaterThan(0);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(1);

    // Backoff fires → attempt 2, same target, still transient.
    m.clock.advance(1_001);
    await flush();
    expect(m.transport.spawned.filter((s) => s.role === "lead")).toHaveLength(2);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(2);

    // Attempt 3 exhausts the retry budget → advance to the healthy fallback.
    m.clock.advance(2_001);
    await flush();
    const leadModels = m.transport.spawned.filter((s) => s.role === "lead").map((s) => s.model);
    expect(leadModels).toEqual(["p/a", "p/a", "p/a", "p/b"]);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(2);
    expect(m.controller.getState().metrics.roles.lead.fallbacks).toBe(1);
  });

  it("19. Quota/capacity failure selects the configured fallback immediately", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] }, maxTransientRetries: 5 } } });
    // Every engineer spawn is REJECTED with quota before a child can start (a
    // definitive pre-spawn rejection): straight to the fallback.
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "quota exhausted" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);

    // No same-target retry for quota: straight to the fallback.
    expect(m.transport.spawned.at(-1)?.model).toBe("p/b");
    expect(m.controller.getState().metrics.roles.engineer.retries).toBe(0);
    expect(m.controller.getState().metrics.roles.engineer.fallbacks).toBe(1);
  });

  it("20. All fallbacks exhausted -> WAITING_CAPACITY (park, don't die)", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b", "p/c"] } } }, defaultRetryAfterMs: 30 * 60_000 });
    // Every engineer target is capacity-blocked.
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);

    // The in-flight engineer (p/a) fails with capacity → quota fallback chain.
    const agent = m.transport.lastAgentId!;
    m.transport.fireFailed({ agentId: agent, ok: false, status: "error", error: "capacity blocked" });
    await flush();

    const engineerModels = m.transport.spawned.filter((s) => s.role === "engineer").map((s) => s.model);
    expect(engineerModels).toEqual(["p/a", "p/b", "p/c"]);
    const s = m.controller.getState();
    expect(s.state).toBe("WAITING_CAPACITY");
    expect(s.waiting?.role).toBe("engineer");
    expect(s.waiting?.resumeState).toBe("EXECUTION");
    expect(s.metrics.capacityWaits).toBe(1);
    expect(s.metrics.roles.engineer.fallbacks).toBe(2);
    expect(m.clock.pendingTimerCount()).toBeGreaterThan(0);
  });

  it("21. Fake clock wakes WAITING_CAPACITY and resumes the pending spawn", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } }, defaultRetryAfterMs: 120_000 });
    // Both engineer spawns are rejected with quota before a child can start.
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "quota exhausted" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");

    // Capacity comes back. Waking before the retry time must NOT spawn.
    m.transport.spawnHandler = (req) => ({ ok: true, agentId: `agent-free-${req.phase}` });
    m.controller.wake();
    await flush();
    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");
    expect(m.transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(2);

    // Advancing the fake clock past nextRetryAt resumes from the primary.
    m.clock.advance(120_000 + 1);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    const engineerSpawns = m.transport.spawned.filter((s) => s.role === "engineer");
    expect(engineerSpawns).toHaveLength(3);
    expect(engineerSpawns.at(-1)?.model).toBe("p/a");
  });

  it("uses a provider retry-after when one is parseable", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a" } } }, defaultRetryAfterMs: 30 * 60_000 });
    // The single engineer spawn is rejected with a quota reply carrying a
    // retry-after, before any child can start.
    m.transport.spawnHandler = (req) =>
      req.role === "engineer"
        ? ({ ok: false, error: "429 Too Many Requests, quota exceeded, retry-after: 5" } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);

    const before = m.clock.now();
    const s = m.controller.getState();
    expect(s.state).toBe("WAITING_CAPACITY");
    expect(s.waiting?.retryAfterMs).toBe(5_000);
    expect(s.waiting!.nextRetryAt - before).toBe(5_000);
  });
});

describe("AI Factory — connectivity failure classification", () => {
  it("A. 'Connection error.' on the primary Lead retries then falls back and continues", async () => {
    // Read-only roles keep transient retry; Engineer phases never auto-retry
    // an uncertain spawn outcome (Task 3), so this exercises the Lead.
    const m = make({
      roles: { lead: { targets: { primary: "omlx/qwen", fallbacks: ["opencode-go/deepseek"] }, maxTransientRetries: 2, retryDelayMs: 1_000 } },
    });
    // The oMLX server is stopped: every spawn attempt on the primary fails
    // with a bare connectivity error before any child starts. The fallback
    // target is healthy.
    m.transport.spawnHandler = (req) =>
      req.role === "lead" && req.model === "omlx/qwen"
        ? ({ ok: false, error: "Connection error." } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachLeadSpawn(m);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(1);
    expect(m.transport.spawned.filter((s) => s.role === "lead")).toHaveLength(1);

    // Backoff fires → same-target retry #2.
    m.clock.advance(1_001);
    await flush();
    expect(m.transport.spawned.filter((s) => s.role === "lead")).toHaveLength(2);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(2);

    // Backoff fires → retry #3, which also fails; the budget is then exhausted
    // and the configured fallback is attempted immediately.
    m.clock.advance(2_001);
    await flush();

    const models = m.transport.spawned.filter((s) => s.role === "lead").map((s) => s.model);
    expect(models).toEqual(["omlx/qwen", "omlx/qwen", "omlx/qwen", "opencode-go/deepseek"]);
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(2);
    expect(m.controller.getState().metrics.roles.lead.fallbacks).toBe(1);
    // The run is still alive and continuing on the fallback.
    expect(m.controller.getState().state).toBe("DISCOVERY");
    expect(m.controller.getState().inFlight?.target).toBe("opencode-go/deepseek");
  });

  it("B. ECONNREFUSED follows the same transient path", async () => {
    // Read-only role (Lead) — Engineer phases never auto-retry an uncertain
    // spawn outcome (Task 3).
    const m = make({ roles: { lead: { targets: { primary: "p/a", fallbacks: ["p/b"] }, maxTransientRetries: 1, retryDelayMs: 1_000 } } });
    m.transport.spawnHandler = (req) =>
      req.role === "lead" && req.model === "p/a"
        ? ({ ok: false, error: "connect ECONNREFUSED 127.0.0.1:8080" } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachLeadSpawn(m);

    // Attempt 1 fails transiently at spawn time → one bounded retry.
    expect(m.controller.getState().metrics.roles.lead.retries).toBe(1);
    m.clock.advance(1_001);
    await flush();
    // Attempt 2 exhausts the retry budget → fallback attempted.
    const models = m.transport.spawned.filter((s) => s.role === "lead").map((s) => s.model);
    expect(models).toEqual(["p/a", "p/a", "p/b"]);
    expect(m.controller.getState().metrics.roles.lead.fallbacks).toBe(1);
    expect(m.controller.getState().state).toBe("DISCOVERY");
  });

  it("C. 'Model not found' stays HARD and does NOT fall back", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } } });
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "Model not found: p/a" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);
    await flush();

    expect(m.controller.getState().state).toBe("FAILED");
    const models = m.transport.spawned.filter((s) => s.role === "engineer").map((s) => s.model);
    expect(models).toEqual(["p/a"]); // no retry, no fallback
    expect(m.controller.getState().metrics.roles.engineer.retries).toBe(0);
    expect(m.controller.getState().metrics.roles.engineer.fallbacks).toBe(0);
    expect(m.controller.getState().errors[0].message).toContain("Model not found");
  });

  it("D. an auth/config error stays HARD and does NOT fall back", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } } });
    m.transport.spawnHandler = (req) =>
      req.role === "engineer"
        ? ({ ok: false, error: "401 Unauthorized: invalid API key" } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    await reachEngineerSpawn(m);
    await flush();

    expect(m.controller.getState().state).toBe("FAILED");
    expect(m.transport.spawned.filter((s) => s.role === "engineer")).toHaveLength(1);
    expect(m.controller.getState().metrics.roles.engineer.fallbacks).toBe(0);
  });
});
