/**
 * ai-factory/panel.ts — Deterministic helpers for the Factory run panel.
 *
 * Pure and pi-free. It owns the visibility-mode vocabulary, the target
 * resolution used by the focused live view, agent listing, and the compact
 * orchestration summary the above-editor widget renders.
 *
 * The live agent transcript is deliberately NOT built here: the widget is a
 * tiny, non-scrollable, non-interactive surface, so detail lives in the focused
 * viewer in `live-view.ts`, which reuses pi-subagents' own ConversationViewer.
 * That is why there is no transcript extraction or line-bounding in this module
 * any more — the summary is a fixed few lines.
 */

import { type FactoryRunState, ROLE_NAMES, type RoleName } from "./types.js";

/** One role agent listed in the run panel. */
export interface PanelAgentView {
  id: string;
  role: RoleName;
  phase: string;
}

/**
 * The run panel's visibility mode — the single state system that decides which
 * agent's activity the focused live view shows. Deliberately separate from
 * Factory configuration and from persisted run data: it is UI-only and
 * session-scoped, and it never affects execution.
 *
 *   all      — `/factory-verbose on` — follow the active agent; when idle, the
 *              most recent accepted/finished agent.
 *   none     — `/factory-verbose off` — compact progress only; no live view.
 *   active   — `/factory-verbose active` — only the currently running agent.
 *   role     — `/factory-verbose lead|architect|engineer|reviewer` — the latest
 *              agent of that role.
 *   phase    — `/factory-verbose <exact-phase>` — that phase's agent.
 */
export type VisibilityMode =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "active" }
  | { kind: "role"; role: RoleName }
  | { kind: "phase"; phase: string };

/** The development/validation default: follow the active agent. */
export const DEFAULT_VISIBILITY_MODE: VisibilityMode = { kind: "all" };

/**
 * Every exact phase a Factory run may spawn, in canonical form. `/factory-verbose`
 * accepts one of these (case-insensitively); anything else is an invalid argument.
 */
export const FACTORY_PHASES: readonly string[] = [
  "discovery.lead",
  "initial.architect",
  "execution.engineer",
  "review.reviewer",
  "integration.lead",
  "final.architect",
  "final_recheck.architect",
  "final_synthesis.lead",
  "remediation.engineer",
  "remediation.reviewer",
  "escalation.architect",
  "escalation.lead",
];

/**
 * Parse a `/factory-verbose` argument into a mode. Case-insensitive. Returns
 * `undefined` for an empty or unrecognised argument, which callers render as
 * help — never as a mode.
 */
export function parseVisibilityArg(ref: string): VisibilityMode | undefined {
  const r = ref.trim().toLowerCase();
  if (r === "on") return { kind: "all" };
  if (r === "off") return { kind: "none" };
  if (r === "active") return { kind: "active" };
  if ((ROLE_NAMES as readonly string[]).includes(r)) return { kind: "role", role: r as RoleName };
  if (FACTORY_PHASES.includes(r)) return { kind: "phase", phase: r };
  return undefined;
}

/** A short human-readable label for a visibility mode. */
export function describeVisibilityMode(mode: VisibilityMode): string {
  switch (mode.kind) {
    case "all": return "on — detail follows the active agent";
    case "none": return "off — compact progress only";
    case "active": return "active — only the running agent";
    case "role": return `role — only ${mode.role} agents`;
    case "phase": return `phase — only the ${mode.phase} agent`;
  }
}

/** The compact label the panel hint shows, e.g. `on`, `active`, `engineer`. */
export function visibilityModeLabel(mode: VisibilityMode): string {
  switch (mode.kind) {
    case "all": return "on";
    case "none": return "off";
    case "active": return "active";
    case "role": return mode.role;
    case "phase": return mode.phase;
  }
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
 * The agent the focused live view should currently show for a mode, or
 * `undefined` when nothing matches yet (e.g. the phase has not spawned). The
 * live view re-resolves this on a timer, so `active`/`on` follow the run as
 * phases change and a not-yet-spawned role/phase target appears when it does.
 */
export function resolveFocusAgentId(state: FactoryRunState, mode: VisibilityMode): string | undefined {
  const agents = collectAgents(state);
  const activeId = state.inFlight?.agentId;
  switch (mode.kind) {
    case "none":
      return undefined;
    case "active":
      return activeId;
    case "all":
      if (activeId) return activeId;
      // Idle: prefer the final synthesis (the accepted run's newest artifact),
      // else the last listed agent.
      return state.results.finalReport?.agentId ?? agents[agents.length - 1]?.id;
    case "role": {
      if (state.inFlight?.role === mode.role) return activeId;
      const matches = agents.filter((a) => a.role === mode.role);
      return matches[matches.length - 1]?.id;
    }
    case "phase": {
      if (state.inFlight?.phase === mode.phase) return activeId;
      const matches = agents.filter((a) => a.phase === mode.phase);
      return matches[matches.length - 1]?.id;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Widget text                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The compact orchestration summary the above-editor widget shows: run id,
 * state, the active role/phase/model and the orchestration counters. It
 * intentionally lists no agents and renders no transcript — pi-subagents' own
 * agent tree is the single agent list, and the live transcript lives in the
 * focused viewer.
 */
export function formatPanelSummary(state: FactoryRunState): string[] {
  const m = state.metrics;
  const active = state.inFlight;
  return [
    `Factory ${state.runId}`,
    `State: ${state.state}${state.parked ? " (parked)" : ""}`,
    active
      ? `Active: ${active.role} — ${active.phase}${active.target ? `  ${active.target}` : ""}`
      : "Active: none",
    `Repair ${state.repairRound}/${state.config.maxRepairRounds} · `
      + `Remediation ${state.remediationRounds}/${state.config.maxArchitectRemediationRounds} · `
      + `Retries ${m.totalRetries} · Fallbacks ${m.totalFallbacks} · Capacity ${m.capacityWaits}`,
  ];
}
