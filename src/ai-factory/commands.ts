/**
 * ai-factory/commands.ts — Slash-command UX for the AI Factory.
 *
 * These commands let a user start, inspect, stop and configure Factory directly
 * from Pi's command line, with no reliance on the currently selected main model
 * deciding to call the `Factory` tool. Dispatch, status, stop and every config
 * edit are deterministic: no model is invoked by any of them. Only `/factory`
 * starts a run (which then spawns role agents through the existing controller).
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { configRevision, loadFactoryConfig, validateFactoryConfig } from "./config.js";
import { type ConfigUI, filterModels, type MenuRow, type ModelOption, showFactoryConfigUI } from "./config-ui.js";
import type { FactoryController } from "./controller.js";
import { formatDuration, formatRunMetrics } from "./metrics.js";
import { parseVisibilityArg, type VisibilityMode } from "./panel.js";
import type { RecoveryPlan } from "./recovery-model.js";
import { assessRecoveryEligibility, isTerminal } from "./state.js";
import { FACTORY_DIR } from "./store.js";
import {
  type ArchitectFinalResult,
  type FactoryRunState,
  type FactoryTargetPlan,
  type LeadIntegrationPacket,
  ROLE_NAMES,
  type RoleName,
} from "./types.js";

function targetDisplayStatus(plan: FactoryTargetPlan, id: string): string {
  if (!plan.revalidationIds?.includes(id)) return plan.outcomes[id].status;
  return plan.currentTargetId === id ? "revalidating" : "awaiting revalidation";
}

/** Display outcome of `/factory-resume` (read-only inspection or execution). */
export interface FactoryResumeOutcome {
  kind: "ok" | "preview" | "approvalRequired" | "blocked" | "terminal" | "notFound" | "locked" | "invalidPreset" | "staleApproval" | "duplicate";
  text: string;
  /** Preview only: whether explicit approval is required before continuing. */
  requiresApproval?: boolean;
  /** Preview only: the checkpoint-bound approval token. */
  checkpointId?: string;
}

/** A concise, read-only recovery preview for an interrupted run. */
export function formatResumePreview(
  state: FactoryRunState,
  plan: RecoveryPlan,
  replacementPreset?: string,
  modelWarnings: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`Factory run ${state.runId}`);
  lines.push(`state: ${state.state}${state.parked ? " (parked)" : ""}  phase: ${plan.phase}`);
  const r = state.results;
  const done: string[] = [];
  if (r.proposal) done.push("proposal");
  if (r.initialArchitect) done.push("initial architect");
  if (r.engineers.length > 0) done.push(`engineer (${r.engineers.length} round${r.engineers.length > 1 ? "s" : ""})`);
  if (r.reviewers.length > 0) done.push(`reviewer (${r.reviewers.length} round${r.reviewers.length > 1 ? "s" : ""})`);
  if (r.integration) done.push("integration");
  if (r.finalArchitect) done.push("final architect");
  if (r.finalRecheck) done.push("final recheck");
  if (r.finalReport) done.push("final report");
  if (r.escalationArchitect) done.push("architect escalation");
  if (r.leadEscalation) done.push("lead escalation");
  if (r.remediation?.engineer) done.push("remediation engineer");
  if (r.remediation?.reviewer) done.push("remediation reviewer");
  lines.push(`completed: ${done.length > 0 ? done.join(", ") : "none"}`);
  if (state.targetPlan) lines.push(`targets: ${state.targetPlan.targets.map((target) => `${target.id}=${targetDisplayStatus(state.targetPlan!, target.id)}`).join(", ")}; active: ${state.targetPlan.currentTargetId ?? "none"}`);
  const decision = plan.decision === "automatic"
    ? "safe automatic continuation"
    : plan.decision === "approval_required"
      ? "approval required (workspace-risking recovery)"
      : "blocked";
  lines.push(`next action: ${decision}`);
  lines.push(`recovery checkpoint: ${state.checkpoint?.id ?? "(none)"}`);
  lines.push(`approval token: ${assessRecoveryEligibility(state).checkpointId}`);
  lines.push(`config revision: ${state.presetReplacement?.snapshot ? configRevision(state.presetReplacement.snapshot) : configRevision(state.config)}`);
  if (state.presetReplacement) lines.push(`replacement applied: ${state.presetReplacement.preset} (revision ${state.presetReplacement.revision})`);
  if (replacementPreset !== undefined) lines.push(`replacement preset requested: ${replacementPreset}`);
  if (modelWarnings.length > 0) lines.push(`model warnings: ${modelWarnings.join("; ")}`);
  lines.push(`reason: ${plan.reason}`);
  return lines.join("\n");
}

export interface FactoryRunListItem {
  runId: string;
  state: FactoryRunState["state"];
  updatedAt: number;
  /** Present when a role agent is currently in flight. */
  role?: RoleName;
  phase?: string;
}

/**
 * The seam between the commands and the extension's run management. Tests can
 * supply a fake runtime to exercise command dispatch without pi-subagents.
 */
