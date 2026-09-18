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
import { type FactoryRunState, ROLE_NAMES, type RoleName } from "./types.js";

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

/** Body used when a run predates the final Lead synthesis. */
function legacyReportBody(state: FactoryRunState): string {
  const accepted = state.results.finalRecheck?.packet ?? state.results.finalArchitect?.packet;
  const integration = state.results.integration?.packet;
  const lines: string[] = [];
  if (integration) {
    lines.push("Accepted integration (preserved):");
    lines.push(`- System verification: ${integration.systemVerification}`);
    lines.push(`- Factual assessment: ${integration.factualAssessment}`);
    for (const finding of integration.reviewerFindingsUnresolved) lines.push(`- Unresolved reviewer finding: ${finding}`);
  }
  if (accepted) {
    if (lines.length > 0) lines.push("");
    const gate = state.results.finalRecheck ? "recheck" : "final gate";
    lines.push(`Final Architect verdict (${gate}): ${accepted.verdict}`);
    for (const change of accepted.requiredChanges) lines.push(`- Required change: ${change}`);
  }
  if (lines.length === 0) lines.push("No accepted artifact is available for this run.");
  return lines.join("\n");
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
  const lines: string[] = ["Factory final report", `Run: ${state.runId}`];
  if (finalReport) {
    lines.push(`Result: ${finalReport.result}`);
  } else {
    lines.push("Result: (LEGACY FALLBACK — this run has no final Lead synthesis recorded)");
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
    lines.push(legacyReportBody(state));
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
      // Auto-render the final report when the run finishes, so the invoking
      // session shows the result without the user remembering another command.
      // Uses the persisted finalReport via the same formatter /factory-report
      // uses — never a second, divergent summary.
      if (ctx.hasUI) {
        void controller.waitForTerminal().then((final) => {
          ctx.ui.notify(formatFactoryCompletion(final), final.state === "DONE" ? "info" : "warning");
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
      ctx.ui.notify(formatRunMetrics(state), "info");
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
