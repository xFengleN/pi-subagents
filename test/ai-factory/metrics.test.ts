/**
 * ai-factory/metrics.test.ts — context/cost instrumentation (spec tests 24, 25).
 *
 * Two invariants: logical token work is never conflated with billed cache
 * reads, and a metric a provider does not expose stays unknown (never a
 * fabricated 0).
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { buildRunSummary, emptyRoleMetrics, recordSettleMetrics } from "../../src/ai-factory/metrics.js";
import type { RoleMetrics } from "../../src/ai-factory/types.js";
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
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config },
    `run-${++runCounter}`,
    "T",
    store.dir,
  );
  return { transport, clock, store: store.store, config, controller };
}

describe("AI Factory — metrics", () => {
  it("24. Metrics distinguish normal input/output from cache-read usage", async () => {
    const m = make();
    m.controller.start();
    await flush();
    // Lead settles with full usage including cacheRead and cost.
    m.transport.fireCompleted({
      agentId: m.transport.lastAgentId!,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packets.proposal),
      usage: { input: 100, output: 50, cacheRead: 40_000, cacheWrite: 10, totalTokens: 40_160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
      tokens: { input: 100, output: 50, total: 160 },
    });
    await flush();

    const lead = m.controller.getState().metrics.roles.lead;
    expect(lead.input).toBe(100);
    expect(lead.output).toBe(50);
    // Logical work = input+output+cacheWrite, EXCLUDING cacheRead.
    expect(lead.logicalTokens).toBe(160);
    // Cache reads are reported separately, never folded into logical work.
    expect(lead.cacheRead).toBe(40_000);
    expect(lead.cost).toBe(0.02);
  });

  it("25. Unknown usage fields remain unknown rather than being silently zeroed", async () => {
    const m = make();
    m.controller.start();
    await flush();
    // The lead settles with NO usage at all (provider exposed nothing).
    m.transport.fireCompleted({
      agentId: m.transport.lastAgentId!,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packets.proposal),
    });
    await flush();

    const lead = m.controller.getState().metrics.roles.lead;
    expect(lead.input).toBeUndefined();
    expect(lead.output).toBeUndefined();
    expect(lead.logicalTokens).toBeUndefined();
    expect(lead.cacheRead).toBeUndefined();
    expect(lead.cost).toBeUndefined();

    // The run summary omits them too — no fabricated zeros.
    const summary = buildRunSummary(m.controller.getState());
    const leadSummary = summary.roles.lead;
    expect(leadSummary?.input).toBeUndefined();
    expect(leadSummary?.logicalTokens).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('"cacheRead":0');
  });

  it("recordSettleMetrics keeps model info and status when present", () => {
    const m: RoleMetrics = emptyRoleMetrics("reviewer");
    recordSettleMetrics(m, {
      ok: true,
      status: "completed",
      modelName: "gpt-5.5",
      modelId: "gpt-5.5",
      toolUses: 12,
      compactionCount: 1,
      durationMs: 3000,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    expect(m.status).toBe("completed");
    expect(m.modelName).toBe("gpt-5.5");
    expect(m.toolUses).toBe(12);
    expect(m.compactionCount).toBe(1);
    expect(m.durationMs).toBe(3000);
    expect(m.logicalTokens).toBe(7); // 1+2+4
    expect(m.cacheRead).toBe(3);
  });
});
