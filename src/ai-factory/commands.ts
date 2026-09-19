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
import { loadFactoryConfig, validateFactoryConfig } from "./config.js";
import { type ConfigUI, filterModels, type MenuRow, type ModelOption, showFactoryConfigUI } from "./config-ui.js";
import type { FactoryController } from "./controller.js";
import { formatDuration, formatRunMetrics } from "./metrics.js";
import { isTerminal } from "./state.js";
import { FACTORY_DIR } from "./store.js";
import {
  type ArchitectFinalResult,
  type FactoryRunState,
  type LeadIntegrationPacket,
  ROLE_NAMES,
  type RoleName,
} from "./types.js";

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
  /** Register/refresh the Factory run panel widget for this session. */
  showRunPanel(ctx: ExtensionCommandContext, runId: string): void;
  /** Toggle an agent's expansion by role/phase/active; returns a status message. */
  toggleAgent(ref: string, cwd: string): string | undefined;
  /** Append the accepted final report to the conversation (deduplicated). */
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
  const lines: string[] = [];
  if (terminal) {
    const verdict = finalReport?.result
      ?? state.results.finalRecheck?.packet.verdict
      ?? state.results.finalArchitect?.packet.verdict
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
  lines.push(`retries: ${m.totalRetries}   fallbacks: ${m.totalFallbacks}   capacityWaits: ${m.capacityWaits}`);
  if (terminal) {
    const head = finalReport?.endingHead ?? "-";
    const commits = finalReport ? finalReport.commits.length : "-";
    const validation = finalReport?.validation[0] ?? state.results.integration?.packet.systemVerification ?? "-";
    const pending = finalReport?.humanVerification.length ?? 0;
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

function acceptedGate(state: FactoryRunState): AcceptedGate | undefined {
  const recheck = state.results.finalRecheck?.packet;
  if (recheck?.verdict === "ACCEPT") return { packet: recheck, label: "Final Architect recheck" };
  const finalGate = state.results.finalArchitect?.packet;
  if (finalGate?.verdict === "ACCEPT") return { packet: finalGate, label: "Final Architect" };
  return undefined;
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
  const finalGate = state.results.finalArchitect?.packet;
  const lines = [`Run state: ${state.state}`, "No accepted final artifact exists for this run."];
  if (integration) {
    lines.push("");
    lines.push("Latest integration (NOT accepted)");
    lines.push(`- System verification: ${integration.systemVerification}`);
    lines.push(`- Factual assessment: ${integration.factualAssessment}`);
    for (const finding of integration.reviewerFindingsUnresolved) lines.push(`- Unresolved reviewer finding: ${finding}`);
  }
  if (finalGate) {
    lines.push("");
    lines.push(`Final Architect verdict: ${finalGate.verdict}`);
    for (const issue of finalGate.blockingIssues) lines.push(`- Blocking issue: ${issue}`);
    for (const change of finalGate.requiredChanges) lines.push(`- Required change: ${change}`);
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
  const legacy = finalReport ? undefined : legacyReportView(state);
  const lines: string[] = ["Factory final report", `Run: ${state.runId}`];
  if (finalReport) {
    lines.push(`Result: ${finalReport.result}`);
  } else {
    lines.push(`Result: ${legacy!.result}`);
    lines.push(`Source: ${legacy!.source}`);
  }
  if (state.metrics.runDurationMs !== undefined) lines.push(`Duration: ${formatDuration(state.metrics.runDurationMs)}`);
  lines.push(`Remediation rounds: ${state.remediationRounds}`);
  if (finalReport) {
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
  }
  lines.push("");
  lines.push(`Full report persisted: ${FACTORY_DIR}/${state.runId}.json`);
  return lines.join("\n");
}

/** Automatic post-run rendering: the persisted final report, or a short notice. */
export function formatFactoryCompletion(state: FactoryRunState): string {
  if (state.state === "DONE") return formatFactoryReport(state);
  return `Factory run ${state.runId} ended ${state.state}. Use /factory-status for details.`;
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
  "Latest integration (NOT accepted)",
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

/**
 * Append the accepted final report to the conversation exactly once per run,
 * as a normal rendered message. Replayed/duplicate DONE events are ignored via
 * the caller-supplied `reported` set.
 */
export function reportFactoryCompletion(sink: CompletionSink, state: FactoryRunState, reported: Set<string>): void {
  if (reported.has(state.runId)) return;
  reported.add(state.runId);
  if (state.state !== "DONE") return;
  sink.sendMessage({
    customType: "factory-final-report",
    content: formatFactoryReportMarkdown(state),
    display: true,
  });
}

/** State for a run or undefined, reading persisted state only (no model calls). */
function reportStateFor(runId: string | undefined, cwd: string, runtime: FactoryCommandRuntime): FactoryRunState | undefined {
  if (runId !== undefined && runId !== "") return runtime.peekState(runId, cwd);
  const runs = runtime.listRuns(cwd); // newest first
  const newestFirst = runs.map((run) => runtime.peekState(run.runId, cwd)).filter((s): s is FactoryRunState => s !== undefined);
  return newestFirst.find((s) => s.results.finalReport !== undefined)
    ?? newestFirst.find((s) => s.state === "DONE");
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
      // Auto-append the accepted final report when the run finishes, as a
      // normal rendered message at the bottom of the conversation (deduplicated
      // by run id). Non-DONE terminal states stay a short notification.
      if (ctx.hasUI) {
        void controller.waitForTerminal().then((final) => {
          // Stops the live panel and appends the rich report on DONE.
          runtime.reportCompletion(final);
          if (final.state !== "DONE") ctx.ui.notify(formatFactoryCompletion(final), "warning");
        });
      }
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

  pi.registerCommand("factory-agent", {
    description:
      "Expand/collapse a Factory run agent by role, phase or 'active' (read-only; no model call). " +
      "e.g. /factory-agent lead, /factory-agent execution.engineer, /factory-agent active.",
    handler: async (args, ctx) => {
      const ref = args.trim();
      if (ref === "") {
        ctx.ui.notify("Usage: /factory-agent <role|phase|active>", "info");
        return;
      }
      const message = runtime.toggleAgent(ref, ctx.cwd);
      ctx.ui.notify(message ?? "No Factory run with a matching agent found for this project.", "info");
    },
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
