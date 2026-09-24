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
import { packets, tempStore } from "./fakes.js";

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

  it("STOPPED appends an evidence-based report without changing the terminal state or verdict", () => {
    const sent: Array<{ customType: string; content: string; display: boolean }> = [];
    const reported = new Set<string>();
    const stopped: FactoryRunState = {
      ...makeDoneState(),
      state: "STOPPED",
      stoppedReason: "remediation budget exhausted",
      results: {
        engineers: [],
        reviewers: [],
        finalArchitect: { packet: packets.remediate, agentId: "fa" },
        finalRecheck: { packet: packets.remediate, agentId: "fr" },
      },
    };

    reportFactoryCompletion({ sendMessage: (m) => sent.push(m) }, stopped, reported);

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain("Terminal state: STOPPED");
    expect(sent[0].content).toContain("Authoritative final verdict: NEEDS_REMEDIATION");
    expect(sent[0].content).toContain("controlled stop (not a runtime crash)");
    expect(stopped.state).toBe("STOPPED");
    expect(stopped.results.finalRecheck?.packet.verdict).toBe("NEEDS_REMEDIATION");
  });

  it("durable delivery evidence prevents a duplicate after process-local state is lost", () => {
    const fixture = tempStore();
    try {
      const state = makeDoneState("factory_durable_report");
      state.cwd = fixture.dir;
      fixture.store.prepareReportDelivery(state.runId, 1_000);
      const first: Array<{ customType: string; content: string; display: boolean }> = [];
      reportFactoryCompletion({ sendMessage: (m) => first.push(m) }, state, new Set(), fixture.store);
      expect(first).toHaveLength(1);
      expect(fixture.store.hasDeliveredReport(state.runId)).toBe(true);

      const afterRestart: typeof first = [];
      reportFactoryCompletion({ sendMessage: (m) => afterRestart.push(m) }, state, new Set(), fixture.store);
      expect(afterRestart).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("an early controlled stop renders limited evidence instead of inventing results", () => {
    const state: FactoryRunState = {
      ...makeDoneState("factory_early_stop"),
      state: "STOPPED",
      remediationRounds: 0,
      results: { engineers: [], reviewers: [] },
      metrics: emptyFactoryMetrics(1_000),
      stoppedReason: "Stopped via /factory-stop",
    };

    const report = formatFactoryReport(state);
    expect(report).toContain("Authoritative final verdict: not available");
    expect(report).toContain("Failed gate: no final acceptance gate was reached");
    expect(report).toContain("Stopped via /factory-stop");
    expect(report).not.toContain("Delivered\n");
    expect(report).not.toContain("npm test: pass");
  });

  it("a rejecting recheck reports completed remediation after historical integration", () => {
    const state: FactoryRunState = {
      ...makeDoneState("factory_remediated_stop"),
      state: "STOPPED",
      results: {
        engineers: [],
        reviewers: [],
        integration: { packet: { ...packets.integration, factualAssessment: "No product implementation exists" }, agentId: "lead" },
        finalArchitect: { packet: packets.remediate, agentId: "fa" },
        remediation: {
          engineer: { packet: { ...packets.engineer, summary: "Implemented the inspector", changedFiles: ["Inspector.swift"] }, agentId: "eng" },
          reviewer: { packet: packets.reviewerPass, agentId: "rev" },
        },
        finalRecheck: { packet: packets.remediate, agentId: "fr" },
      },
    };

    const report = formatFactoryReport(state);
    expect(report).toContain("Historical integration (before remediation; not current workspace evidence)");
    expect(report).toContain("Latest remediation implementation (not mission acceptance)");
    expect(report).toContain("Implemented the inspector");
    expect(report).toContain("Inspector.swift");
    expect(report).toContain("No product implementation exists");
    expect(report.indexOf("No product implementation exists")).toBeLessThan(report.indexOf("Implemented the inspector"));
    expect(report).toContain("Authoritative final verdict: NEEDS_REMEDIATION");
  });

  it("a later rejecting recheck supersedes an earlier accepted synthesis", () => {
    const state: FactoryRunState = {
      ...makeDoneState("factory_superseded"),
      state: "STOPPED",
      results: {
        engineers: [],
        reviewers: [],
        finalArchitect: { packet: packets.accept, agentId: "fa" },
        finalRecheck: { packet: packets.remediate, agentId: "fr" },
        finalReport: { packet: packets.finalReport, agentId: "stale-report" },
      },
    };

    const report = formatFactoryReport(state);
    expect(report).toContain("Authoritative final verdict: NEEDS_REMEDIATION");
    expect(report).toContain("Authoritative source: Final Architect recheck");
    expect(report).toContain("Superseded artifacts (historical evidence only)");
    expect(report).not.toContain(packets.finalReport.summary);
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