export interface FactoryCommandRuntime {
  /** True when pi-subagents is present and bound (probes if the ready event was missed). */
  isAvailable(): Promise<boolean>;
  /** Start a run and return its id and controller. */
  launch(cwd: string, task: string): { id: string; controller: FactoryController };
  /** Read a run's state WITHOUT resuming or driving it (no model requests). */
  peekState(runId: string, cwd: string): FactoryRunState | undefined;
  /** Persisted runs for a project, newest first. */
  listRuns(cwd: string): FactoryRunListItem[];
  /** Stop a run; restores without resuming when it is not in-process. */
  stop(runId: string, cwd: string): boolean;
  /**
   * Inspect and/or resume an interrupted run. With `dryRun` the persisted state
   * is only read (no lease, no controller, no drive); otherwise ownership is
   * acquired, the checkpoint revalidated, and the run continues from the next
   * unfinished action. Returns a displayable outcome.
   */
  resume(runId: string, cwd: string, opts: {
    preset?: string;
    dryRun?: boolean;
    approval?: boolean;
    checkpointId?: string;
    availableModels?: string[];
  }): FactoryResumeOutcome;
  /** Register/refresh the Factory run panel widget for this session. */
  showRunPanel(ctx: ExtensionCommandContext, runId: string): void;
  /** Apply a visibility mode to the run panel (session-wide); returns a status message. */
  setVisibility(mode: VisibilityMode): string;
  /** Describe the currently active visibility mode. */
  visibilityStatus(): string;
  /** Open the focused live agent view for a mode; resolves when it is closed. */
  openFocusView(ctx: ExtensionCommandContext, mode: VisibilityMode): Promise<void>;
  /** Append the terminal report to the conversation (deduplicated). */
  reportCompletion(state: FactoryRunState): void;
}

