/**
 * ai-factory/panel.test.ts — the Factory run panel's deterministic core:
 * visibility-mode parsing, agent listing, focused-view target resolution, and
 * the compact orchestration summary. Pure and pi-free.
 */

import { describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import {
  collectAgents,
  describeVisibilityMode,
  FACTORY_PHASES,
  formatPanelSummary,
  parseVisibilityArg,
  resolveFocusAgentId,
  visibilityModeLabel,
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

describe("AI Factory run panel — argument parsing", () => {
  it("parses on/off/active case-insensitively", () => {
    expect(parseVisibilityArg("on")).toEqual({ kind: "all" });
    expect(parseVisibilityArg("ON")).toEqual({ kind: "all" });
    expect(parseVisibilityArg(" off ")).toEqual({ kind: "none" });
    expect(parseVisibilityArg("Active")).toEqual({ kind: "active" });
  });

  it("parses every role name case-insensitively", () => {
    for (const role of ["lead", "architect", "engineer", "reviewer"]) {
      expect(parseVisibilityArg(role)).toEqual({ kind: "role", role });
      expect(parseVisibilityArg(role.toUpperCase())).toEqual({ kind: "role", role });
    }
  });

  it("parses every exact phase, case-insensitively", () => {
    for (const phase of FACTORY_PHASES) {
      expect(parseVisibilityArg(phase), phase).toEqual({ kind: "phase", phase });
      expect(parseVisibilityArg(phase.toUpperCase()), phase).toEqual({ kind: "phase", phase });
    }
  });

  it("rejects empty and unknown arguments (invalid → help)", () => {
    expect(parseVisibilityArg("")).toBeUndefined();
    expect(parseVisibilityArg("   ")).toBeUndefined();
    expect(parseVisibilityArg("bogus")).toBeUndefined();
    // Substring phases are not accepted: /factory-verbose is exact-phase.
    expect(parseVisibilityArg("execution")).toBeUndefined();
    expect(parseVisibilityArg("agent-abc123")).toBeUndefined();
  });

  it("describes and labels each mode", () => {
    expect(describeVisibilityMode({ kind: "all" })).toContain("follows the active agent");
    expect(describeVisibilityMode({ kind: "none" })).toContain("compact progress only");
    expect(describeVisibilityMode({ kind: "active" })).toContain("running agent");
    expect(describeVisibilityMode({ kind: "role", role: "engineer" })).toContain("engineer");
    expect(describeVisibilityMode({ kind: "phase", phase: "execution.engineer" })).toContain("execution.engineer");

    expect(visibilityModeLabel({ kind: "all" })).toBe("on");
    expect(visibilityModeLabel({ kind: "none" })).toBe("off");
    expect(visibilityModeLabel({ kind: "active" })).toBe("active");
    expect(visibilityModeLabel({ kind: "role", role: "lead" })).toBe("lead");
    expect(visibilityModeLabel({ kind: "phase", phase: "review.reviewer" })).toBe("review.reviewer");
  });
});

describe("AI Factory run panel — agent listing and focused-view targeting", () => {
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

  it("active follows the in-flight agent and shows nothing when idle", () => {
    const running = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: { engineers: [], reviewers: [], proposal: { packet: packets.proposal, agentId: "l1" } },
    });
    expect(resolveFocusAgentId(running, { kind: "active" })).toBe("e1");

    const idle = makeState({ results: { engineers: [], reviewers: [], proposal: { packet: packets.proposal, agentId: "l1" } } });
    expect(resolveFocusAgentId(idle, { kind: "active" })).toBeUndefined();
  });

  it("on follows the active agent, then prefers the final report when idle", () => {
    const running = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: { engineers: [], reviewers: [], finalReport: { packet: packets.finalReport, agentId: "fr" } },
    });
    expect(resolveFocusAgentId(running, { kind: "all" })).toBe("e1");

    const idle = makeState({ results: {
      engineers: [],
      reviewers: [],
      proposal: { packet: packets.proposal, agentId: "l1" },
      finalReport: { packet: packets.finalReport, agentId: "fr" },
    } });
    expect(resolveFocusAgentId(idle, { kind: "all" })).toBe("fr");

    // Even a remediated run (whose remediation reviewer is listed after the
    // final synthesis) keeps the final report as the idle focus target.
    const remediated = makeState({ results: {
      engineers: [],
      reviewers: [],
      finalReport: { packet: packets.finalReport, agentId: "fr" },
      remediation: {
        engineer: { packet: packets.engineer, agentId: "re" },
        reviewer: { packet: packets.reviewerPass, agentId: "rr" },
      },
    } });
    expect(resolveFocusAgentId(remediated, { kind: "all" })).toBe("fr");
  });

  it("role targets the latest agent of that role, preferring the active one", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [{ round: 0, outcome: { packet: packets.reviewerPass, agentId: "r0" } }],
      },
    });
    expect(resolveFocusAgentId(state, { kind: "role", role: "engineer" })).toBe("e1");
    expect(resolveFocusAgentId(state, { kind: "role", role: "reviewer" })).toBe("r0");
    expect(resolveFocusAgentId(state, { kind: "role", role: "architect" })).toBeUndefined();
  });

  it("phase targets exactly that phase's agent", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [],
        initialArchitect: { packet: packets.approve, agentId: "a0" },
      },
    });
    expect(resolveFocusAgentId(state, { kind: "phase", phase: "execution.engineer" })).toBe("e1");
    expect(resolveFocusAgentId(state, { kind: "phase", phase: "initial.architect" })).toBe("a0");
    expect(resolveFocusAgentId(state, { kind: "phase", phase: "final_synthesis.lead" })).toBeUndefined();
  });

  it("off targets nothing (no live view)", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
    });
    expect(resolveFocusAgentId(state, { kind: "none" })).toBeUndefined();
  });
});

describe("AI Factory run panel — compact summary", () => {
  it("shows run id, state, active role/phase/model and the counters", () => {
    const state = makeState({
      state: "REVIEW",
      repairRound: 1,
      remediationRounds: 1,
      inFlight: { role: "reviewer", phase: "review.reviewer", agentId: "r1", target: "opencode-go/glm", spawnedAt: 0 },
    });
    state.metrics.totalRetries = 2;
    state.metrics.totalFallbacks = 1;
    state.metrics.capacityWaits = 3;

    const text = formatPanelSummary(state).join("\n");
    expect(text).toContain("Factory factory_r1");
    expect(text).toContain("State: REVIEW");
    expect(text).toContain("Active: reviewer — review.reviewer  opencode-go/glm");
    expect(text).toContain("Repair 1/");
    expect(text).toContain("Remediation 1/");
    expect(text).toContain("Retries 2");
    expect(text).toContain("Fallbacks 1");
    expect(text).toContain("Capacity 3");
  });

  it("reports an idle run without inventing an active agent", () => {
    const state = makeState({ state: "DONE", parked: false });
    const text = formatPanelSummary(state).join("\n");
    expect(text).toContain("State: DONE");
    expect(text).toContain("Active: none");
    expect(text).not.toContain("undefined");
  });

  it("does not list agents (the pi-subagents tree is the single agent list)", () => {
    const state = makeState({
      inFlight: { role: "engineer", phase: "execution.engineer", agentId: "e1", target: "p/e", spawnedAt: 0 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [],
      },
    });
    const text = formatPanelSummary(state).join("\n");
    // Agent ids/phases appear only inside the active line, never as a per-agent list.
    expect(text).not.toContain("discovery.lead");
    expect(text).not.toContain("initial.architect");
  });
});
