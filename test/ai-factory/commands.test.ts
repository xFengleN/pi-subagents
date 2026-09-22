/**
 * ai-factory/commands.test.ts — slash-command dispatch, status, stop and
 * config (spec tests A, B, C, H).
 *
 * The extension is booted for real against a dispatching bus that stands in for
 * pi-subagents, so a command's effect on the RPC channel is observable. There is
 * no model anywhere: "zero model requests" means zero `subagents:rpc:spawn`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRunStatus } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig, factoryBaseState, loadPresetAsWorkingConfig, mergeFactoryConfig, resolvePresetConfig, writeProjectConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import factoryExtension from "../../src/ai-factory/index.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import { savePreset } from "../../src/ai-factory/presets.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { ctx as baseCtx, hermeticDir, makePi } from "../helpers/boot-extension.js";
import { FakeClock, FakeTransport, flush, packets } from "./fakes.js";

const hermetic: ReturnType<typeof hermeticDir>[] = [];
afterEach(() => {
  for (const h of hermetic.splice(0)) h.restore();
  vi.restoreAllMocks();
});

function workdir(): string {
  const h = hermeticDir({});
  hermetic.push(h);
  return h.dir;
}

/** A bus that actually dispatches handlers (unlike the recording mock). */
function makeDispatchingBus() {
  const handlers = new Map<string, (data: any) => void>();
  const emitted: string[] = [];
  const spawns: any[] = [];
  const bus = {
    on: (channel: string, handler: (data: any) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    emit: (channel: string, data: any) => {
      emitted.push(channel);
      handlers.get(channel)?.(data);
    },
  };
  // A stand-in pi-subagents: answers ping, records spawns, replies with an id.
  handlers.set("subagents:rpc:ping", (d: any) => {
    bus.emit(`subagents:rpc:ping:reply:${d.requestId}`, { success: true, data: { version: 2 } });
  });
  handlers.set("subagents:rpc:spawn", (d: any) => {
    spawns.push(d);
    bus.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: true, data: { id: `child-${spawns.length}` } });
  });
  return { bus, handlers, emitted, spawns };
}

/** Boot the real Factory extension against a dispatching bus. */
async function boot(cwd: string) {
  const { pi, tools, commands, lifecycle } = makePi();
  pi.setModel = vi.fn(async () => true);
  const b = makeDispatchingBus();
  // The controller consumes every settle synchronously; reply so the best-effort
  // consume RPC does not leave a 5s timer pending behind each completed agent.
  b.handlers.set("subagents:rpc:consume", (d: any) => {
    b.bus.emit(`subagents:rpc:consume:reply:${d.requestId}`, { success: true, data: {} });
  });
  pi.events = b.bus;
  factoryExtension(pi);
  await lifecycle.get("session_start")({}, baseCtx({ cwd }));
  b.bus.emit("subagents:ready", {});
  return { pi, tools, commands, lifecycle, ...b };
}

/** Render the currently-registered Factory run panel widget to plain lines. */
function renderFactoryPanel(ui: any): string[] {
  const call = ui.setWidget.mock.calls.find(
    (c: any[]) => c[0] === "factory" && typeof c[1] === "function",
  );
  if (!call) throw new Error("factory panel widget is not registered");
  const tui = { terminal: { columns: 120 }, requestRender: () => {} };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const component = call[1](tui, theme);
  const lines = component.render();
  component.dispose?.();
  return lines;
}

/** Complete the most recently spawned role child with a packet (prose fallback). */
async function completeChild(b: Awaited<ReturnType<typeof boot>>, packet: unknown): Promise<void> {
  const id = `child-${b.spawns.length}`;
  b.bus.emit("subagents:completed", { id, status: "completed", result: JSON.stringify(packet) });
  await flush();
}