/** Available model ids as `provider/model`, from Pi's registry. */
function availableModels(ctx: ExtensionContext): string[] {
  try {
    return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}

/**
 * Compact, deterministic status block for `/factory-status`.
 *
 * This is HISTORICAL / current-run state — the models a run actually used — not
 * the configuration the next run will use. The labels make that explicit.
 *
 * It stays compact by design: it summarises a completed run but never prints the
 * final report itself. Use `/factory-report` for that.
 */
export function formatRunStatus(state: FactoryRunState): string {
  const m = state.metrics;
  const terminal = isTerminal(state.state);
  const finalReport = state.results.finalReport?.packet;
  const architectOutcome = state.results.finalRecheck?.packet ?? state.results.finalArchitect?.packet;
  const currentFinalReport = state.state === "DONE" && architectOutcome?.verdict !== "NEEDS_REMEDIATION" ? finalReport : undefined;
  const lines: string[] = [];
  if (terminal) {
    const verdict = architectOutcome?.verdict
      ?? currentFinalReport?.result
      ?? state.stoppedReason
      ?? "-";
    lines.push(`Latest completed run: ${state.runId}`);
    lines.push(`state: ${state.state}`);
    lines.push(`result: ${verdict}`);
    if (m.runDurationMs !== undefined) lines.push(`duration: ${formatDuration(m.runDurationMs)}`);
  } else {
    lines.push(`Current run: ${state.runId}`);
    lines.push(`state: ${state.state}${state.parked ? " (parked)" : ""}`);
    lines.push(`phase: ${state.inFlight?.phase ?? "-"}   active role: ${state.inFlight?.role ?? "-"}`);
    lines.push(`active model: ${state.inFlight?.target ?? "-"}`);
    if (m.runStartedAt > 0) lines.push(`elapsed: ${formatDuration(Math.max(0, Date.now() - m.runStartedAt))}`);
  }
  lines.push(`repairRound: ${state.repairRound}   remediationRounds: ${state.remediationRounds}`);
  if (state.targetPlan) lines.push(`targets: ${state.targetPlan.targets.map((target) => `${target.id}=${targetDisplayStatus(state.targetPlan!, target.id)}`).join(", ")}`);
  lines.push(`retries: ${m.totalRetries}   fallbacks: ${m.totalFallbacks}   capacityWaits: ${m.capacityWaits}`);
  if (terminal) {
    const head = currentFinalReport?.endingHead ?? "-";
    const commits = currentFinalReport ? currentFinalReport.commits.length : "-";
    const validation = currentFinalReport?.validation[0] ?? state.results.integration?.packet.systemVerification ?? "-";
    const pending = currentFinalReport?.humanVerification.length ?? 0;
    lines.push(`final HEAD: ${head}   commits: ${commits}`);
    lines.push(`validation: ${validation}`);
    lines.push(`human verification: ${pending > 0 ? `PENDING (${pending})` : "none recorded"}`);
  }
  lines.push("Run configuration snapshot (models THIS run used — not the next run's config):");
  lines.push(...ROLE_NAMES.map((role) => `  ${role}: ${m.roles[role].targetUsed ?? "-"}`));
  lines.push(`updated: ${new Date(state.updatedAt).toISOString()}`);
  const lastError = state.errors[state.errors.length - 1];
  if (lastError) lines.push(`last error: ${lastError.message}`);
  if (state.stoppedReason) lines.push(`stopped: ${state.stoppedReason}`);
  lines.push("Use /factory-config to view the configuration for the next run.");
  return lines.join("\n");
}

function section(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push("");
  lines.push(title);
  for (const item of items) lines.push(`- ${item}`);
}

/**
 * A legacy view: the authoritative result/source for the header plus the body.
 * Used only when `results.finalReport` is absent (the run predates the final
 * Lead synthesis).
 */
interface LegacyReportView {
  result: string;
  source: string;
  body: string[];
}

/** The Architect gate that actually accepted the run, if any. A recheck always
 * outranks the initial final gate because it is the later decision. */
interface AcceptedGate {
  packet: ArchitectFinalResult;
  label: "Final Architect recheck" | "Final Architect";
}

interface AuthoritativeArchitectOutcome {
  packet: ArchitectFinalResult;
  label: "Final Architect recheck" | "Final Architect";
}

/** The latest Architect acceptance decision always wins, including rejection. */
function authoritativeArchitectOutcome(state: FactoryRunState): AuthoritativeArchitectOutcome | undefined {
  const recheck = state.results.finalRecheck?.packet;
  if (recheck) return { packet: recheck, label: "Final Architect recheck" };
  const finalGate = state.results.finalArchitect?.packet;
  if (finalGate) return { packet: finalGate, label: "Final Architect" };
  return undefined;
}

function acceptedGate(state: FactoryRunState): AcceptedGate | undefined {
  const outcome = authoritativeArchitectOutcome(state);
  return outcome?.packet.verdict === "ACCEPT" ? outcome : undefined;
}

/** Short history for a run accepted only after remediation. Empty when no
 * remediation cycle is recorded. The pre-remediation integration is NOT
 * accepted, and is never rendered as the final outcome. */
function remediationHistory(state: FactoryRunState): string[] {
  const recheck = state.results.finalRecheck?.packet;
  const remediation = state.results.remediation;
  if (!recheck && !remediation) return [];
  const lines = ["Remediation history"];
  if (state.results.integration) lines.push("- Initial integration: NOT ACCEPTED");
  if (remediation) {
    lines.push("- Remediation completed");
    if (remediation.reviewer) lines.push(`- Reviewer: ${remediation.reviewer.packet.verdict}`);
  }
  if (recheck) lines.push(`- Final Architect recheck: ${recheck.verdict}`);
  return lines;
}

/** Concise rendering of the accepted Architect gate packet. */
function renderGateEvidence(gate: AcceptedGate): string[] {
  const lines = ["Final accepted evidence", `${gate.label}: ${gate.packet.verdict}`];
  for (const issue of gate.packet.blockingIssues) lines.push(`- Blocking issue: ${issue}`);
  for (const change of gate.packet.requiredChanges) lines.push(`- Required change: ${change}`);
  for (const item of gate.packet.doNotChange) lines.push(`- Do not change: ${item}`);
  for (const item of gate.packet.requiredEvidence) lines.push(`- Required evidence: ${item}`);
  return lines;
}

/** An integration artifact treated as accepted only when no gate rejected it. */
function renderAcceptedIntegration(integration: LeadIntegrationPacket): string[] {
  const lines = ["Final accepted evidence", "Accepted integration"];
  lines.push(`- System verification: ${integration.systemVerification}`);
  lines.push(`- Factual assessment: ${integration.factualAssessment}`);
  for (const finding of integration.reviewerFindingsUnresolved) lines.push(`- Unresolved reviewer finding: ${finding}`);
  return lines;
}

/** No accepted final artifact: show the latest result and label it rejected. */
function renderUnacceptedEvidence(state: FactoryRunState): string[] {
  const integration = state.results.integration?.packet;
  const authoritative = authoritativeArchitectOutcome(state);
  const lines = [`Run state: ${state.state}`, "No accepted final artifact exists for this run."];
  if (integration) {
    lines.push("");
    lines.push(state.results.remediation
      ? "Historical integration (before remediation; not current workspace evidence)"
      : "Latest integration (NOT accepted)");
    lines.push(`- System verification: ${integration.systemVerification}`);
    lines.push(`- Factual assessment: ${integration.factualAssessment}`);
    for (const finding of integration.reviewerFindingsUnresolved) lines.push(`- Unresolved reviewer finding: ${finding}`);
  }
  if (authoritative) {
    lines.push("");
    lines.push(`${authoritative.label} verdict: ${authoritative.packet.verdict}`);
    for (const issue of authoritative.packet.blockingIssues) lines.push(`- Blocking issue: ${issue}`);
    for (const change of authoritative.packet.requiredChanges) lines.push(`- Required change: ${change}`);
  }
  return lines;
}

/**
 * Legacy fallback precedence:
 *   1. a final recheck/final-Architect ACCEPT is authoritative (later packet
 *      wins, and the pre-remediation integration is only history);
 *   2. otherwise a `DONE` run with an integration artifact uses that artifact;
 *   3. otherwise the run has no accepted artifact and is labelled rejected.
 */
function legacyReportView(state: FactoryRunState): LegacyReportView {
  const gate = acceptedGate(state);
  if (gate) {
    const body: string[] = [];
    const history = remediationHistory(state);
    if (history.length > 0) {
      body.push(...history);
      body.push("");
    }
    body.push(...renderGateEvidence(gate));
    if (state.results.finalRecheck) {
      body.push("");
      body.push("No post-remediation Lead synthesis exists for this historical run.");
    }
    return { result: gate.packet.verdict, source: `LEGACY FALLBACK — ${gate.label}`, body };
  }

  const integration = state.results.integration?.packet;
  if (integration && state.state === "DONE") {
    return {
      result: "ACCEPT",
      source: "LEGACY FALLBACK — accepted integration",
      body: renderAcceptedIntegration(integration),
    };
  }

  return {
    result: "NOT ACCEPTED",
    source: "LEGACY FALLBACK — no accepted final artifact",
    body: renderUnacceptedEvidence(state),
  };
}

/**
 * The single human-facing final report. `/factory-report` and the automatic
 * post-run rendering both print this, so there is no second, divergent summary.
 *
 * Uses the persisted `results.finalReport` when present; for a run that predates
 * it, falls back (clearly labelled) to the accepted Architect/integration
 * artifacts.
 */
export function formatFactoryReport(state: FactoryRunState): string {
  const finalReport = state.results.finalReport?.packet;
  const authoritative = authoritativeArchitectOutcome(state);
  const finalReportIsCurrent = finalReport !== undefined
    && state.state === "DONE"
    && authoritative?.packet.verdict !== "NEEDS_REMEDIATION";
  const legacy = finalReportIsCurrent ? undefined : legacyReportView(state);
  const lines: string[] = ["Factory final report", `Run: ${state.runId}`, `Terminal state: ${state.state}`];

  if (state.state === "STOPPED") lines.push("Terminal classification: controlled stop (not a runtime crash)");
  else if (state.state === "FAILED") lines.push("Terminal classification: unrecoverable/runtime failure (not an acceptance verdict)");
  else if (state.state === "DONE") lines.push("Terminal classification: completed accepted run");

  if (finalReportIsCurrent) {
    lines.push(`Result: ${finalReport.result}`);
  } else {
    lines.push(`Result: ${legacy!.result}`);
    lines.push(`Source: ${legacy!.source}`);
  }
  if (authoritative) {
    lines.push(`Authoritative final verdict: ${authoritative.packet.verdict}`);
    lines.push(`Authoritative source: ${authoritative.label}`);
  } else {
    lines.push("Authoritative final verdict: not available");
  }
  if (state.metrics.runDurationMs !== undefined) lines.push(`Duration: ${formatDuration(state.metrics.runDurationMs)}`);
  lines.push(`Remediation rounds: ${state.remediationRounds}`);
  lines.push(
    `Counters: repair ${state.repairRound}/${state.config.maxRepairRounds}; remediation ${state.remediationRounds}/${state.config.maxArchitectRemediationRounds}; `
    + `architect escalations ${state.architectEscalations}/${state.config.maxArchitectEscalations}; lead escalations ${state.leadEscalations}/${state.config.maxLeadEscalations}; `
    + `attempts ${state.metrics.totalAttempts}; retries ${state.metrics.totalRetries}; fallbacks ${state.metrics.totalFallbacks}; capacity waits ${state.metrics.capacityWaits}`,
  );

  if (state.state === "STOPPED") {
    lines.push(`Stop reason: ${controlledStopReason(state)}`);
    lines.push(`Failed gate: ${authoritative ? `${authoritative.label} (${authoritative.packet.verdict})` : "no final acceptance gate was reached"}`);
  } else if (state.state === "FAILED") {
    lines.push(`Failure reason: ${state.stoppedReason ?? state.errors[state.errors.length - 1]?.message ?? "No failure reason was persisted."}`);
  }

  if (finalReportIsCurrent) {
    if (finalReport.summary.trim() !== "") {
      lines.push("");
      lines.push(finalReport.summary.trim());
    }
    section(lines, "Delivered", finalReport.delivered);
    section(lines, "Architecture / decisions", finalReport.architecture);
    section(lines, "Reviewer findings", finalReport.reviewerFindings);
    section(lines, "Validation", finalReport.validation);
    section(lines, "Commits", finalReport.commits);
    if (finalReport.endingHead) lines.push(`Ending HEAD: ${finalReport.endingHead}`);
    if (finalReport.pushed) lines.push(`Pushed: ${finalReport.pushed}`);
    section(lines, "Human verification (pending)", finalReport.humanVerification);
    section(lines, "Warnings / limitations", finalReport.warnings);
  } else {
    lines.push("");
    lines.push(...legacy!.body);
    renderTerminalEvidence(lines, state, finalReport !== undefined);
  }

  if (state.targetPlan && isTerminal(state.state)) {
    const plan = state.targetPlan;
    const counts = { passed: 0, failed: 0, blocked: 0, pending: 0, active: 0, revalidation: 0 };
    for (const target of plan.targets) {
      if (plan.revalidationIds?.includes(target.id)) counts.revalidation++;
      else counts[plan.outcomes[target.id].status]++;
    }
    section(lines, "Target outcomes (packet evidence; not a workspace snapshot)", [
      `Proposed: ${plan.targets.length}; completed and reviewed: ${counts.passed}; failed: ${counts.failed}; blocked: ${counts.blocked}; not attempted: ${counts.pending}; in progress: ${counts.active}; awaiting revalidation: ${counts.revalidation}`,
      ...plan.targets.map((target) => {
        const outcome = plan.outcomes[target.id];
        const engineer = state.results.engineers.find((item) => item.outcome.agentId === outcome.engineerAgentId)?.outcome.packet;
        const evidence = outcome.status === "passed" && !plan.revalidationIds?.includes(target.id) ? `; Reviewer PASS ${outcome.reviewerAgentId}; ${outcome.architectAgentId ? `package Architect acceptance ${outcome.architectAgentId}` : "no separate package Architect acceptance"}` : "";
        return `${target.id}: ${targetDisplayStatus(plan, target.id)}${evidence}${outcome.reason ? `; ${outcome.reason}` : ""}${outcome.blockedBy?.length ? `; blocked by ${outcome.blockedBy.join(", ")}` : ""}${engineer?.changedFiles.length ? `; Engineer-reported artifacts: ${engineer.changedFiles.join(", ")}` : ""}`;
      }),
      "Repository contents and post-run edits have not been independently verified by this report.",
    ]);
  }

  if (state.state === "STOPPED") {
    lines.push("");
    lines.push("Recovery recommendation");
    lines.push("- The controlled STOPPED state is terminal and was not changed by reporting.");
    lines.push("- Persisted packets and the current working tree can be inspected manually; remaining work requires a new task or explicit manual assessment.");
    lines.push("- No claim is made that unaccepted workspace changes are safe, complete, or automatically recoverable.");
  } else if (state.state === "FAILED") {
    lines.push("");
    lines.push("Recovery recommendation");
    lines.push("- Inspect the persisted error and workspace manually. This report does not classify a runtime failure as a controlled rejection or acceptance.");
  }

  lines.push("");
  lines.push(`Full report persisted: ${FACTORY_DIR}/${state.runId}.json`);
  return lines.join("\n");
}

function controlledStopReason(state: FactoryRunState): string {
  if (state.stoppedReason?.trim()) return state.stoppedReason.trim();
  const authoritative = authoritativeArchitectOutcome(state);
  if (authoritative?.label === "Final Architect recheck" && authoritative.packet.verdict === "NEEDS_REMEDIATION") {
    return `Final Architect recheck returned NEEDS_REMEDIATION after the remediation allowance reached ${state.remediationRounds}/${state.config.maxArchitectRemediationRounds}.`;
  }
  if (authoritative?.packet.verdict === "NEEDS_REMEDIATION") {
    return `Final Architect returned NEEDS_REMEDIATION and no remediation allowance remained (${state.remediationRounds}/${state.config.maxArchitectRemediationRounds}).`;
  }
  if (state.repairExhausted) return "The Engineer/Reviewer repair allowance was exhausted.";
  return "The run stopped before acceptance; no more specific stop reason was persisted.";
}

function renderTerminalEvidence(lines: string[], state: FactoryRunState, supersededFinalReport: boolean): void {
  const authoritative = authoritativeArchitectOutcome(state);
  if (supersededFinalReport) {
    lines.push("");
    lines.push("Superseded artifacts (historical evidence only)");
    lines.push("- An earlier final Lead synthesis exists, but a later authoritative Architect outcome supersedes it.");
  }
  const accepted = acceptedGate(state);
  if (accepted && state.state !== "DONE") {
    section(lines, "Accepted partial work", [
      `${accepted.label} returned ACCEPT before the run ended ${state.state}.`,
      ...(state.results.integration?.packet.completedWorkPackages ?? []),
    ]);
  }
  const incomplete: string[] = authoritative?.packet.verdict === "NEEDS_REMEDIATION"
    ? [
        ...authoritative.packet.blockingIssues,
        ...authoritative.packet.requiredChanges.map((item) => `Required change: ${item}`),
      ]
    : [];
  const remediationEngineer = state.results.remediation?.engineer?.packet;
  if (remediationEngineer) {
    section(lines, "Latest remediation implementation (not mission acceptance)", [
      `Work package ${remediationEngineer.workPackageId}: ${remediationEngineer.status} — ${remediationEngineer.summary}`,
      ...remediationEngineer.changedFiles.map((file) => `Reported changed file: ${file}`),
      ...(remediationEngineer.testResults ? [`Reported validation: ${remediationEngineer.testResults}`] : []),
    ]);
  }
  const latestEngineer = remediationEngineer ?? state.results.engineers[state.results.engineers.length - 1]?.outcome.packet;
  if (latestEngineer && latestEngineer.status !== "completed") {
    incomplete.push(`Work package ${latestEngineer.workPackageId}: ${latestEngineer.status} — ${latestEngineer.summary}`);
  } else if (!latestEngineer && state.results.proposal) {
    incomplete.push(...state.results.proposal.packet.workPackages.map((item) => `No Engineer completion evidence: ${item}`));
  }
  section(lines, "Unaccepted or incomplete work", incomplete);
  if (authoritative?.packet.verdict === "NEEDS_REMEDIATION") {
    section(lines, "Relevant validation failures", authoritative.packet.requiredEvidence.map((item) => `Required evidence not satisfied at the failed gate: ${item}`));
  }
  const latestReviewer = state.results.remediation?.reviewer?.packet
    ?? state.results.reviewers[state.results.reviewers.length - 1]?.outcome.packet;
  if (latestReviewer) {
    section(lines, "Reviewer evidence", [
      `Verdict: ${latestReviewer.verdict}`,
      ...latestReviewer.blockingFindings,
      ...latestReviewer.testConcerns,
    ]);
  }
  const integration = state.results.integration?.packet;
  if (integration) {
    section(lines, "Historical validation evidence (not final acceptance)", [integration.systemVerification]);
  }
  section(lines, "Recorded runtime errors", state.errors.map((error) => `${error.phase}: ${error.message}`));
}

/** Automatic post-run rendering uses the same report for every terminal state. */
export function formatFactoryCompletion(state: FactoryRunState): string {
  return isTerminal(state.state) ? formatFactoryReport(state) : `Factory run ${state.runId} is not terminal (${state.state}).`;
}

/** Section titles promoted to `##` headings in the Markdown report message. */
const REPORT_HEADINGS = new Set([
  "Factory final report",
  "Delivered",
  "Architecture / decisions",
  "Reviewer findings",
  "Validation",
  "Commits",
  "Human verification (pending)",
  "Warnings / limitations",
  "Remediation history",
  "Final accepted evidence",
  "Historical integration (before remediation; not current workspace evidence)",
  "Latest integration (NOT accepted)",
  "Latest remediation implementation (not mission acceptance)",
  "Superseded artifacts (historical evidence only)",
  "Accepted partial work",
  "Unaccepted or incomplete work",
  "Relevant validation failures",
  "Reviewer evidence",
  "Historical validation evidence (not final acceptance)",
  "Recorded runtime errors",
  "Target outcomes (packet evidence; not a workspace snapshot)",
  "Recovery recommendation",
]);

/**
 * The final report as a rich message: same single-source formatter as
 * `/factory-report`, with the plain section titles promoted to Markdown
 * headings so the normal assistant-message renderer displays them as headings.
 */
export function formatFactoryReportMarkdown(state: FactoryRunState): string {
  return formatFactoryReport(state)
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "Factory final report") return "# Factory final report";
      if (REPORT_HEADINGS.has(trimmed)) return `## ${trimmed}`;
      return line;
    })
    .join("\n");
}

