import { describe, expect, it } from "vitest";
import { formatFactoryReport } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig, writeProjectConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, tempStore } from "./fakes.js";

const startedAt = Date.parse("2026-09-27T00:14:32+02:00");
const finishedAt = Date.parse("2026-09-27T01:07:51+02:00");

function makeState(mode: "full" | "verified_execution" | "lean" = "full"): FactoryRunState {
  const config = defaultFactoryConfig();
  config.maxRepairRounds = 2;
  config.maxArchitectRemediationRounds = 3;
  const metrics = {
    ...emptyFactoryMetrics(startedAt),
    totalAttempts: 11,
    totalRetries: 2,
    totalFallbacks: 1,
    capacityWaits: 1,
    runEndedAt: finishedAt,
    runDurationMs: finishedAt - startedAt,
  };
  return {
    version: 3,
    runId: "factory_stats",
    createdAt: startedAt,
    updatedAt: finishedAt + 10_000,
    task: "report statistics",
    cwd: "/tmp/factory-stats",
    config,
    preset: "codex-go-balanced",
    workflow: { mode },
    state: "DONE",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 1,
    architectEscalations: 2,
    leadEscalations: 3,
    results: {
      engineers: [],
      reviewers: [],
      finalReport: { agentId: "lead", packet: {
        result: "ACCEPT", summary: "Accepted.", delivered: [], architecture: [], reviewerFindings: [],
        validation: [], commits: [], endingHead: "abc123", pushed: "no", humanVerification: [], warnings: [],
      } },
      finalArchitect: { agentId: "architect", packet: {
        verdict: "ACCEPT", blockingIssues: [], requiredChanges: [], doNotChange: [], requiredEvidence: [],
      } },
    },
    metrics,
    errors: [],
    parked: false,
    attempts: [{
      attemptId: "factory_stats:execution.engineer:1",
      role: "engineer",
      phase: "execution.engineer",
      round: 1,
      target: "provider/model",
      targetId: "T1",
      provenance: "settled_validated_packet",
      recoveryRisk: "validated_packet",
      preparedAt: startedAt,
      agentId: "engineer-1",
      packetKind: "engineer",
      packetValidated: true,
    }],
    targetPlan: {
      targets: [
        { id: "T1", description: "one", dependsOn: [], acceptanceCriteria: [] },
        { id: "T2", description: "two", dependsOn: [], acceptanceCriteria: [] },
        { id: "T3", description: "three", dependsOn: [], acceptanceCriteria: [] },
        { id: "T4", description: "four", dependsOn: [], acceptanceCriteria: [] },
      ],
      outcomes: {
        T1: { status: "passed" },
        T2: { status: "passed" },
        T3: { status: "failed" },
        T4: { status: "blocked" },
      },
      revision: 1,
      rationale: [],
    },
  };
}

describe("AI Factory final report run statistics", () => {
  it("renders persisted DONE statistics, target counts, counters and preset without inventing usage", () => {
    const report = formatFactoryReport(makeState());
    expect(report).toContain("Run statistics");
    expect(report).toContain("Started: 2026-09-26 22:14:32 +00:00");
    expect(report).toContain("Finished: 2026-09-26 23:07:51 +00:00");
    expect(report).toContain("Duration: 53m 19s");
    expect(report).toContain("Workflow: FULL");
    expect(report).toContain("Preset: codex-go-balanced");
    expect(report).toContain("Targets: 4 total · 2 passed · 1 failed · 1 blocked");
    expect(report).toContain("Agent attempts: 11");
    expect(report).toContain("Repair rounds: 1/2");
    expect(report).toContain("Remediation rounds: 1/3");
    expect(report).toContain("Retries: 2");
    expect(report).toContain("Fallbacks: 1");
    expect(report).toContain("Capacity waits: 1");
    expect(report).toContain("Lead escalations: 3");
    expect(report).toContain("Architect escalations: 2");
    expect(report).toContain("Result: DONE / ACCEPT");
    expect(report).not.toContain("Tokens");
    expect(report).not.toContain("Cost: $");
  });

  it.each(["STOPPED", "FAILED"] as const)("renders persisted statistics for %s", (terminalState) => {
    const state = makeState("lean");
    state.state = terminalState;
    state.stoppedReason = terminalState === "STOPPED" ? "repair budget exhausted" : "transport failed";
    const report = formatFactoryReport(state);
    expect(report).toContain("Run statistics");
    expect(report).toContain(`Result: ${terminalState} / ${terminalState === "FAILED" ? "runtime failure" : "not accepted"}`);
    expect(report).toContain("Workflow: LEAN");
  });

  it.each([
    ["full", "FULL"],
    ["verified_execution", "VERIFIED EXECUTION"],
    ["lean", "LEAN"],
  ] as const)("renders the persisted %s workflow identity", (mode, label) => {
    expect(formatFactoryReport(makeState(mode))).toContain(`Workflow: ${label}`);
  });

  it("includes provider usage only when every persisted attempt has that metric", () => {
    const state = makeState();
    state.metrics.totalAttempts = 1;
    state.metrics.calls = [{
      role: "lead",
      phase: "final_synthesis.lead",
      agentId: "lead-1",
      ok: true,
      input: 1_200,
      output: 300,
      cacheRead: 100,
      cost: 0.0125,
    }];
    const report = formatFactoryReport(state);
    expect(report).toContain("Input tokens: 1,200");
    expect(report).toContain("Output tokens: 300");
    expect(report).toContain("Cached tokens: 100");
    expect(report).toContain("Provider-reported cost: $0.012500");

    state.metrics.calls[0]!.input = undefined;
    expect(formatFactoryReport(state)).not.toContain("Input tokens:");
  });

  it("captures the selected preset in the persisted run snapshot", () => {
    const fixture = tempStore();
    try {
      writeProjectConfig(fixture.dir, { preset: "codex-go-balanced" });
      const controller = FactoryController.create({
        transport: new FakeTransport(),
        clock: new FakeClock(startedAt),
        store: fixture.store,
        config: defaultFactoryConfig(),
      }, "factory_preset_snapshot", "capture preset", fixture.dir);
      writeProjectConfig(fixture.dir, { preset: "changed-after-start" });
      expect(fixture.store.load("factory_preset_snapshot")?.preset).toBe("codex-go-balanced");
      controller.dispose();
    } finally {
      fixture.cleanup();
    }
  });

  it("uses persisted terminal timestamps on re-render and falls back to updatedAt for older runs", () => {
    const state = makeState("verified_execution");
    const first = formatFactoryReport(state);
    state.updatedAt += 24 * 60 * 60 * 1_000;
    const rerender = formatFactoryReport(state);
    expect(rerender).toContain("Finished: 2026-09-26 23:07:51 +00:00");
    expect(rerender).toContain("Duration: 53m 19s");
    expect(rerender.match(/Duration: 53m 19s/g)).toHaveLength(1);
    expect(rerender).toBe(formatFactoryReport(state));
    expect(first).toContain("Duration: 53m 19s");

    const legacy = makeState("full");
    legacy.metrics.runEndedAt = undefined;
    legacy.updatedAt = finishedAt;
    expect(formatFactoryReport(legacy)).toContain("Finished: 2026-09-26 23:07:51 +00:00");
  });
});