/** A command context with a scriptable UI and a model registry. */
function commandCtx(cwd: string, models: string[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ui = {
    // Menus are rendered with Pi's SettingsList via ctx.ui.custom. Returning
    // undefined dismisses the config UI immediately (cancel), which is enough to
    // assert the command wiring without simulating keystrokes.
    custom: vi.fn(async (): Promise<unknown> => undefined),
    input: vi.fn(async (_title: string, _placeholder?: string): Promise<string | undefined> => undefined),
    confirm: vi.fn(async (_title: string, _message: string): Promise<boolean> => false),
    editor: vi.fn(async (_title: string, _prefill?: string): Promise<string | undefined> => undefined),
    notify: vi.fn((message: string, type?: "info" | "warning" | "error") => {
      notifications.push({ message, type });
    }),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    addAutocompleteProvider: vi.fn(),
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    ui,
    modelRegistry: {
      getAvailable: () =>
        models.map((label) => {
          const [provider, id] = label.split("/");
          return { provider, id, name: id };
        }),
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  };
  return { ctx: ctx as any, ui, notifications };
}

describe("AI Factory — slash commands", () => {
  it("A. /factory dispatches directly and starts a run (no model-mediated tool decision)", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd, ["p/model"]);

    await b.commands.get("factory").handler("do the thing", ctx);
    await flush();

    expect(notifications.some((n) => n.message.includes("Factory run started"))).toBe(true);
    // The command itself spawned the first role agent — no model had to decide
    // to call the `Factory` tool.
    expect(b.spawns).toHaveLength(1);
    expect(b.spawns[0].prompt).toContain("do the thing");
    // A run was persisted for the project.
    const dir = join(cwd, ".pi", "factory");
    expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("A2. /factory with no arguments opens the task editor", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd, ["p/model"]);
    ui.editor.mockResolvedValue("task from the editor");

    await b.commands.get("factory").handler("", ctx);
    await flush();

    expect(ui.editor).toHaveBeenCalledOnce();
    expect(b.spawns).toHaveLength(1);
    expect(b.spawns[0].prompt).toContain("task from the editor");
  });

  it("A3. /factory refuses cleanly when pi-subagents is unavailable (no run, no spawn)", async () => {
    const cwd = workdir();
    // Boot WITHOUT the ready signal and WITHOUT a ping responder.
    const { pi, commands, lifecycle } = makePi();
    const b = makeDispatchingBus();
    b.handlers.delete("subagents:rpc:ping");
    pi.events = b.bus;
    factoryExtension(pi);
    await lifecycle.get("session_start")({}, baseCtx({ cwd }));
    const { ctx, notifications } = commandCtx(cwd, ["p/model"]);

    await commands.get("factory").handler("do the thing", ctx);
    await flush();

    expect(notifications.some((n) => n.type === "error" && n.message.includes("not available"))).toBe(true);
    expect(b.spawns).toHaveLength(0);
  }, 10_000);

  it("B. /factory-status reads the latest persisted run with zero model requests", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const clock = new FakeClock();
    clock.setTime(1_000);
    FactoryController.create({ transport: new FakeTransport(), clock, store, config: defaultFactoryConfig() }, "factory_old", "old", cwd).dispose();
    clock.setTime(2_000);
    FactoryController.create({ transport: new FakeTransport(), clock, store, config: defaultFactoryConfig() }, "factory_new", "new", cwd).dispose();

    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-status").handler("", ctx);

    const text = notifications.find((n) => n.message.includes("Current run:"))?.message ?? "";
    expect(text).toContain("factory_new"); // newest wins
    expect(text).toContain("state: DISCOVERY");
    expect(text).toContain("repairRound:");
    expect(text).toContain("retries:");
    expect(text).toContain("Run configuration snapshot");
    expect(b.spawns).toHaveLength(0); // read-only
  });

  it("B2. /factory-status reports cleanly when there is no run", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);
    await b.commands.get("factory-status").handler("", ctx);
    expect(notifications.some((n) => n.message.includes("No Factory runs"))).toBe(true);
    expect(b.spawns).toHaveLength(0);
  });

  it("C. /factory-stop stops the active run safely with zero model requests", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store, config: defaultFactoryConfig() },
      "factory_stop_me",
      "t",
      cwd,
    ).dispose();

    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-stop").handler("", ctx);
    await flush();

    expect(notifications.some((n) => n.message.includes("Stopped Factory run"))).toBe(true);
    expect(store.load("factory_stop_me")?.state).toBe("STOPPED");
    expect(b.spawns).toHaveLength(0);
  });

  it("C2. /factory-stop reports cleanly when nothing is active", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);
    await b.commands.get("factory-stop").handler("", ctx);
    expect(notifications.some((n) => n.message.includes("No active Factory run"))).toBe(true);
    expect(b.spawns).toHaveLength(0);
  });

  it("D-cmd. /factory-config opens the interactive UI and starts no run (zero model requests)", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd, ["p/eng"]);

    await b.commands.get("factory-config").handler("", ctx);
    await flush();

    expect(ui.custom).toHaveBeenCalled(); // the wrapping menu was rendered
    expect(b.spawns).toHaveLength(0); // config operations never spawn a role
    const runsDir = join(cwd, ".pi", "factory");
    expect(existsSync(runsDir) ? readdirSync(runsDir).length : 0).toBe(0); // no run created
    expect(b.pi.setModel).not.toHaveBeenCalled();
  });

  it("14. project edits after loading a preset are live for the next /factory run", async () => {
    const cwd = workdir();
    savePreset(
      "go-balanced",
      mergeFactoryConfig(defaultFactoryConfig(), {
        roles: { lead: { targets: { primary: "opencode-go/deepseek-v4.1-flash" } } },
      }),
    );
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    // Loading replaces the working config: the preset's Lead is effective now.
    expect(factoryBaseState(cwd).effective.roles.lead.targets.primary).toBe("opencode-go/deepseek-v4.1-flash");
    // Edit the working copy — explicitly WITHOUT saving/updating any preset.
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "openai-codex/gpt-5.3-codex-spark" } } } });

    const b = await boot(cwd);
    const { ctx } = commandCtx(cwd, ["openai-codex/gpt-5.3-codex-spark", "opencode-go/deepseek-v4.1-flash"]);
    await b.commands.get("factory").handler("do it", ctx);
    await flush();

    // The run's Lead uses the edited project override...
    expect(b.spawns).toHaveLength(1);
    expect(b.spawns[0].options.model).toBe("openai-codex/gpt-5.3-codex-spark");
    // ...while the saved preset snapshot is untouched.
    expect(resolvePresetConfig("go-balanced").roles.lead.targets.primary).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("F. /factory-status labels run models as a historical snapshot", () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const controller = FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store, config: defaultFactoryConfig() },
      "factory_done",
      "t",
      cwd,
    );
    const snap = controller.getSnapshot();
    snap.state = "DONE";
    snap.metrics.roles.lead.targetUsed = "old/lead";
    controller.dispose();

    const text = formatRunStatus(snap);
    expect(text).toContain("Latest completed run: factory_done");
    expect(text).toContain("Run configuration snapshot");
    expect(text).toContain("lead: old/lead");
    expect(text).toContain("Use /factory-config to view the configuration for the next run.");
  });

  it("G. a completed run's snapshot and the next-run config are shown without ambiguity", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const controller = FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store, config: defaultFactoryConfig() },
      "factory_prev",
      "t",
      cwd,
    );
    const done = controller.getSnapshot();
    done.state = "DONE";
    // Version-2 DONE snapshots must carry the accepted final packet. This is
    // the persisted-state invariant exercised by Task 1 validation.
    done.results.finalReport = { packet: packets.finalReport, agentId: "legacy-test-report" };
    done.metrics.roles.lead.targetUsed = "old/lead";
    store.save(done);
    controller.dispose();
    // The configuration for the NEXT run differs from the completed run's snapshot.
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "new/lead" } } } });

    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd, ["old/lead", "new/lead"]);

    await b.commands.get("factory-status").handler("", ctx);
    const statusText = notifications.find((n) => n.message.includes("Latest completed run"))?.message ?? "";
    // The run snapshot shows the historical model; the next-run config is
    // inspected separately via /factory-config (covered in config.test).
    expect(statusText).toContain("old/lead");
    expect(statusText).toContain("Run configuration snapshot");
    expect(statusText).not.toContain("new/lead");
    expect(b.spawns).toHaveLength(0);
  });
});