/** The minimal message sink the completion reporter needs (pi.sendMessage). */
export interface CompletionSink {
  sendMessage(message: { customType: string; content: string; display: boolean }): void;
}

/** Durable automatic-delivery evidence, kept outside orchestration state. */
export interface ReportDeliveryStore {
  hasPreparedReportDelivery(runId: string): boolean;
  hasDeliveredReport(runId: string): boolean;
  markReportDelivered(runId: string, terminalState: FactoryRunState["state"]): void;
}

/**
 * Append the terminal report to the conversation once per run. The in-memory
 * set absorbs repeated callbacks in one process; the optional durable marker
 * absorbs rehydration/restart callbacks. Delivery happens before marking, so a
 * crash in that narrow interval can duplicate a report but cannot suppress it.
 */
export function reportFactoryCompletion(
  sink: CompletionSink,
  state: FactoryRunState,
  reported: Set<string>,
  delivery?: ReportDeliveryStore,
): void {
  if (!isTerminal(state.state) || reported.has(state.runId)) return;
  if (delivery && (!delivery.hasPreparedReportDelivery(state.runId) || delivery.hasDeliveredReport(state.runId))) return;
  sink.sendMessage({
    customType: "factory-final-report",
    content: formatFactoryReportMarkdown(state),
    display: true,
  });
  reported.add(state.runId);
  try {
    delivery?.markReportDelivered(state.runId, state.state);
  } catch {
    // The report was already delivered. Keep the in-process guard; a later
    // session may repeat it because durable evidence could not be written.
  }
}

