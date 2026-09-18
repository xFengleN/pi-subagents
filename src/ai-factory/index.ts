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
import { systemClock } from "./clock.js";
import { loadFactoryConfig } from "./config.js";
import { FactoryController, type FactoryControllerDeps } from "./controller.js";
import { buildRunSummary } from "./metrics.js";
import { isTerminal } from "./state.js";
import { FactoryStore } from "./store.js";
import { BusFactoryTransport, globalManagerRegistry } from "./transport.js";

/** Minimal tool result helper — matches the pi tool-result content shape. */
function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

const runId = (): string => `factory_${Date.now().toString(36)}_${nanoid(6)}`;

export default function (pi: ExtensionAPI): void {
  const transport = new BusFactoryTransport({ events: pi.events, getRegistry: globalManagerRegistry });
  const controllers = new Map<string, FactoryController>();
  let store: FactoryStore | undefined;
  let sessionBound = false;

  const depsFor = (cwd: string): FactoryControllerDeps => ({
    transport,
    clock: systemClock,
    store: new FactoryStore(cwd),
    config: loadFactoryConfig(cwd),
  });

  // Discovery: pi-subagents advertises `subagents:ready` on its first bound
  // session_start. Subscribe at factory time so the event is never missed
  // regardless of extension registration order; session_start also probes.
  pi.events.on("subagents:ready", () => transport.markReady());

  pi.on("session_start", async (_event, ctx) => {
    store = new FactoryStore(ctx.cwd);
    sessionBound = true;
    void transport.ping(750).then((ok) => { if (ok) transport.markReady(); });
  });

  pi.on("session_before_switch", () => {
    // Runs persist to disk on every transition; detach in-process controllers
    // so a session switch does not keep stale subscriptions alive. Any run is
    // resumed on demand via factory_status.
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
  });

  pi.on("session_shutdown", async () => {
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
    sessionBound = false;
    store = undefined;
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
      const deps = depsFor(ctx.cwd);
      // Apply per-call config overrides on top of the project file.
      deps.config = loadFactoryConfig(ctx.cwd, params.config as Record<string, unknown> | undefined);
      const controller = FactoryController.create(deps, id, params.task, ctx.cwd);
      controllers.set(id, controller);
      controller.start();
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
   * Return the in-process controller for a run, lazily restoring and resuming a
   * persisted non-terminal run that is not currently active (a session switch or
   * process restart orphans it otherwise). A terminal or unknown run is left
   * alone — only its persisted snapshot is available.
   */
  function ensureController(id: string, ctx: ExtensionContext | undefined): FactoryController | undefined {
    const active = controllers.get(id);
    if (active) return active;
    const persisted = (store ?? new FactoryStore(ctx?.cwd ?? process.cwd())).load(id);
    if (!persisted || isTerminal(persisted.state)) return undefined;
    const restored = FactoryController.restore(depsFor(persisted.cwd), id);
    if (!restored) return undefined;
    controllers.set(id, restored);
    restored.start();
    return restored;
  }
}