/** A completed (DONE) run state carrying a persisted final report. */
function completedState(
  cwd: string,
  runId: string,
  summary: string,
  overrides: Partial<FactoryRunState> = {},
): FactoryRunState {
  return {
    version: 1,
    runId,
    createdAt: 1_000,
    updatedAt: 2_000,
    task: "t",
    cwd,
    config: defaultFactoryConfig(),
    state: "DONE",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "arch",
    remediationRounds: 0,
    architectEscalations: 0,
    leadEscalations: 0,
    results: {
      engineers: [],
      reviewers: [],
      finalReport: { packet: { ...packets.finalReport, summary }, agentId: "x" },
    },
    metrics: { ...emptyFactoryMetrics(1_000), runEndedAt: 2_000, runDurationMs: 1_000 },
    errors: [],
    parked: false,
    ...overrides,
  };
}

describe("AI Factory — /factory-report", () => {
  it("E. prints the latest completed run's persisted final report", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    store.save(completedState(cwd, "factory_old_report", "Old report summary.", { updatedAt: 1_000 }));
    store.save(completedState(cwd, "factory_new_report", "New report summary.", { updatedAt: 3_000 }));
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-report").handler("", ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    expect(text).toContain("factory_new_report");
    expect(text).toContain("New report summary.");
    expect(text).not.toContain("Old report summary.");
    expect(text).toContain("Full report persisted: .pi/factory/factory_new_report.json");
    expect(b.spawns).toHaveLength(0);
  });

  it("F. /factory-report <runId> prints that run's persisted report", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    store.save(completedState(cwd, "factory_old_report", "Old report summary.", { updatedAt: 1_000 }));
    store.save(completedState(cwd, "factory_new_report", "New report summary.", { updatedAt: 3_000 }));
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-report").handler("factory_old_report", ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    expect(text).toContain("factory_old_report");
    expect(text).toContain("Old report summary.");
    expect(text).not.toContain("New report summary.");
    expect(b.spawns).toHaveLength(0);
  });

  it("F2. explicit report request renders again after automatic delivery was recorded", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const state = completedState(cwd, "factory_report_again", "Report me again.");
    store.save(state);
    store.prepareReportDelivery(state.runId, 1_000);
    store.markReportDelivered(state.runId, "DONE", 2_000);
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-report").handler(state.runId, ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    expect(text).toContain("factory_report_again");
    expect(text).toContain("Report me again.");
    expect(b.spawns).toHaveLength(0);
  });

  it("G. legacy remediation run uses the ACCEPT recheck, not the stale integration", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    // `factory_mu7ct43l_Vqof08` shape: integration produced BEFORE remediation
    // (explicitly not accepted), then a later recheck ACCEPT. No finalReport.
    const staleIntegration = {
      ...packets.integration,
      systemVerification: "pre-remediation checks failed",
      factualAssessment: "NOT ACCEPTED - remediation required",
    };
    store.save(completedState(cwd, "factory_mu7ct43l_Vqof08", "", {
      remediationRounds: 1,
      metrics: { ...emptyFactoryMetrics(1_000), runEndedAt: 2_000, runDurationMs: 1_777_000 },
      results: {
        engineers: [{ round: 0, outcome: { packet: packets.engineer, agentId: "e0" } }],
        reviewers: [],
        integration: { packet: staleIntegration, agentId: "i" },
        finalArchitect: { packet: packets.remediate, agentId: "fa" },
        remediation: {
          engineer: { packet: packets.engineer, agentId: "re" },
          reviewer: { packet: packets.reviewerPass, agentId: "rr" },
        },
        finalRecheck: { packet: packets.accept, agentId: "fr" },
      },
    }));
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-report").handler("", ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    // The later ACCEPT is authoritative; the stale rejection is only history.
    expect(text).toContain("Result: ACCEPT");
    expect(text).toContain("Source: LEGACY FALLBACK — Final Architect recheck");
    expect(text).toContain("Duration: 29m 37s");
    expect(text).toContain("Remediation rounds: 1");
    expect(text).toContain("Remediation history");
    expect(text).toContain("- Initial integration: NOT ACCEPTED");
    expect(text).toContain("- Reviewer: PASS");
    expect(text).toContain("- Final Architect recheck: ACCEPT");
    expect(text).toContain("Final accepted evidence");
    expect(text).toContain("No post-remediation Lead synthesis exists for this historical run.");
    // Terminology guard: the stale integration must never read as accepted.
    expect(text).not.toContain("Accepted integration");
    expect(text).not.toContain("NOT ACCEPTED - remediation required");
    expect(b.spawns).toHaveLength(0);
  });

  it("G2. a legacy run accepted at the initial final gate uses that gate", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    store.save(completedState(cwd, "factory_legacy_gate", "", {
      results: {
        engineers: [],
        reviewers: [],
        integration: { packet: packets.integration, agentId: "i" },
        finalArchitect: { packet: packets.accept, agentId: "fa" },
      },
    }));
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-report").handler("", ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    expect(text).toContain("Result: ACCEPT");
    expect(text).toContain("Source: LEGACY FALLBACK — Final Architect");
    expect(text).toContain("Final Architect: ACCEPT");
    expect(text).not.toContain("Remediation history");
    expect(b.spawns).toHaveLength(0);
  });

  it("G3. a legacy run with no accepted artifact is labelled rejected", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    store.save(completedState(cwd, "factory_legacy_rejected", "", {
      state: "STOPPED",
      results: {
        engineers: [],
        reviewers: [],
        integration: { packet: packets.integration, agentId: "i" },
        finalArchitect: { packet: packets.remediate, agentId: "fa" },
      },
    }));
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    // Explicit id: a STOPPED run is not a "latest completed" run, but asking for
    // it must still render the rejected result honestly.
    await b.commands.get("factory-report").handler("factory_legacy_rejected", ctx);

    const text = notifications.find((n) => n.message.includes("Factory final report"))?.message ?? "";
    expect(text).toContain("Result: NOT ACCEPTED");
    expect(text).toContain("Source: LEGACY FALLBACK — no accepted final artifact");
    expect(text).toContain("Latest integration (NOT accepted)");
    expect(text).not.toContain("Accepted integration");
    expect(b.spawns).toHaveLength(0);
  });
});