/** State for a run or undefined, reading persisted state only (no model calls). */
function reportStateFor(runId: string | undefined, cwd: string, runtime: FactoryCommandRuntime): FactoryRunState | undefined {
  if (runId !== undefined && runId !== "") return runtime.peekState(runId, cwd);
  const runs = runtime.listRuns(cwd); // newest first
  const newestFirst = runs.map((run) => runtime.peekState(run.runId, cwd)).filter((s): s is FactoryRunState => s !== undefined);
  return newestFirst.find((s) => isTerminal(s.state));
}

function latestStateFor(cwd: string, runtime: FactoryCommandRuntime): FactoryRunState | undefined {
  const runs = runtime.listRuns(cwd);
  return runs.length > 0 ? runtime.peekState(runs[0].runId, cwd) : undefined;
}

export function registerFactoryCommands(pi: ExtensionAPI, runtime: FactoryCommandRuntime): void {
  pi.registerCommand("factory", {
    description: "Start an AI Factory run for a task (deterministic; no model decides to invoke it).",
    handler: async (args, ctx) => {
      if (!(await runtime.isAvailable())) {
        ctx.ui.notify("pi-subagents is not available in this session; Factory cannot run without it.", "error");
        return;
      }
      let task = args.trim();
      if (task === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /factory <task>", "error");
          return;
        }
        task = ((await ctx.ui.editor("Factory task — describe the goal")) ?? "").trim();
      }
      if (task === "") {
        ctx.ui.notify("Factory cancelled: no task provided.", "info");
        return;
      }
      const warnings = validateFactoryConfig(loadFactoryConfig(ctx.cwd), availableModels(ctx));
      if (warnings.length > 0) {
        ctx.ui.notify(`Factory config warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`, "warning");
      }
      const { id, controller } = runtime.launch(ctx.cwd, task);
      ctx.ui.notify(`Factory run started.\nrunId: ${id}\nstate: ${controller.getState().state}`, "info");
      runtime.showRunPanel(ctx, id);
      // Auto-append the same evidence-based report for every terminal outcome.
      // The runtime deduplicates repeated completion callbacks durably.
      if (ctx.hasUI) void controller.waitForTerminal().then((final) => runtime.reportCompletion(final));
    },
  });

  pi.registerCommand("factory-status", {
    description: "Show the latest AI Factory run for this project (read-only; no model call).",
    handler: async (_args, ctx) => {
      const runs = runtime.listRuns(ctx.cwd);
      if (runs.length === 0) {
        ctx.ui.notify("No Factory runs found for this project.", "info");
        return;
      }
      const latest = runs[0];
      const state = runtime.peekState(latest.runId, ctx.cwd);
      if (!state) {
        ctx.ui.notify(`Factory run ${latest.runId} has no readable state.`, "error");
        return;
      }
      ctx.ui.notify(formatRunStatus(state), "info");
    },
  });

  const verboseUsage = [
    "Usage: /factory-verbose <mode>",
    "  on            follow the active agent, then the last finished one (the default)",
    "  off           compact progress only; no live view",
    "  active        follow only the running agent as phases change",
    "  lead | architect | engineer | reviewer   follow the latest agent of that role",
    "  <exact-phase> follow that phase's agent, e.g. execution.engineer",
    "The detail opens in a scrollable live view (Esc closes it); the run panel above",
    "the editor always shows compact orchestration state. /agents is the full history.",
    "With no argument it shows the current mode and this usage. Invalid arguments",
    "show this help and never invoke a model.",
  ].join("\n");

  const handleVerbose = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const ref = args.trim();
    if (ref === "") {
      ctx.ui.notify(`Factory panel visibility: ${runtime.visibilityStatus()}.\n\n${verboseUsage}`, "info");
      return;
    }
    const mode = parseVisibilityArg(ref);
    if (mode === undefined) {
      ctx.ui.notify(verboseUsage, "info");
      return;
    }
    const message = runtime.setVisibility(mode);
    if (mode.kind === "none") {
      ctx.ui.notify(message, "info");
      return;
    }
    ctx.ui.notify(`${message}\nOpening the live view — Esc closes it, arrows/PgUp/PgDn scroll.`, "info");
    await runtime.openFocusView(ctx, mode);
  };

  pi.registerCommand("factory-verbose", {
    description:
      "Set the run panel's visibility mode: on|off|active|<role>|<exact-phase> " +
      "(read-only; no model call). e.g. /factory-verbose on, /factory-verbose active, /factory-verbose execution.engineer.",
    handler: handleVerbose,
  });

  // Deprecated alias: /factory-agent now means /factory-verbose, not a per-agent
  // toggle. It shares the same handler and the same single visibility state —
  // no second state system. Not advertised; docs reference /factory-verbose.
  pi.registerCommand("factory-agent", {
    description:
      "Deprecated alias for /factory-verbose — set the run panel's visibility mode (read-only; no model call).",
    handler: handleVerbose,
  });

  pi.registerCommand("factory-report", {
    description: "Print the final human-readable report for the latest completed AI Factory run (read-only; no model call). Optionally pass a run id.",
    handler: async (args, ctx) => {
      const runId = args.trim();
      const state = reportStateFor(runId === "" ? undefined : runId, ctx.cwd, runtime);
      if (!state) {
        ctx.ui.notify(
          runId !== "" ? `Factory run not found: ${runId}` : "No completed Factory run found for this project.",
          "info",
        );
        return;
      }
      ctx.ui.notify(formatFactoryReport(state), "info");
    },
  });

  pi.registerCommand("factory-metrics", {
    description: "Show operational metrics for the latest AI Factory run (read-only; no model call). Optionally pass a run id.",
    handler: async (args, ctx) => {
      const runId = args.trim();
      const state = runId !== ""
        ? runtime.peekState(runId, ctx.cwd)
        : latestStateFor(ctx.cwd, runtime);
      if (!state) {
        ctx.ui.notify(
          runId !== "" ? `Factory run not found: ${runId}` : "No Factory run found for this project.",
          "info",
        );
        return;
      }
      // Render at the current invocation point (bottom of the conversation) as a
      // normal command-result message — never a top/toast status region.
      if (ctx.hasUI) {
        pi.sendMessage({ customType: "factory-metrics", content: formatRunMetrics(state), display: true });
      } else {
        ctx.ui.notify(formatRunMetrics(state), "info");
      }
    },
  });

  pi.registerCommand("factory-stop", {
    description: "Stop the active AI Factory run for this project (no model call).",
    handler: async (_args, ctx) => {
      const active = runtime.listRuns(ctx.cwd).filter((r) => !isTerminal(r.state));
      if (active.length === 0) {
        ctx.ui.notify("No active Factory run to stop.", "info");
        return;
      }
      const latest = active[0];
      if (runtime.stop(latest.runId, ctx.cwd)) {
        ctx.ui.notify(`Stopped Factory run ${latest.runId}.`, "info");
      } else {
        ctx.ui.notify(`Could not stop Factory run ${latest.runId}.`, "error");
      }
    },
  });

  pi.registerCommand("factory-resume", {
    description: "Inspect and resume an interrupted AI Factory run; optionally switch future agents to a preset. No replay of completed phases.",
    handler: async (args, ctx) => {
      const usage = "Usage: /factory-resume <runId> [--preset <presetName>]";
      const parsed = parseResumeArgs(args);
      if (!parsed) {
        ctx.ui.notify(usage, "error");
        return;
      }
      const { runId, preset } = parsed;
      const models = availableModels(ctx);
      // Read-only preview: never acquires a lease, drives, or calls an agent.
      const preview = runtime.resume(runId, ctx.cwd, { preset, dryRun: true, availableModels: models });
      if (preview.kind !== "preview") {
        ctx.ui.notify(preview.text, "error");
        return;
      }
      ctx.ui.notify(preview.text, "info");
      if (preview.requiresApproval) {
        // Explicit, checkpoint-bound confirmation (Pi's native confirm). The
        // approval acknowledges the workspace is used as-is — not proof of
        // cleanliness.
        if (!ctx.hasUI) {
          ctx.ui.notify("This run requires explicit approval; run /factory-resume again in the interactive UI to confirm.", "error");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Resume Factory run",
          `Interrupted work is not proven clean; the current workspace is used as-is. Continue from checkpoint ${preview.checkpointId}?`,
        );
        if (!ok) {
          ctx.ui.notify("Resume cancelled; no state was changed and no agent was called.", "info");
          return;
        }
      }
      const outcome = runtime.resume(runId, ctx.cwd, {
        preset,
        approval: preview.requiresApproval,
        checkpointId: preview.checkpointId,
        availableModels: models,
      });
      ctx.ui.notify(outcome.text, outcome.kind === "ok" ? "info" : "error");
    },
  });

  pi.registerCommand("factory-config", {
    description: "Configure Factory roles, fallbacks, limits and presets (interactive; no model call).",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/factory-config needs the interactive UI.", "error");
        return;
      }
      const modelOptions = modelOptionsFrom(ctx);
      await showFactoryConfigUI(commandUIContext(ctx), {
        cwd: ctx.cwd,
        models: modelOptions.map((m) => m.value),
        modelOptions,
        ...(ctx.model ? { chatModel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        // Explicit-only: called solely from the "Pi chat model" submenu. Never on
        // preset activation, so Factory presets cannot silently change the chat model.
        setChatModel: async (label) => {
          const model = ctx.modelRegistry.getAvailable().find((m) => `${m.provider}/${m.id}` === label);
          return model ? pi.setModel(model) : false;
        },
      });
    },
  });
}

