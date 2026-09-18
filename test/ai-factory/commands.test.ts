/**
 * ai-factory/commands.test.ts — slash-command dispatch, status, stop and
 * config (spec tests A, B, C, H).
 *
 * The extension is booted for real against a dispatching bus that stands in for
 * pi-subagents, so a command's effect on the RPC channel is observable. There is
 * no model anywhere: "zero model requests" means zero `subagents:rpc:spawn`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFactoryConfig, projectPresetName, writeProjectConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import factoryExtension from "../../src/ai-factory/index.js";
import { savePreset } from "../../src/ai-factory/presets.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import { ctx as baseCtx, hermeticDir, makePi } from "../helpers/boot-extension.js";
import { FakeClock, FakeTransport, flush } from "./fakes.js";

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
  pi.events = b.bus;
  factoryExtension(pi);
  await lifecycle.get("session_start")({}, baseCtx({ cwd }));
  b.bus.emit("subagents:ready", {});
  return { pi, tools, commands, lifecycle, ...b };
}

/** A command context with a scriptable UI and a model registry. */
function commandCtx(cwd: string, models: string[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ui = {
    select: vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined),
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

    const text = notifications.find((n) => n.message.includes("Factory run"))?.message ?? "";
    expect(text).toContain("factory_new"); // newest wins
    expect(text).toContain("state: DISCOVERY");
    expect(text).toContain("repairRound:");
    expect(text).toContain("retries:");
    expect(text).toContain("targets:");
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

  it("D-cmd. /factory-config writes project config through the UI with zero model requests", async () => {
    const cwd = workdir();
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd, ["p/eng"]);
    let main = 0;
    let roleCalls = 0;
    ui.select.mockImplementation(async (title: string, options: string[]) => {
      if (title.startsWith("Factory configuration")) {
        main++;
        return main === 1 ? options.find((o) => o.startsWith("Engineer ")) : "Done";
      }
      if (title === "Engineer configuration") {
        roleCalls++;
        return roleCalls === 1 ? "Set primary model" : "Back";
      }
      if (title === "Select model for Engineer") return "p/eng";
      return undefined;
    });

    await b.commands.get("factory-config").handler("", ctx);

    expect(b.spawns).toHaveLength(0);
    expect(readFileSync(join(cwd, ".pi", "factory.json"), "utf8")).toContain("p/eng");
  });

  it("H2. activating a Factory preset starts no run and leaves Pi's chat model unchanged", async () => {
    const cwd = workdir();
    savePreset("go-balanced", defaultFactoryConfig());
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd, ["p/eng"]);
    let main = 0;
    let presetCalls = 0;
    ui.select.mockImplementation(async (title: string, options: string[]) => {
      if (title.startsWith("Factory configuration")) {
        main++;
        return main === 1 ? options.find((o) => o.startsWith("Presets")) : "Done";
      }
      if (title === "Factory presets") {
        presetCalls++;
        return presetCalls === 1 ? "Set active preset" : "Back";
      }
      if (title === "Active Factory preset") return "go-balanced";
      return undefined;
    });

    await b.commands.get("factory-config").handler("", ctx);
    await flush();

    expect(projectPresetName(cwd)).toBe("go-balanced"); // selection was written
    expect(b.spawns).toHaveLength(0); // no Factory run / zero model requests
    const runsDir = join(cwd, ".pi", "factory");
    expect(existsSync(runsDir) ? readdirSync(runsDir).length : 0).toBe(0);
    expect(b.pi.setModel).not.toHaveBeenCalled(); // chat model untouched by preset activation
  });

  it("H3. explicitly choosing a Pi chat model calls pi.setModel (and starts no run)", async () => {
    const cwd = workdir();
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "p/lead" } } } });
    const b = await boot(cwd);
    const { ctx, ui } = commandCtx(cwd, ["p/lead", "p/eng"]);
    let main = 0;
    ui.select.mockImplementation(async (title: string, options: string[]) => {
      if (title.startsWith("Factory configuration")) {
        main++;
        return main === 1 ? options.find((o) => o.startsWith("Pi chat model:")) : "Done";
      }
      if (title === "Pi chat model (separate from Factory roles)") return "Choose model…";
      if (title === "Choose Pi chat model") return "p/eng";
      return undefined;
    });

    await b.commands.get("factory-config").handler("", ctx);
    await flush();

    expect(b.pi.setModel).toHaveBeenCalledTimes(1);
    expect(b.spawns).toHaveLength(0);
  });
});
