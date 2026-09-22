/**
 * ai-factory/index.ts — The AI Factory pi extension entry point.
 *
 * A thin adapter between pi and the deterministic Factory controller. This
 * extension deliberately knows nothing about how pi-subagents implements its
 * agents: it talks to pi-subagents only through the documented cross-extension
 * bus channels and the manager registry (see transport.ts). The controller
 * core (controller.ts) is pi-free and fully tested against a fake transport.
 *
 * Tools:
 *   Factory       — start a Factory run for a task (deterministic orchestration
 *                   then begins; role agents are spawned over the RPC bus).
 *   factory_status — query a run's persisted state / final run summary.
 */

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { nanoid } from "nanoid";
import type { AgentRecord } from "../types.js";
import { systemClock } from "./clock.js";
import { type FactoryCommandRuntime, type FactoryRunListItem, formatResumePreview, registerFactoryCommands, reportFactoryCompletion } from "./commands.js";
import { loadFactoryConfig, resolvePresetConfig, validateFactoryConfig } from "./config.js";
import { FactoryController, type FactoryControllerDeps } from "./controller.js";
import { LeaseStore } from "./lease.js";
import { FactoryFocusView, type FocusTarget } from "./live-view.js";
import { buildRunSummary } from "./metrics.js";
import { DEFAULT_VISIBILITY_MODE, describeVisibilityMode, resolveFocusAgentId, type VisibilityMode } from "./panel.js";
import { FactoryRunPanel } from "./panel-widget.js";
import { hasPreset, listPresetNames } from "./presets.js";
import { markdownMessage, textMessage, type WidgetTheme } from "./render.js";
import { assessRecoveryEligibility, isTerminal, planFactoryRecovery } from "./state.js";
import { FactoryStore } from "./store.js";
import { BusFactoryTransport, globalManagerRegistry } from "./transport.js";

/** Minimal tool result helper — matches the pi tool-result content shape. */
function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

const runId = (): string => `factory_${Date.now().toString(36)}_${nanoid(6)}`;