/** Searchable model options from Pi's registry (canonical value + search text). */
function modelOptionsFrom(ctx: ExtensionContext): ModelOption[] {
  try {
    return ctx.modelRegistry.getAvailable().map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: `${m.provider}/${m.id}`,
      ...(m.name && m.name !== m.id ? { description: m.name } : {}),
      search: `${m.provider} ${m.id} ${m.name ?? ""}`,
    }));
  } catch {
    return [];
  }
}

/**
 * Render a menu with Pi's `SettingsList` — it wraps around natively (down on the
 * last row goes to the first, and vice versa) and gives label/value columns for
 * compact section grouping. Informational rows carry no `values`, so Enter on
 * them is a no-op.
 */
async function showMenu(ctx: ExtensionCommandContext, title: string, rows: MenuRow[]): Promise<string | undefined> {
  const items: SettingItem[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    currentValue: row.value ?? "",
    ...(row.description ? { description: row.description } : {}),
    ...(row.info ? {} : { values: [""] }),
  }));
  return await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const list = new SettingsList(
      items,
      Math.min(Math.max(items.length, 1), 14),
      getSettingsListTheme(),
      (id) => done(id),
      () => done(undefined),
    );
    const container = new Container();
    container.addChild(new Text(title, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });
}

/**
 * Searchable model picker: a thin glue over Pi's public primitives — `Input`,
 * `SelectList` (native wrap-around) and `fuzzyFilter`. Pi's own
 * `ModelSelectorComponent` is not reusable from an extension (its constructor
 * needs a `SettingsManager` and `ModelRuntime` the public context does not
 * expose), so this reuses the same building blocks instead.
 */
