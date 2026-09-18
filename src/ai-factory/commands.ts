/**
 * ai-factory/commands.ts — Slash-command UX for the AI Factory.
 *
 * These commands let a user start, inspect, stop and configure Factory directly
 * from Pi's command line, with no reliance on the currently selected main model
 * deciding to call the `Factory` tool. Dispatch, status, stop and every config
 * edit are deterministic: no model is invoked by any of them. Only `/factory`
 * starts a run (which then spawns role agents through the existing controller).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadFactoryConfig, validateFactoryConfig } from "./config.js";
import { type ConfigUI, showFactoryConfigUI } from "./config-ui.js";
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

/** Compact, deterministic status block for `/factory-status`. */
export function formatRunStatus(state: FactoryRunState): string {
  const m = state.metrics;
  const lines = [
    `Factory run ${state.runId}`,
    `state: ${state.state}${state.parked ? " (parked)" : ""}`,
    `phase: ${state.inFlight?.phase ?? "-"}   active role: ${state.inFlight?.role ?? "-"}`,
    `repairRound: ${state.repairRound}   remediationRounds: ${state.remediationRounds}`,
    `retries: ${m.totalRetries}   fallbacks: ${m.totalFallbacks}   capacityWaits: ${m.capacityWaits}`,
    "targets:",
    ...ROLE_NAMES.map((role) => `  ${role}: ${m.roles[role].targetUsed ?? "-"}`),
    `updated: ${new Date(state.updatedAt).toISOString()}`,
  ];
  const lastError = state.errors[state.errors.length - 1];
  if (lastError) lines.push(`last error: ${lastError.message}`);
  if (state.stoppedReason) lines.push(`stopped: ${state.stoppedReason}`);
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
      await showFactoryConfigUI(commandUIContext(ctx), {
        cwd: ctx.cwd,
        models: availableModels(ctx),
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

/** Adapt Pi's `ctx.ui` dialog surface to the config UI's minimal interface. */
function commandUIContext(ctx: ExtensionCommandContext): ConfigUI {
  return {
    select: (title, options) => ctx.ui.select(title, options),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}