describe("AI Factory — /factory-status compactness", () => {
  it("H. a live run shows the compact live fields", () => {
    const state = completedState("/tmp/x", "factory_live", "unused");
    state.state = "EXECUTION";
    state.results = { engineers: [], reviewers: [] };
    state.inFlight = { role: "engineer", phase: "execution.engineer", agentId: "a", target: "p/eng", spawnedAt: 1_000 };
    state.metrics.roles.engineer.targetUsed = "p/eng";

    const text = formatRunStatus(state);
    expect(text).toContain("Current run: factory_live");
    expect(text).toContain("state: EXECUTION");
    expect(text).toContain("phase: execution.engineer   active role: engineer");
    expect(text).toContain("active model: p/eng");
    expect(text).toContain("elapsed:");
    expect(text).toContain("retries:");
  });

  it("I. a completed run shows a compact summary, not the full report", () => {
    const state = completedState("/tmp/x", "factory_done2", "UNIQUE SUMMARY SENTINEL");
    state.metrics.roles.lead.targetUsed = "old/lead";

    const text = formatRunStatus(state);
    expect(text).toContain("Latest completed run: factory_done2");
    expect(text).toContain("result: ACCEPT");
    expect(text).toContain("final HEAD: abc1234");
    expect(text).toContain("commits: 1");
    expect(text).toContain("validation: npm test: pass");
    expect(text).toContain("human verification: PENDING (1)");
    expect(text).not.toContain("UNIQUE SUMMARY SENTINEL");
  });

  it("M. the Factory commands register distinctly without aliases", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    for (const name of ["factory-status", "factory-report", "factory-metrics"]) {
      expect(b.commands.has(name), `missing command ${name}`).toBe(true);
    }
    expect(b.commands.has("factory-stats")).toBe(false);
    expect(b.commands.has("factory-summary")).toBe(false);
  });

  it("N. /factory-metrics reads persisted metrics without a model call", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const state = completedState(cwd, "factory_metrics", "s");
    state.metrics.roles.lead.attempts = 2;
    state.metrics.roles.lead.targetUsed = "p/lead";
    state.metrics.calls = [
      { role: "lead", phase: "discovery.lead", agentId: "a", ok: true, input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, logicalTokens: 160, cost: 0.01, durationMs: 10 },
    ];
    store.save(state);

    const b = await boot(cwd);
    const { ctx } = commandCtx(cwd);

    await b.commands.get("factory-metrics").handler("", ctx);

    // Rendered at the bottom as a normal command-result message, not a toast.
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = b.pi.sendMessage.mock.calls[0][0];
    expect(msg.customType).toBe("factory-metrics");
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Run: factory_metrics");
    expect(msg.content).toMatch(/Total\s+2/);
    expect(msg.content).toMatch(/Input\s+100/);
    expect(msg.content).toContain("p/lead"); // canonical identity, from the role aggregate
    expect(b.spawns).toHaveLength(0);
  });

  it("E-metrics. /factory-metrics performs no model call", async () => {
    const cwd = workdir();
    const store = new FactoryStore(cwd);
    const state = completedState(cwd, "factory_metrics_ro", "s");
    state.metrics.roles.lead.attempts = 1;
    state.metrics.roles.lead.modelId = "opencode-go/deepseek-v4.1-flash";
    store.save(state);

    const b = await boot(cwd);
    const { ctx } = commandCtx(cwd);

    await b.commands.get("factory-metrics").handler("factory_metrics_ro", ctx);

    expect(b.pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = b.pi.sendMessage.mock.calls[0][0];
    expect(msg.customType).toBe("factory-metrics");
    expect(msg.content).toContain("opencode-go/deepseek-v4.1-flash");
    expect(b.spawns).toHaveLength(0);
    expect(b.emitted).not.toContain("subagents:rpc:spawn");
  });
});