async function showModelPicker(
  ctx: ExtensionCommandContext,
  title: string,
  models: ModelOption[],
  current?: string,
): Promise<string | undefined> {
  return await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const input = new Input();
    const listHost = new Container();
    const container = new Container();
    container.addChild(new Text(title, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(input);
    container.addChild(new Spacer(1));
    container.addChild(listHost);
    let list: SelectList | undefined;

    const rebuild = (): void => {
      const matched = filterModels(models, input.getValue());
      list = new SelectList(
        matched.map((m) => ({ value: m.value, label: m.label, description: m.description })),
        Math.min(Math.max(matched.length, 1), 12),
        getSelectListTheme(),
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      const index = matched.findIndex((m) => m.value === current);
      if (index >= 0) list.setSelectedIndex(index);
      listHost.clear();
      listHost.addChild(list);
    };
    rebuild();

    const kb = getKeybindings();
    return {
      get focused(): boolean {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (!list) return;
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
          list.handleInput(data);
          return;
        }
        if (kb.matches(data, "tui.select.confirm")) {
          const item = list.getSelectedItem();
          if (item) done(item.value);
          return;
        }
        if (kb.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) rebuild();
      },
    };
  });
}

/** Adapt Pi's `ctx.ui` surface to the config UI, including wrapping menus. */
function commandUIContext(ctx: ExtensionCommandContext): ConfigUI {
  return {
    menu: (title, rows) => showMenu(ctx, title, rows),
    pickModel: (title, models, current) => showModelPicker(ctx, title, models, current),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

/** Parse `/factory-resume <runId> [--preset <name>]`. */
function parseResumeArgs(args: string): { runId: string; preset?: string } | undefined {
  const tokens = args.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return undefined;
  let preset: string | undefined;
  let runId: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--preset") {
      preset = tokens[i + 1];
      if (preset === undefined) return undefined;
      i++;
    } else if (t.startsWith("--")) {
      return undefined;
    } else if (runId === undefined) {
      runId = t;
    } else {
      return undefined;
    }
  }
  return runId !== undefined ? { runId, preset } : undefined;
}
