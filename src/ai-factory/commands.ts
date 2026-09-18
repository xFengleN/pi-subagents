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
import { isTerminal } from "./state.js";
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
 */
export function formatRunStatus(state: FactoryRunState): string {
  const m = state.metrics;
  const terminal = isTerminal(state.state);
  const lines = [
    terminal ? `Latest completed run: ${state.runId}` : `Current run: ${state.runId}`,
    `state: ${state.state}${state.parked ? " (parked)" : ""}`,
    `phase: ${state.inFlight?.phase ?? "-"}   active role: ${state.inFlight?.role ?? "-"}`,
    `repairRound: ${state.repairRound}   remediationRounds: ${state.remediationRounds}`,
    `retries: ${m.totalRetries}   fallbacks: ${m.totalFallbacks}   capacityWaits: ${m.capacityWaits}`,
    "Run configuration snapshot (models THIS run used — not the next run's config):",
    ...ROLE_NAMES.map((role) => `  ${role}: ${m.roles[role].targetUsed ?? "-"}`),
    `updated: ${new Date(state.updatedAt).toISOString()}`,
  ];
  const lastError = state.errors[state.errors.length - 1];
  if (lastError) lines.push(`last error: ${lastError.message}`);
  if (state.stoppedReason) lines.push(`stopped: ${state.stoppedReason}`);
  lines.push("Use /factory-config to view the configuration for the next run.");
  return lines.join("\n");
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
