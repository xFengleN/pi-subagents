/**
 * ai-factory/report-message.test.ts — the final report as a normal rendered
 * message at the bottom of the conversation (Problem 2).
 *
 * Covers: the Markdown form, exactly-one-once delivery, dedup on replay, and
 * that the message renderers are registered through pi's normal renderer path.
 */

import { describe, expect, it } from "vitest";
import { formatFactoryReport, formatFactoryReportMarkdown, reportFactoryCompletion } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import factoryExtension from "../../src/ai-factory/index.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { makePi } from "../helpers/boot-extension.js";
import { packets } from "./fakes.js";

function makeDoneState(runId = "factory_done"): FactoryRunState {
  const now = 1_000;
  return {
    version: 1,
    runId,
    createdAt: now,
    updatedAt: now,
    task: "t",
    cwd: "/tmp/x",
    config: defaultFactoryConfig(),
    state: "DONE",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 1,
    architectEscalations: 0,
    leadEscalations: 0,
    results: { engineers: [], reviewers: [], finalReport: { packet: packets.finalReport, agentId: "fr" } },
    metrics: { ...emptyFactoryMetrics(now), runEndedAt: now + 1_000, runDurationMs: 1_000 },
    errors: [],
    parked: false,
  };
}

describe("AI Factory — final report as a normal message", () => {
  it("7. the automatic report is Markdown; the recall formatter stays plain", () => {
    const state = makeDoneState();
    const markdown = formatFactoryReportMarkdown(state);
    expect(markdown).toContain("# Factory final report");
    expect(markdown).toContain("## Delivered");
    expect(markdown).toContain("## Commits");
    expect(markdown).toContain(packets.finalReport.summary);

    const plain = formatFactoryReport(state);
    expect(plain).not.toContain("# Factory final report");
  });

  it("6. completion appends exactly one normal final message on DONE", () => {
    const sent: Array<{ customType: string; content: string; display: boolean }> = [];
    const reported = new Set<string>();
    const state = makeDoneState();

    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, state, reported);

    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("factory-final-report");
    expect(sent[0].display).toBe(true);
    expect(sent[0].content).toContain("# Factory final report");
  });

  it("8. replayed/duplicate DONE events do not append a duplicate report", () => {
    const sent: Array<{ customType: string; content: string; display: boolean }> = [];
    const reported = new Set<string>();
    const state = makeDoneState();

    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, state, reported);
    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, state, reported);
    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, { ...state, updatedAt: 99 }, reported);

    expect(sent).toHaveLength(1);
  });

  it("non-DONE terminal states do not append a final report message", () => {
    const sent: Array<{ customType: string; content: string; display: boolean }> = [];
    const reported = new Set<string>();
    const stopped: FactoryRunState = { ...makeDoneState(), state: "STOPPED" };

    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, stopped, reported);

    expect(sent).toHaveLength(0);
  });

  it("message renderers are registered and return components (normal pi path)", () => {
    const { pi } = makePi();
    factoryExtension(pi);

    const reportRenderer = pi.registerMessageRenderer.mock.calls.find((c: unknown[]) => c[0] === "factory-final-report")?.[1];
    const metricsRenderer = pi.registerMessageRenderer.mock.calls.find((c: unknown[]) => c[0] === "factory-metrics")?.[1];
    expect(reportRenderer).toBeTypeOf("function");
    expect(metricsRenderer).toBeTypeOf("function");

    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const message = { customType: "factory-final-report", content: "# Hello\n\n- a\n- b", role: "custom", display: true, timestamp: 0 };
    const options = { expanded: false, outputPad: 0 };

    const reportComponent = reportRenderer(message, options, theme);
    expect(reportComponent).toBeTruthy();
    const metricsComponent = metricsRenderer({ ...message, customType: "factory-metrics", content: "Factory metrics\nRun: x" }, options, theme);
    expect(metricsComponent).toBeTruthy();
  });
});