describe("AI Factory — run panel visibility (/factory-verbose)", () => {
  it("P. /factory registers the compact run panel widget above the editor", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd);

    await b.commands.get("factory").handler("do it", ctx);
    await flush();

    expect(ui.setWidget).toHaveBeenCalledWith("factory", expect.any(Function), { placement: "aboveEditor" });
    const lines = renderFactoryPanel(ui);
    const text = lines.join("\n");
    // Orchestration only: run id, state, active role/phase and counters.
    expect(text).toContain("Factory ");
    expect(text).toContain("State: DISCOVERY");
    expect(text).toContain("Active: lead — discovery.lead");
    expect(text).toContain("Repair 0/");
    // It never duplicates the pi-subagents agent tree.
    expect(text).not.toContain("Agents");
  });

  it("Q. with no argument reports the current mode and usage, with no model call", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-verbose").handler("", ctx);

    const text = notifications[notifications.length - 1]?.message ?? "";
    expect(text).toContain("Factory panel visibility: on");
    expect(text).toContain("Usage: /factory-verbose");
    expect(text).toContain("exact-phase");
    expect(b.spawns).toHaveLength(0);
  });

  it("R. off sets the mode, keeps progress, and opens no live view", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui, notifications } = commandCtx(cwd);
    await b.commands.get("factory").handler("do it", ctx);
    await flush();

    await b.commands.get("factory-verbose").handler("off", ctx);

    const text = notifications[notifications.length - 1]?.message ?? "";
    expect(text).toContain("Factory panel visibility: off");
    expect(text).toContain("compact progress only");
    expect(ui.custom).not.toHaveBeenCalled(); // no focused live view
    expect(text).not.toContain("Opening the live view");
    // The compact summary is still shown, now reporting the mode.
    expect(renderFactoryPanel(ui).join("\n")).toContain("Visibility: off");
    expect(b.spawns).toHaveLength(1); // only the run's first spawn
    expect(b.pi.sendMessage).not.toHaveBeenCalled(); // no context/message pollution
  });

  it("S. on/active/role/phase open the focused live view (no model call)", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui, notifications } = commandCtx(cwd);
    await b.commands.get("factory").handler("do it", ctx);
    await flush();

    for (const arg of ["active", "on", "engineer", "execution.engineer"]) {
      ui.custom.mockClear();
      notifications.length = 0;
      await b.commands.get("factory-verbose").handler(arg, ctx);
      expect(ui.custom, arg).toHaveBeenCalledTimes(1);
      const options = ui.custom.mock.calls[0]?.[1];
      expect(options, arg).toMatchObject({ overlay: true });
      expect(options?.overlayOptions, arg).toMatchObject({ width: "90%", maxHeight: "70%" });
      expect(notifications[notifications.length - 1]?.message ?? "", arg).toContain("Opening the live view");
    }

    // The two commands above never spawned a role or sent a message.
    expect(b.spawns).toHaveLength(1);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("T. the summary follows the active agent as the run advances", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd);
    await b.commands.get("factory").handler("do it", ctx);
    await flush();

    expect(renderFactoryPanel(ui).join("\n")).toContain("Active: lead — discovery.lead");

    await completeChild(b, packets.proposal); // spawns the architect
    expect(renderFactoryPanel(ui).join("\n")).toContain("Active: architect — initial.architect");
    expect(b.spawns).toHaveLength(2);
  });

  it("U. an invalid argument shows help, changes nothing, and never spawns", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    await b.commands.get("factory-verbose").handler("bogus", ctx);
    expect(notifications[notifications.length - 1]?.message ?? "").toContain("Usage: /factory-verbose");

    // The mode is unchanged: still the default.
    await b.commands.get("factory-verbose").handler("", ctx);
    expect(notifications[notifications.length - 1]?.message ?? "").toContain("Factory panel visibility: on");
    expect(b.spawns).toHaveLength(0);
  });

  it("V. the mode persists across session switches and is shown on the new run panel", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx } = commandCtx(cwd);

    await b.commands.get("factory-verbose").handler("off", ctx);
    expect(b.spawns).toHaveLength(0);

    // A session switch disposes the panel and detaches runs...
    b.lifecycle.get("session_before_switch")();
    await b.lifecycle.get("session_start")({}, baseCtx({ cwd }));
    b.bus.emit("subagents:ready", {});

    // ...but the session's visibility preference survives.
    const { ctx: ctx2, ui: ui2, notifications } = commandCtx(cwd);
    await b.commands.get("factory-verbose").handler("", ctx2);
    expect(notifications[notifications.length - 1]?.message ?? "").toContain("Factory panel visibility: off");

    // A new run's panel reports the persisted mode.
    await b.commands.get("factory").handler("run again", ctx2);
    await flush();
    expect(renderFactoryPanel(ui2).join("\n")).toContain("Visibility: off");
  });

  it("W. /factory-agent is a deprecated alias over the same visibility state", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, notifications } = commandCtx(cwd);

    expect(b.commands.has("factory-agent")).toBe(true);
    await b.commands.get("factory-agent").handler("off", ctx);
    expect(notifications[notifications.length - 1]?.message ?? "").toContain("Factory panel visibility: off");

    // The single state system reports the same mode through /factory-verbose.
    await b.commands.get("factory-verbose").handler("", ctx);
    expect(notifications[notifications.length - 1]?.message ?? "").toContain("Factory panel visibility: off");
    expect(b.spawns).toHaveLength(0);
  });
});
