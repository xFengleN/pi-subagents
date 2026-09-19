/**
 * ai-factory/panel.test.ts — the Factory run panel's deterministic core:
 * per-agent expand/collapse state, visible-stream extraction, and agent
 * listing/targeting. Pure and pi-free.
 */

import { describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import {
  buildExpandedLines,
  collectAgents,
  extractVisibleStream,
  FactoryPanelState,
  formatAgentRow,
  resolveAgentId,
  type StreamMessageLike,
} from "../../src/ai-factory/panel.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { packets } from "./fakes.js";

function makeState(partial: Partial<FactoryRunState> = {}): FactoryRunState {
  const now = 1_000;
  return {
    version: 1,
    runId: "factory_r1",
    createdAt: now,
    updatedAt: now,
    task: "t",
    cwd: "/tmp/x",
    config: defaultFactoryConfig(),
    state: "EXECUTION",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 0,
    architectEscalations: 0,
    leadEscalations: 0,
    results: { engineers: [], reviewers: [] },
    metrics: emptyFactoryMetrics(now),
    errors: [],
    parked: false,
    ...partial,
  };
}

const stream: StreamMessageLike[] = [
  { role: "user", content: "Implement the widget" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me examine the core data model." },
      { type: "toolCall", name: "read" },
    ],
  },
  { role: "toolResult", content: [{ type: "text", text: "src/widgets.ts" }] },
  { role: "bashExecution", command: "wc -l src/widgets.ts", output: "42\n" },
];

describe("AI Factory run panel — expand/collapse state", () => {
  it("1. a newly started agent is collapsed by default", () => {
    const panel = new FactoryPanelState();
    const state = makeState({ inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 } });
    const agents = collectAgents(state);

    expect(panel.isExpanded("e1")).toBe(false);
    expect(formatAgentRow(agents[0], panel.isExpanded("e1"), "running")).toMatch(/^▸ engineer — execution\.engineer/);
  });

  it("2. expanding an agent exposes its visible stream (prose, tools, results)", () => {
    const events = extractVisibleStream(stream);
    expect(events.some((e) => e.kind === "text" && e.text.includes("Let me examine the core data model."))).toBe(true);
    expect(events.some((e) => e.kind === "toolCall" && e.name === "read")).toBe(true);
    expect(events.some((e) => e.kind === "toolResult" && e.text.includes("src/widgets.ts"))).toBe(true);
    expect(events.some((e) => e.kind === "bash" && e.command === "wc -l src/widgets.ts")).toBe(true);

    const lines = buildExpandedLines(events);
    expect(lines.join("\n")).toContain("Let me examine the core data model.");
    expect(lines.join("\n")).toContain("$ wc -l src/widgets.ts");

    const panel = new FactoryPanelState();
    panel.toggle("e1");
    expect(formatAgentRow({ id: "e1", role: "engineer", phase: "execution.engineer" }, panel.isExpanded("e1"), "running")).toMatch(/^▾ engineer/);
  });

  it("3. collapsing returns to compact without losing the transcript data", () => {
    const panel = new FactoryPanelState();
    panel.toggle("e1");
    expect(panel.isExpanded("e1")).toBe(true);

    const before = extractVisibleStream(stream).length;
    panel.toggle("e1"); // collapse
    expect(panel.isExpanded("e1")).toBe(false);
    // The session messages are untouched; re-extraction sees everything.
    expect(extractVisibleStream(stream)).toHaveLength(before);
  });

  it("4. two agents maintain independent expansion state", () => {
    const panel = new FactoryPanelState();
    panel.toggle("a");
    expect(panel.isExpanded("a")).toBe(true);
    expect(panel.isExpanded("b")).toBe(false);

    panel.toggle("b");
    expect(panel.isExpanded("a")).toBe(true);
    expect(panel.isExpanded("b")).toBe(true);

    panel.toggle("a");
    expect(panel.isExpanded("a")).toBe(false);
    expect(panel.isExpanded("b")).toBe(true);
  });

  it("5. streaming updates appear once re-extracted (live while expanded)", () => {
    const single: StreamMessageLike[] = [
      { role: "assistant", content: [{ type: "text", text: "first line" }] },
    ];
    expect(extractVisibleStream(single)).toHaveLength(1);
    // The same stable message object grows as the agent streams.
    const growing = [...single, { role: "assistant", content: [{ type: "text", text: "second line" }] }];
    const events = extractVisibleStream(growing);
    expect(events).toHaveLength(2);
    expect(buildExpandedLines(events).join("\n")).toContain("second line");
  });
});

describe("AI Factory run panel — agent listing and targeting", () => {
  it("lists agents from in-flight and persisted results with roles/phases", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [],
        integration: { packet: packets.integration, agentId: "li" },
        finalReport: { packet: packets.finalReport, agentId: "fr" },
      },
    });
    const agents = collectAgents(state);
    expect(agents.map((a) => a.id)).toEqual(["e1", "e0", "li", "fr"]);
    expect(agents.find((a) => a.id === "li")).toMatchObject({ role: "lead", phase: "integration.lead" });
    expect(agents.find((a) => a.id === "fr")).toMatchObject({ role: "lead", phase: "final_synthesis.lead" });
  });

  it("resolves refs: active, role, and phase substring", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [],
        integration: { packet: packets.integration, agentId: "li" },
      },
    });
    expect(resolveAgentId(state, "active")).toBe("e1");
    expect(resolveAgentId(state, "engineer")).toBe("e1"); // in-flight wins, else latest
    expect(resolveAgentId(state, "integration")).toBe("li");
    expect(resolveAgentId(state, "lead")).toBe("li");
    expect(resolveAgentId(state, "bogus")).toBeUndefined();
  });
});
