/**
 * ai-factory/scenarios.test.ts — the section-29 acceptance demonstrations.
 *
 * Four runs, each with a recorded transition trace, so the final report can cite
 * reproducible evidence:
 *
 *   1. happy path  Lead → initial Architect → Engineer → Reviewer → integration
 *      → final Architect → DONE
 *   2. primary Engineer unavailable → configured fallback selected
 *   3. all Engineer targets unavailable → WAITING_CAPACITY → fake reset → resume
 *   4. final Architect rejects → one remediation → recheck rejects → STOPPED
 *
 * Every run uses the fake transport and fake clock: no pi session, no model
 * calls, no paid quota.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import type { FactoryConfig } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, RecordingStore } from "./fakes.js";

let runCounter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function make(configOverrides: Partial<FactoryConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "factory-scn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = new RecordingStore(dir);
  const config = mergeFactoryConfig(defaultFactoryConfig(), configOverrides as Record<string, unknown>);
  const controller = FactoryController.create(
    { transport, clock, store, config },
    `scn-${++runCounter}`,
    "Implement the widget",
    dir,
  );
  return { transport, clock, store, config, controller, dir };
}

const complete = (m: ReturnType<typeof make>, packet: unknown): void => m.transport.completeLastPacket(packet);
const phases = (m: ReturnType<typeof make>): string[] => m.transport.spawned.map((s) => s.phase);

describe("AI Factory — section 29 demonstrations", () => {
  it("1. happy path: exactly the six role runs, every transition deterministic", async () => {
    const m = make();
    m.controller.start();
    await flush();
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

    expect(m.store.transitions).toEqual([
      "DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION", "REVIEW", "INTEGRATION",
      "FINAL_ARCHITECT", "FINAL_SYNTHESIS", "DONE",
    ]);
    expect(phases(m)).toEqual([
      "discovery.lead", "initial.architect", "execution.engineer",
      "review.reviewer", "integration.lead", "final.architect", "final_synthesis.lead",
    ]);
    // model calls = role runs spawned (no "oracle"/relay calls)
    expect(m.controller.getState().metrics.totalAttempts).toBe(7);
    expect(m.controller.getState().state).toBe("DONE");
  });

  it("2. primary Engineer unavailable -> configured fallback selected", async () => {
    const m = make({ roles: { engineer: { targets: { primary: "p/primary", fallbacks: ["p/fallback"] } } } });
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" && req.model === "p/primary"
        ? ({ ok: false, error: "quota exhausted" } as const)
        : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    m.controller.start();
    await flush();
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    const engine = m.transport.spawned.filter((s) => s.role === "engineer");
    expect(engine.map((s) => s.model)).toEqual(["p/primary", "p/fallback"]);
    expect(m.controller.getState().metrics.roles.engineer.retries).toBe(0); // quota, not transient
    expect(m.controller.getState().metrics.roles.engineer.fallbacks).toBe(1);
    expect(m.store.transitions).toEqual(["DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION"]);
  });

  it("3. all Engineer targets unavailable -> WAITING_CAPACITY -> fake reset -> resume", async () => {
    const m = make({
      roles: { engineer: { targets: { primary: "p/a", fallbacks: ["p/b"] } } },
      defaultRetryAfterMs: 30 * 60_000,
    });
    m.transport.spawnHandler = (req) =>
      req.role === "engineer" ? ({ ok: false, error: "capacity blocked" } as const) : ({ ok: true, agentId: `agent-${Math.random()}` } as const);
    m.controller.start();
    await flush();
    complete(m, packets.proposal);
    await flush();
    complete(m, packets.approve);
    await flush();

    expect(m.controller.getState().state).toBe("WAITING_CAPACITY");
    expect(m.controller.getState().metrics.capacityWaits).toBe(1);
    expect(m.transport.spawned.filter((s) => s.role === "engineer").map((s) => s.model)).toEqual(["p/a", "p/b"]);

    // Capacity frees; the fake clock crosses nextRetryAt and the run resumes
    // from the primary — no LLM call is involved in the wake.
    m.transport.spawnHandler = (req) => ({ ok: true, agentId: `agent-${req.role}` });
    m.clock.advance(30 * 60_000 + 1);
    await flush();
    expect(m.controller.getState().state).toBe("EXECUTION");
    expect(m.transport.spawned.filter((s) => s.role === "engineer").map((s) => s.model)).toEqual(["p/a", "p/b", "p/a"]);

    // ...and the run completes normally.
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
  });

  it("4. final Architect rejection -> one remediation -> recheck rejects -> STOPPED", async () => {
    const m = make();
    m.controller.start();
    await flush();
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
    complete(m, packets.remediate); // final Architect rejects
    await flush();
    complete(m, packets.engineer); // remediation engineer
    await flush();
    complete(m, packets.reviewerPass); // remediation reviewer
    await flush();
    complete(m, packets.remediate); // recheck rejects again
    await flush();

    expect(m.store.transitions).toEqual([
      "DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION", "REVIEW", "INTEGRATION",
      "FINAL_ARCHITECT", "REMEDIATION", "FINAL_ARCHITECT_RECHECK", "STOPPED",
    ]);
    expect(m.controller.getState().state).toBe("STOPPED");
    expect(m.controller.getState().remediationRounds).toBe(1);
    // Exactly one remediation engineer/reviewer + one recheck — no loop.
    expect(m.transport.spawned.filter((s) => s.phase === "remediation.engineer")).toHaveLength(1);
    expect(m.transport.spawned.filter((s) => s.phase === "remediation.reviewer")).toHaveLength(1);
    expect(m.transport.spawned.filter((s) => s.phase === "final_recheck.architect")).toHaveLength(1);
    // The recheck Architect is told what the remediation actually changed.
    const recheck = m.transport.spawned.find((s) => s.phase === "final_recheck.architect");
    expect(recheck?.prompt).toContain("Remediation cycle");
    expect(recheck?.prompt).toContain("implemented widgets");
  });
});
