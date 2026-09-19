/**
 * ai-factory/panel.ts — Deterministic UI state and content builders for the
 * Factory run panel (the above-editor widget).
 *
 * This module is pure and pi-free so tests can drive it directly: per-agent
 * expand/collapse state, the extraction of an agent's *visible* operational
 * stream from its session, and the plain-text lines the widget renders. The TUI
 * wiring in index.ts / panel-widget.ts composes these into a widget.
 *
 * The stream deliberately mirrors what a normal Pi transcript shows (assistant
 * prose, tool calls, tool/command results) and never surfaces hidden
 * chain-of-thought/private reasoning.
 */

import type { FactoryRunState, RoleName } from "./types.js";

/** One role agent listed in the run panel. */
export interface PanelAgentView {
  id: string;
  role: RoleName;
  phase: string;
}

/**
 * Per-agent expand/collapse state, keyed by the pi-subagents agent id so two
 * agents (or two runs) never share a flag. Collapsed by default.
 */
export class FactoryPanelState {
  private readonly expanded = new Set<string>();

  isExpanded(agentId: string): boolean {
    return this.expanded.has(agentId);
  }

  toggle(agentId: string): void {
    if (this.expanded.has(agentId)) this.expanded.delete(agentId);
    else this.expanded.add(agentId);
  }

  clear(): void {
    this.expanded.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Visible operational stream                                                 */
/* -------------------------------------------------------------------------- */

/** A user-visible event from an agent's session. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "user"; text: string }
  | { kind: "toolCall"; name: string }
  | { kind: "toolResult"; text: string; elided?: number }
  | { kind: "bash"; command: string; output?: string; elided?: number };

/** The subset of an `AgentSession` message the panel reads. */
export interface StreamMessageLike {
  role: string;
  content?: unknown;
  command?: string;
  output?: unknown;
}

/** Widget cap on a single result/output block. */
const STREAM_RESULT_MAX_CHARS = 1_600;
/** Widget cap on how many expanded lines one agent may occupy. */
export const EXPANDED_MAX_LINES = 12;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

function cap(text: string): { text: string; elided: number } {
  if (text.length <= STREAM_RESULT_MAX_CHARS) return { text, elided: 0 };
  return { text: text.slice(0, STREAM_RESULT_MAX_CHARS), elided: text.length - STREAM_RESULT_MAX_CHARS };
}

/**
 * Normalize an agent session's messages into the user-visible stream: assistant
 * prose, tool calls, tool/command results. Same content the conversation viewer
 * shows, nothing else.
 */
export function extractVisibleStream(messages: readonly StreamMessageLike[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (!Array.isArray(msg.content)) continue;
      for (const raw of msg.content) {
        const part = raw as { type?: string; text?: string; name?: string; toolName?: string };
        if (part == null) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          out.push({ kind: "text", text: part.text.trim() });
        } else if (part.type === "toolCall" || part.type === "tool_use") {
          out.push({ kind: "toolCall", name: String(part.name ?? part.toolName ?? "unknown") });
        }
      }
    } else if (msg.role === "user") {
      const text = extractText(msg.content).trim();
      if (text) out.push({ kind: "user", text });
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content).trim();
      if (!text) continue;
      const capped = cap(text);
      out.push({ kind: "toolResult", text: capped.text, ...(capped.elided > 0 ? { elided: capped.elided } : {}) });
    } else if (msg.role === "bashExecution") {
      const command = typeof msg.command === "string" ? msg.command : "";
      if (!command) continue;
      const rawOutput = typeof msg.output === "string" ? msg.output : extractText(msg.output);
      const capped = cap(rawOutput.trim());
      const ev: StreamEvent = { kind: "bash", command };
      if (capped.text) {
        ev.output = capped.text;
        if (capped.elided > 0) ev.elided = capped.elided;
      }
      out.push(ev);
    }
  }
  return out;
}