export default function (pi: ExtensionAPI): void {
  const transport = new BusFactoryTransport({ events: pi.events, getRegistry: globalManagerRegistry });
  // Cache of in-process controllers, NOT the ownership authority. Exclusive
  // per-run ownership lives in the durable lease (lease.ts); the map only
  // avoids re-restoring what this process already drives.
  const controllers = new Map<string, FactoryController>();
  let store: FactoryStore | undefined;
  let sessionBound = false;

  // Session-scoped Factory run panel state (the compact above-editor widget).
  let runPanel: FactoryRunPanel | undefined;
  let activeRunId: string | undefined;
  let reportedRuns = new Set<string>();
  // The session-wide visibility preference. Lives OUTSIDE the per-session panel
  // so session switches (which dispose the panel) and panel disposal never reset
  // it; /factory-verbose writes it and the live view reads it.
  let visibilityMode: VisibilityMode = { ...DEFAULT_VISIBILITY_MODE };

  const deliverCompletion = (state: ReturnType<FactoryController["getSnapshot"]>): void => {
    runPanel?.stop();
    reportFactoryCompletion(pi, state, reportedRuns, activeStore(state.cwd));
  };

  const watchController = (controller: FactoryController): void => {
    void controller.waitForTerminal().then(deliverCompletion);
  };

  const depsFor = (cwd: string): FactoryControllerDeps => ({
    transport,
    clock: systemClock,
    // Production controllers are lease-backed: every commit is fenced by the
    // exclusive ownership token. Read-only inspection uses `activeStore`, a
    // plain store, so it never acquires a lease.
    store: new FactoryStore(cwd, { leaseStore: new LeaseStore({ cwd, clock: systemClock }) }),
    config: loadFactoryConfig(cwd),
  });

  // Register message renderers at activation (like pi-subagents registers its
  // notification renderer) so the Factory's transcript entries render through
  // the normal message path: the final report as Markdown, metrics as text.
  pi.registerMessageRenderer("factory-final-report", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return content ? markdownMessage(content, theme as WidgetTheme) : undefined;
  });
  pi.registerMessageRenderer("factory-metrics", (message, _options) => {
    const content = typeof message.content === "string" ? message.content : "";
    return content ? textMessage(content) : undefined;
  });

  // Discovery: pi-subagents advertises `subagents:ready` on its first bound
  // session_start. Subscribe at factory time so the event is never missed
  // regardless of extension registration order; session_start also probes.
  pi.events.on("subagents:ready", () => transport.markReady());

  pi.on("session_start", async (_event, ctx) => {
    store = new FactoryStore(ctx.cwd);
    sessionBound = true;
    runPanel = new FactoryRunPanel({
      getRunState: () => (activeRunId !== undefined ? controllers.get(activeRunId)?.getState() : undefined),
      getMode: () => visibilityMode,
    });
    reportedRuns = new Set();
    activeRunId = undefined;
    // Recover automatic delivery only for runs explicitly prepared by this
    // reporting lifecycle. Legacy artifacts remain explicit /factory-report
    // material and are never dumped into a new session unexpectedly.
    for (const id of store.list()) {
      const state = store.load(id);
      if (state && isTerminal(state.state)) deliverCompletion(state);
    }
    void transport.ping(750).then((ok) => { if (ok) transport.markReady(); });
  });

  const resetSessionUI = (): void => {
    runPanel?.dispose();
    runPanel = undefined;
    activeRunId = undefined;
    reportedRuns = new Set();
  };

  pi.on("session_before_switch", () => {
    // Runs persist to disk on every transition; detach in-process controllers
    // so a session switch does not keep stale subscriptions alive. Any run is
    // resumed on demand via factory_status.
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
    resetSessionUI();
  });

  pi.on("session_shutdown", async () => {
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
    sessionBound = false;
    store = undefined;
    resetSessionUI();
  });

  pi.registerTool(defineTool({
    name: "Factory",
    label: "AI Factory",
    description:
      "Start a deterministic AI Factory run for a task. The run orchestrates four roles — Lead, Architect, " +
      "Engineer, Reviewer — as sub-agents, with mandatory initial and final Architect checkpoints, a bounded " +
      "Engineer/Reviewer repair loop, and one bounded remediation cycle. Returns the run id; poll factory_status.",
    promptSnippet: "Orchestrate a full AI Factory run",
    parameters: Type.Object({
      task: Type.String({ description: "The user goal the Factory run should accomplish." }),
      config: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "Optional partial Factory config overrides (roles/targets, limits). Usually configured in .pi/factory.json.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!sessionBound || !ctx) return textResult("Factory requires an active session.");
      // `subagents:ready` is the authoritative discovery signal. Only probe if it
      // has not been observed yet — pinging a known-ready extension would make a
      // busy session fail a run on a slow round-trip.
      if (!transport.isAvailable() && !(await transport.ping(1_000))) {
        return textResult("pi-subagents is not available in this session; Factory cannot run without it.");
      }
      const id = runId();
      activeStore(ctx.cwd).prepareReportDelivery(id);
      const deps = depsFor(ctx.cwd);
      // Apply per-call config overrides on top of the project file.
      deps.config = loadFactoryConfig(ctx.cwd, params.config as Record<string, unknown> | undefined);
      const controller = FactoryController.create(deps, id, params.task, ctx.cwd);
      controllers.set(id, controller);
      controller.start();
      watchController(controller);
      return textResult(
        `Factory run started.\nrunId: ${id}\nstate: ${controller.getState().state}\n`
        + `Track progress with factory_status({run_id: "${id}"}).`,
      );
    },
  }));

  pi.registerTool(defineTool({
    name: "factory_status",
    label: "Factory Status",
    description:
      "Query an AI Factory run's persisted state and metrics. With wait=true, blocks until the run reaches a " +
      "terminal state (DONE / STOPPED / FAILED) and returns the final machine-readable run summary.",
    promptSnippet: "Check an AI Factory run's status",
    parameters: Type.Object({
      run_id: Type.Optional(Type.String({ description: "The Factory run id. Omit to list runs." })),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the run to finish before returning. Default: false." })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const cwd = ctx?.cwd ?? process.cwd();
      const activeStore = store ?? new FactoryStore(cwd);
      if (params.run_id === undefined) {
        const runs = activeStore.list().map((id) => {
          const state = activeStore.load(id);
          return { runId: id, state: state?.state };
        });
        return textResult(JSON.stringify({ runs }, null, 2));
      }
      const controller = ensureController(params.run_id, ctx);
      const state = controller?.getState() ?? activeStore.load(params.run_id);
      if (!state) return textResult(`Factory run not found: ${params.run_id}`);
      if (params.wait && controller) {
        const finalState = await controller.waitForTerminal(signal);
        return textResult(JSON.stringify(buildRunSummary(finalState), null, 2));
      }
      return textResult(JSON.stringify(buildRunSummary(state), null, 2));
    },
  }));

  /**
   * Slash-command runtime. Dispatch/status/stop/config are deterministic —
   * none of them asks a model anything. Only `/factory` starts a run, which
   * then spawns role agents through the existing controller.
   */
  const runtime: FactoryCommandRuntime = {
    isAvailable: async () => transport.isAvailable() || (await transport.ping(1_000)),
    launch: (cwd, task) => {
      const id = runId();
      activeStore(cwd).prepareReportDelivery(id);
      const controller = FactoryController.create(depsFor(cwd), id, task, cwd);
      controllers.set(id, controller);
      controller.start();
      watchController(controller);
      return { id, controller };
    },
    // Read-only: never restores/drives, so `/factory-status` costs no model calls.
    peekState: (id, cwd) => controllers.get(id)?.getState() ?? activeStore(cwd).load(id),
    listRuns: (cwd) => listRuns(cwd),
    resume: (id, cwd, opts) => {
      const state = activeStore(cwd).load(id);
      if (!state) return { kind: "notFound", text: `Factory run not found: ${id}` };
      if (isTerminal(state.state)) {
        return { kind: "terminal", text: `Run ${id} is terminal (${state.state}) and is not resumed.` };
      }
      const plan = planFactoryRecovery(state);
      const eligibility = assessRecoveryEligibility(state);
      let presetName: string | undefined;
      let modelWarnings: string[] = [];
      if (opts.preset !== undefined) {
        if (!hasPreset(opts.preset)) {
          return { kind: "invalidPreset", text: `No saved preset named "${opts.preset}". Presets: ${listPresetNames().join(", ") || "(none)"}` };
        }
        presetName = opts.preset;
        modelWarnings = validateFactoryConfig(resolvePresetConfig(presetName), opts.availableModels ?? []);
      }
      // Read-only preview: no lease, no controller, no drive, no mutation.
      if (opts.dryRun) {
        return {
          kind: "preview",
          text: formatResumePreview(state, plan, presetName, modelWarnings),
          requiresApproval: eligibility.requiresApproval || plan.decision === "approval_required",
          checkpointId: eligibility.checkpointId,
        };
      }
      if (eligibility.requiresApproval && !opts.approval) {
        return { kind: "approvalRequired", text: `Approval required for ${id}: ${eligibility.reason}`, checkpointId: eligibility.checkpointId };
      }
      // Execution: acquire ownership, reload + revalidate, then continue.
      const restored = FactoryController.restore(depsFor(state.cwd), id, { resume: false });
      if (!restored) {
        return { kind: "locked", text: `Run ${id} is owned by a live process elsewhere; reclamation is refused.` };
      }
      if (presetName !== undefined) {
        restored.applyPresetReplacement(presetName, resolvePresetConfig(presetName));
      }
      const result = eligibility.requiresApproval
        ? restored.resumeWithApproval(eligibility.checkpointId)
        : restored.resume();
      controllers.set(id, restored);
      if (result.kind === "ok") {
        const resumed = restored.getState();
        watchController(restored);
        return {
          kind: "ok",
          text: `Resumed run ${id}. state: ${resumed.state}${presetName !== undefined ? `, replacement preset: ${presetName}` : ""}. Completed phases were preserved; the next action continues from the checkpoint.`,
        };
      }
      if (result.kind === "staleApproval") {
        return { kind: "staleApproval", text: `Stale approval for ${id}: ${result.reason}` };
      }
      if (result.kind === "duplicate") {
        return { kind: "duplicate", text: `Run ${id} is already being driven or has a live child.` };
      }
      return { kind: "terminal", text: `Run ${id} cannot resume: ${result.reason}` };
    },
    stop: (id, cwd) => {
      let controller = controllers.get(id);
      if (!controller) {
        const persisted = activeStore(cwd).load(id);
        if (!persisted || isTerminal(persisted.state)) return false;
        // Restore WITHOUT resuming, so stopping an orphaned run cannot first
        // spawn a role agent.
        controller = FactoryController.restore(depsFor(persisted.cwd), id, { resume: false });
        if (!controller) return false;
        controllers.set(id, controller);
        watchController(controller);
      }
      controller.stop("Stopped via /factory-stop");
      return true;
    },
    showRunPanel: (ctx, runId) => {
      activeRunId = runId;
      if (!ctx.hasUI || !runPanel) return;
      ctx.ui.setWidget("factory", runPanel.content, { placement: "aboveEditor" });
    },
    setVisibility: (mode) => {
      visibilityMode = mode;
      runPanel?.refresh();
      return `Factory panel visibility: ${describeVisibilityMode(mode)}.`;
    },
    visibilityStatus: () => describeVisibilityMode(visibilityMode),
    openFocusView: async (ctx, mode) => {
      if (!ctx.hasUI) return;
      // `/factory` sets activeRunId; a run started through the `Factory` tool is
      // only in `controllers`, so fall back to the newest in-process run.
      const runId = activeRunId ?? newestControllerId();
      if (runId === undefined) {
        ctx.ui.notify("No active Factory run to inspect. Start one with /factory.", "info");
        return;
      }
      // The focused live transcript, reusing pi-subagents' own viewer. The
      // resolver is polled by the view, so `on`/`active` follow the run and a
      // not-yet-spawned role/phase target appears when it starts.
      await ctx.ui.custom<undefined>(
        (tui, theme, keybindings, done) => new FactoryFocusView(tui, theme, keybindings, done, {
          resolveTarget: () => resolveFocusTarget(runId, mode),
        }),
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } },
      );
    },
    reportCompletion: deliverCompletion,
  };
  registerFactoryCommands(pi, runtime);

  /** The id of the most recently created in-process controller, if any. */
  function newestControllerId(): string | undefined {
    let id: string | undefined;
    for (const key of controllers.keys()) id = key;
    return id;
  }

  /** The agent the focused live view should show now, with its retained session. */
  function resolveFocusTarget(runId: string, mode: VisibilityMode): FocusTarget | undefined {
    const state = controllers.get(runId)?.getState();
    if (!state) return undefined;
    const agentId = resolveFocusAgentId(state, mode);
    if (!agentId) return undefined;
    const record = globalManagerRegistry()?.getRecord(agentId) as unknown as AgentRecord | undefined;
    if (!record?.session) return undefined;
    return { agentId, record, session: record.session };
  }

  function activeStore(cwd: string): FactoryStore {
    return store ?? new FactoryStore(cwd);
  }

  /** Persisted runs for a project, newest first (for `/factory-status`/`stop`). */
  function listRuns(cwd: string): FactoryRunListItem[] {
    const runs: FactoryRunListItem[] = [];
    for (const id of activeStore(cwd).list()) {
      const state = activeStore(cwd).load(id);
      if (!state) continue;
      runs.push({
        runId: state.runId,
        state: state.state,
        updatedAt: state.updatedAt,
        ...(state.inFlight ? { role: state.inFlight.role, phase: state.inFlight.phase } : {}),
      });
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Return the in-process controller for a run, lazily restoring and resuming a
   * persisted non-terminal run that is not currently active (a session switch or
   * process restart orphans it otherwise). A terminal or unknown run is left
   * alone — only its persisted snapshot is available.
   */
  function ensureController(id: string, ctx: ExtensionContext | undefined): FactoryController | undefined {
    const active = controllers.get(id);
    if (active) return active;
    const persisted = activeStore(ctx?.cwd ?? process.cwd()).load(id);
    if (!persisted || isTerminal(persisted.state)) return undefined;
    const restored = FactoryController.restore(depsFor(persisted.cwd), id);
    if (!restored) return undefined;
    controllers.set(id, restored);
    restored.start();
    watchController(restored);
    return restored;
  }
}
