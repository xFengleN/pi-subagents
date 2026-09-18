/**
 * ai-factory/metrics-report.test.ts — `/factory-metrics` aggregation.
 *
 * Totals are derived from the append-only per-call records, and a provider that
 * exposes nothing stays "n/a" — never a fabricated zero.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { buildRunMetrics, formatRunMetrics } from "../../src/ai-factory/metrics.js";
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
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config: mergeFactoryConfig(defaultFactoryConfig(), {}) },
    `met-${++runCounter}`,
    "Implement the widget",
    store.dir,
  );
  return { transport, clock, store: store.store, controller };
}

type M = ReturnType<typeof make>;

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function settle(m: M, packet: unknown, value: Usage, durationMs: number): void {
  m.transport.fireCompleted({
    agentId: m.transport.lastAgentId!,
    ok: true,
    status: "completed",
    structuredJson: JSON.stringify(packet),
    usage: value,
    durationMs,
  });
}

async function driveFullRun(m: M): Promise<void> {
  m.controller.start();
  await flush();
  settle(m, packets.proposal, usage(100, 50, 1000, 10, 0.01), 10);
  await flush();
  settle(m, packets.approve, usage(200, 20, 2000, 20, 0.02), 20);
  await flush();
  settle(m, packets.engineer, usage(300, 30, 3000, 30, 0.03), 30);
  await flush();
  settle(m, packets.reviewerPass, usage(400, 40, 4000, 40, 0.04), 40);
  await flush();
  settle(m, packets.integration, usage(500, 50, 5000, 50, 0.05), 50);
  await flush();
  settle(m, packets.accept, usage(600, 60, 6000, 60, 0.06), 60);
  await flush();
  settle(m, packets.finalReport, usage(700, 70, 7000, 70, 0.07), 70);
  await flush();
}

describe("AI Factory — /factory-metrics", () => {
  it("J. aggregates call counts, tokens, cost, context and performance correctly", async () => {
    const m = make();
    await driveFullRun(m);
    const state = m.controller.getState();
    expect(state.state).toBe("DONE");

    const report = buildRunMetrics(state);
    expect(report.legacyTelemetry).toBe(false);
    expect(report.totals.calls).toBe(7); // 7 role runs: lead x3, architect x2, engineer, reviewer
    expect(report.totals.input).toBe(2800);
    expect(report.totals.output).toBe(320);
    expect(report.totals.cacheRead).toBe(28000);
    expect(report.totals.logicalTokens).toBe(3400); // input + output + cacheWrite
    expect(report.totals.cost).toBeCloseTo(0.28);

    const lead = report.roles.find((r) => r.role === "lead");
    expect(lead?.calls).toBe(3);
    expect(lead?.input).toBe(1300); // proposal + integration + final synthesis
    expect(lead?.usageCalls).toBe(3);
    const engineer = report.roles.find((r) => r.role === "engineer");
    expect(engineer?.calls).toBe(1);
    expect(engineer?.input).toBe(300);

    // Context per call = input + cacheRead + cacheWrite.
    expect(report.context.samples).toBe(7);
    expect(report.context.largest).toBe(7770);
    expect(report.context.average).toBe(4440);
    expect(report.context.median).toBe(4440);
    expect(report.performance.medianDurationMs).toBe(40);
    expect(report.performance.slowest).toEqual({ role: "lead", phase: "final_synthesis.lead", durationMs: 70 });

    const text = formatRunMetrics(state);
    expect(text).toMatch(/Input\s+2,800/);
    expect(text).toMatch(/Cached\s+28,000/);
    expect(text).toMatch(/Output\s+320/);
    expect(text).toMatch(/Total\s+7/);
    expect(text).toContain("TTFT");
    expect(text).toContain("n/a"); // TTFT / generation are not captured
    expect(text).not.toContain("NaN");
  });

  it("K. missing provider telemetry is reported as n/a, never a fabricated zero", async () => {
    const m = make();
    m.controller.start();
    await flush();
    // The Lead settles with no usage at all (the provider exposed nothing).
    m.transport.fireCompleted({
      agentId: m.transport.lastAgentId!,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packets.proposal),
    });
    await flush();

    const state = m.controller.getState();
    const report = buildRunMetrics(state);
    expect(report.totals.input).toBeUndefined();
    expect(report.totals.cost).toBeUndefined();
    expect(report.context.samples).toBe(0);

    const text = formatRunMetrics(state);
    expect(text).toContain("n/a");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("$0.000000");
  });

  it("K2. a run without per-call records degrades to the role aggregate and says so", async () => {
    const m = make();
    m.controller.start();
    await flush();
    settle(m, packets.proposal, usage(100, 50, 1000, 10, 0.01), 10);
    await flush();

    const legacy = m.controller.getSnapshot();
    legacy.metrics.calls = undefined; // simulate a run persisted before per-call telemetry

    const report = buildRunMetrics(legacy);
    expect(report.legacyTelemetry).toBe(true);
    expect(report.totals.input).toBe(100); // the last reported call, not a fabricated total
    const text = formatRunMetrics(legacy);
    expect(text).toContain("Per-call telemetry is unavailable");
  });
});