/** Compact single-line rendering of one stream event. */
export function formatStreamEvent(ev: StreamEvent): string[] {
  switch (ev.kind) {
    case "text":
      return [ev.text];
    case "user":
      return [`[User] ${ev.text}`];
    case "toolCall":
      return [`[Tool] ${ev.name}`];
    case "toolResult": {
      const lines = ev.text.split("\n");
      const first = lines[0] ?? "";
      const extra = lines.length - 1;
      return [`[Result] ${first}${extra > 0 ? ` (${extra} more line${extra === 1 ? "" : "s"})` : ""}${ev.elided ? " …" : ""}`];
    }
    case "bash": {
      const lines = [`$ ${ev.command}`];
      if (ev.output) {
        const outputLines = ev.output.split("\n").slice(0, 4);
        lines.push(...outputLines);
        if (ev.elided !== undefined || ev.output.split("\n").length > outputLines.length) lines.push("…");
      }
      return lines;
    }
  }
}

/** Expanded body lines for an agent, capped so the widget stays compact. */
export function buildExpandedLines(events: readonly StreamEvent[], maxLines = EXPANDED_MAX_LINES): string[] {
  const lines: string[] = [];
  for (const ev of events) {
    for (const line of formatStreamEvent(ev)) {
      if (lines.length >= maxLines) break;
      lines.push(line);
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length === 0) lines.push("(no visible activity yet)");
  if (events.length > 0 && lines.length >= maxLines) lines.push("… (truncated)");
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Agent listing / targeting                                                   */
/* -------------------------------------------------------------------------- */

/** Every role agent the run has spawned, from the persisted results. */
export function collectAgents(state: FactoryRunState): PanelAgentView[] {
  const out = new Map<string, PanelAgentView>();
  const push = (id: string | undefined, role: RoleName, phase: string): void => {
    if (id && !out.has(id)) out.set(id, { id, role, phase });
  };
  if (state.inFlight) push(state.inFlight.agentId, state.inFlight.role, state.inFlight.phase);
  const r = state.results;
  push(r.proposal?.agentId, "lead", "discovery.lead");
  push(r.initialArchitect?.agentId, "architect", "initial.architect");
  for (const e of r.engineers) push(e.outcome.agentId, "engineer", "execution.engineer");
  for (const v of r.reviewers) push(v.outcome.agentId, "reviewer", "review.reviewer");
  push(r.integration?.agentId, "lead", "integration.lead");
  push(r.finalArchitect?.agentId, "architect", "final.architect");
  push(r.finalRecheck?.agentId, "architect", "final_recheck.architect");
  push(r.finalReport?.agentId, "lead", "final_synthesis.lead");
  const remediation = r.remediation;
  if (remediation) {
    push(remediation.engineer?.agentId, "engineer", "remediation.engineer");
    push(remediation.reviewer?.agentId, "reviewer", "remediation.reviewer");
  }
  push(r.escalationArchitect?.agentId, "architect", "escalation.architect");
  push(r.leadEscalation?.agentId, "lead", "escalation.lead");
  return [...out.values()];
}

/**
 * Resolve a user reference to a run's agent id: `active`/empty → the in-flight
 * agent; a role name → the latest agent of that role; otherwise a phase
 * substring or raw id.
 */
export function resolveAgentId(state: FactoryRunState, ref: string): string | undefined {
  const r = ref.trim().toLowerCase();
  if (r === "" || r === "active") return state.inFlight?.agentId;
  if (r === "lead" || r === "architect" || r === "engineer" || r === "reviewer") {
    const role = r as RoleName;
    if (state.inFlight?.role === role) return state.inFlight.agentId;
    const matches = collectAgents(state).filter((a) => a.role === role);
    return matches[matches.length - 1]?.id;
  }
  const agents = collectAgents(state);
  const byPhase = agents.find((a) => a.phase.toLowerCase().includes(r));
  if (byPhase) return byPhase.id;
  return agents.find((a) => a.id === ref)?.id;
}

/* -------------------------------------------------------------------------- */
/* Widget text                                                                */
/* -------------------------------------------------------------------------- */

/** Panel header lines: run id + state. */
export function formatPanelHeader(state: FactoryRunState): string[] {
  return [`Factory run ${state.runId}`, `State: ${state.state}${state.parked ? " (parked)" : ""}`];
}

/** One agent row: `▸/▾` + role — phase + optional status suffix. */
export function formatAgentRow(agent: PanelAgentView, expanded: boolean, status: string): string {
  const label = `${agent.role} — ${agent.phase}`;
  return `${expanded ? "▾" : "▸"} ${label}${status ? `  ${status}` : ""}`;
}
