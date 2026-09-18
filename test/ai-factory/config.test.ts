/**
 * ai-factory/config.test.ts — config resolution, project writes, presets,
 * working-copy semantics, model filtering and validation.
 *
 * All file I/O is hermetic (temp cwd + temp PI_CODING_AGENT_DIR). No model or
 * pi-subagents is involved; the UI is a scripted {@link ConfigUI}.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearProjectRole,
  defaultFactoryConfig,
  factoryBaseState,
  factoryConfigPath,
  loadFactoryConfig,
  loadPresetAsWorkingConfig,
  mergeFactoryConfig,
  projectPresetName,
  readProjectConfig,
  resolvePresetConfig,
  revertProjectOverrides,
  setProjectPreset,
  validateFactoryConfig,
  writeProjectConfig,
} from "../../src/ai-factory/config.js";
import {
  type ConfigUI,
  filterModels,
  type MenuRow,
  type ModelOption,
  showFactoryConfigUI,
} from "../../src/ai-factory/config-ui.js";
import { deletePreset, getRawPreset, listPresetNames, presetsPath, savePreset } from "../../src/ai-factory/presets.js";
import { hermeticDir } from "../helpers/boot-extension.js";

const hermetic: ReturnType<typeof hermeticDir>[] = [];
afterEach(() => {
  for (const h of hermetic.splice(0)) h.restore();
});

function workdir(): string {
  const h = hermeticDir({});
  hermetic.push(h);
  return h.dir;
}

interface ScriptedUI extends ConfigUI {
  notifications: Array<{ message: string; type?: string }>;
}

function scriptedUI(handlers: {
  menu: (title: string, rows: MenuRow[]) => string | undefined;
  pickModel?: (title: string, models: ModelOption[]) => string | undefined;
  input?: (title: string) => string | undefined;
  confirm?: (title: string) => boolean;
}): ScriptedUI {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    menu: async (title, rows) => handlers.menu(title, rows),
    pickModel: async (title, models) => handlers.pickModel?.(title, models),
    input: async (title) => handlers.input?.(title),
    confirm: async (title) => handlers.confirm?.(title) ?? false,
    notify: (message, type) => {
      notifications.push({ message, type });
    },
  };
}

/** Capture the top-level menu rows rendered for a project. */
async function mainMenuRows(cwd: string, deps: Partial<Parameters<typeof showFactoryConfigUI>[1]> = {}): Promise<MenuRow[]> {
  let seen: MenuRow[] = [];
  const ui = scriptedUI({
    menu: (title, rows) => {
      if (title.startsWith("Factory configuration")) {
        seen = rows;
        return "done";
      }
      return undefined;
    },
  });
  await showFactoryConfigUI(ui, { cwd, models: [], modelOptions: [], ...deps });
  return seen;
}

const rowById = (rows: MenuRow[], id: string): MenuRow | undefined => rows.find((r) => r.id === id);

/** Save a preset whose Lead points at `model` (everything else default). */
function saveLeadPreset(name: string, model: string): void {
  savePreset(name, mergeFactoryConfig(defaultFactoryConfig(), { roles: { lead: { targets: { primary: model } } } }));
}

const modelOption = (value: string, name = ""): ModelOption => ({
  value,
  label: value,
  ...(name ? { description: name } : {}),
  search: `${value.replace("/", " ")} ${name}`,
});

describe("AI Factory — model filtering", () => {
  const models: ModelOption[] = [
    modelOption("opencode-go/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
    modelOption("opencode-go/glm-5.3", "GLM 5.3"),
    modelOption("openai-codex/gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
    modelOption("omlx/Qwen3.8-27B-MLX-6bit", "Qwen3.8 27B"),
  ];
  const values = (query: string): string[] => filterModels(models, query).map((m) => m.value);

  it("A. partial fragments find the expected models", () => {
    expect(values("v4.1")).toContain("opencode-go/deepseek-v4.1-flash");
    expect(values("glm 5.3")).toContain("opencode-go/glm-5.3");
    expect(values("codex spark")).toContain("openai-codex/gpt-5.3-codex-spark");
    expect(values("qwen 27")).toContain("omlx/Qwen3.8-27B-MLX-6bit");
    expect(values("GLM")).toContain("opencode-go/glm-5.3"); // case-insensitive
  });

  it("C. empty query returns all; no match returns none cleanly", () => {
    expect(filterModels(models, "")).toHaveLength(models.length);
    expect(filterModels(models, "   ")).toHaveLength(models.length);
    expect(filterModels(models, "zzz-nope-not-a-model")).toEqual([]);
  });
});

describe("AI Factory — config resolution and validation", () => {
  it("D. the config UI writes valid .pi/factory.json that loadFactoryConfig reflects", async () => {
    const cwd = workdir();
    const models = ["p/lead", "p/arch", "p/eng", "p/rev"];
    let main = 0;
    let roleCalls = 0;
    let limitCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          if (main === 1) return "role:engineer";
          if (main === 2) return "limits";
          return "done";
        }
        if (title === "Engineer configuration") {
          roleCalls++;
          return roleCalls === 1 ? "primary" : "back";
        }
        if (title === "Factory limits") {
          limitCalls++;
          return limitCalls === 1 ? "maxRepairRounds" : "back";
        }
        return undefined;
      },
      pickModel: (title) => (title === "Select primary model" ? "p/eng" : undefined),
      input: (title) => (title === "maxRepairRounds" ? "3" : undefined),
    });

    await showFactoryConfigUI(ui, { cwd, models, modelOptions: models.map((m) => modelOption(m)) });

    const path = factoryConfigPath(cwd);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      roles?: { engineer?: { targets?: { primary?: string } } };
      maxRepairRounds?: number;
    };
    expect(raw.roles?.engineer?.targets?.primary).toBe("p/eng");
    expect(raw.maxRepairRounds).toBe(3);

    const effective = loadFactoryConfig(cwd);
    expect(effective.roles.engineer.targets.primary).toBe("p/eng");
    expect(effective.maxRepairRounds).toBe(3);
  });

  it("B(filter). a filtered selection writes the canonical provider/id", async () => {
    const cwd = workdir();
    const options = [
      modelOption("opencode-go/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
      modelOption("opencode-go/glm-5.3", "GLM 5.3"),
    ];
    let main = 0;
    let roleCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "role:lead" : "done";
        }
        if (title === "Lead configuration") {
          roleCalls++;
          return roleCalls === 1 ? "primary" : "back";
        }
        return undefined;
      },
      // Choose the model a user would get by typing "v4.1".
      pickModel: (title) => (title === "Select primary model" ? filterModels(options, "v4.1")[0]?.value : undefined),
    });
    await showFactoryConfigUI(ui, { cwd, models: options.map((m) => m.value), modelOptions: options });

    expect(loadFactoryConfig(cwd).roles.lead.targets.primary).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("C(ui). a cancelled model selection leaves the config unchanged", async () => {
    const cwd = workdir();
    let main = 0;
    let roleCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "role:lead" : "done";
        }
        if (title === "Lead configuration") {
          roleCalls++;
          return roleCalls === 1 ? "primary" : "back";
        }
        return undefined;
      },
      pickModel: () => undefined, // no match / cancelled
    });
    await showFactoryConfigUI(ui, { cwd, models: [], modelOptions: [] });
    expect(readProjectConfig(cwd)?.roles).toBeUndefined();
  });

  it("E. a preset resolves role models; project overrides win; clearing restores defaults", () => {
    const cwd = workdir();
    const preset = mergeFactoryConfig(defaultFactoryConfig(), {
      roles: { engineer: { targets: { primary: "preset/eng", fallbacks: ["preset/eng2"] } } },
    });
    savePreset("fast", preset);
    setProjectPreset(cwd, "fast");
    expect(projectPresetName(cwd)).toBe("fast");

    const effective = loadFactoryConfig(cwd);
    expect(effective.roles.engineer.targets.primary).toBe("preset/eng");
    expect(effective.roles.engineer.targets.fallbacks).toEqual(["preset/eng2"]);

    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "project/eng" } } } });
    const overridden = loadFactoryConfig(cwd);
    expect(overridden.roles.engineer.targets.primary).toBe("project/eng");
    expect(overridden.roles.engineer.targets.fallbacks).toEqual(["preset/eng2"]);

    setProjectPreset(cwd, undefined);
    expect(projectPresetName(cwd)).toBeUndefined();
    clearProjectRole(cwd, "engineer");
    expect(loadFactoryConfig(cwd).roles.engineer.targets.primary).toBe("provider/engineer-model");
  });

  it("E2. the UI saves the current config as a named preset and makes it the base", async () => {
    const cwd = workdir();
    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "p/eng" } } } });
    let main = 0;
    let presetCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "presets" : "done";
        }
        if (title.startsWith("Factory presets")) {
          presetCalls++;
          return presetCalls === 1 ? "save-new" : "back";
        }
        return undefined;
      },
      input: (title) => (title === "New preset name" ? "snap" : undefined),
    });

    await showFactoryConfigUI(ui, { cwd, models: ["p/eng"], modelOptions: [modelOption("p/eng")] });

    expect(listPresetNames()).toContain("snap");
    expect(getRawPreset("snap")).toBeDefined();
    expect(projectPresetName(cwd)).toBe("snap");
    expect(loadFactoryConfig(cwd).roles.engineer.targets.primary).toBe("p/eng");
  });

  it("F. unavailable model selections are surfaced", async () => {
    const cwd = workdir();
    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "missing/model" } } } });
    const issues = validateFactoryConfig(loadFactoryConfig(cwd), ["p/eng"]);
    expect(issues.some((i) => i.includes("missing/model") && i.includes("not currently available"))).toBe(true);

    const ui = scriptedUI({ menu: () => "done" });
    await showFactoryConfigUI(ui, { cwd, models: ["p/eng"], modelOptions: [modelOption("p/eng")] });
    expect(ui.notifications.some((n) => n.type === "warning" && n.message.includes("not currently available"))).toBe(true);
  });

  it("G. Pi chat model is displayed/explained and changed only on explicit selection", async () => {
    const cwd = workdir();
    const models = ["p/lead", "p/eng"];
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "p/lead" } } } });

    // (a) explanation + "Leave unchanged" calls nothing.
    let mainA = 0;
    const leftUnchanged: string[] = [];
    const uiA = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          mainA++;
          return mainA === 1 ? "scopes" : mainA === 2 ? "pi-chat" : "done";
        }
        if (title.startsWith("Pi chat model")) return "leave";
        return undefined;
      },
    });
    await showFactoryConfigUI(uiA, {
      cwd,
      models,
      modelOptions: models.map((m) => modelOption(m)),
      chatModel: "omlx/qwen",
      setChatModel: async (label) => {
        leftUnchanged.push(label);
        return true;
      },
    });
    expect(uiA.notifications.some((n) => n.message.includes("Pi's ordinary chat model are separate"))).toBe(true);
    expect(leftUnchanged).toEqual([]);

    // (b) "Same as Factory Lead" sets the chat model explicitly.
    const applied: string[] = [];
    let mainB = 0;
    const uiB = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          mainB++;
          return mainB === 1 ? "pi-chat" : "done";
        }
        if (title.startsWith("Pi chat model")) return "same-as-lead";
        return undefined;
      },
    });
    await showFactoryConfigUI(uiB, {
      cwd,
      models,
      modelOptions: models.map((m) => modelOption(m)),
      chatModel: "omlx/qwen",
      setChatModel: async (label) => {
        applied.push(label);
        return true;
      },
    });
    expect(applied).toEqual(["p/lead"]);

    // (c) an unavailable Lead model is surfaced, not applied.
    const appliedC: string[] = [];
    let mainC = 0;
    const uiC = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          mainC++;
          return mainC === 1 ? "pi-chat" : "done";
        }
        if (title.startsWith("Pi chat model")) return "same-as-lead";
        return undefined;
      },
    });
    await showFactoryConfigUI(uiC, {
      cwd,
      models: ["p/eng"],
      modelOptions: [modelOption("p/eng")],
      chatModel: "omlx/qwen",
      setChatModel: async (label) => {
        appliedC.push(label);
        return true;
      },
    });
    expect(appliedC).toEqual([]);
    expect(uiC.notifications.some((n) => n.type === "warning" && n.message.includes("not currently available"))).toBe(true);
  });

  it("project writes deep-merge and clearProjectRole removes only that role", () => {
    const cwd = workdir();
    writeProjectConfig(cwd, {
      roles: { lead: { targets: { primary: "p/lead" } }, engineer: { targets: { primary: "p/eng" } } },
      maxRepairRounds: 2,
      preset: "unused",
    });
    writeProjectConfig(cwd, { roles: { engineer: { maxTurns: 42 } } });

    type Roles = Record<string, { targets?: { primary?: string }; maxTurns?: number }>;
    const raw = readProjectConfig(cwd) as { roles?: Roles; maxRepairRounds?: number } | undefined;
    expect(raw?.roles?.engineer?.targets?.primary).toBe("p/eng");
    expect(raw?.roles?.engineer?.maxTurns).toBe(42);
    expect(raw?.roles?.lead?.targets?.primary).toBe("p/lead");
    expect(raw?.maxRepairRounds).toBe(2);

    clearProjectRole(cwd, "engineer");
    const after = readProjectConfig(cwd) as { roles?: Roles } | undefined;
    expect(after?.roles?.engineer).toBeUndefined();
    expect(after?.roles?.lead).toBeDefined();
  });

  it("existing project config without a preset key stays backwards compatible", () => {
    const cwd = workdir();
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "p/lead" } } }, maxRepairRounds: 2 });
    const cfg = loadFactoryConfig(cwd);
    expect(cfg.roles.lead.targets.primary).toBe("p/lead");
    expect(cfg.maxRepairRounds).toBe(2);
    expect(projectPresetName(cwd)).toBeUndefined();
  });

  it("preset store round-trips, reports names and deletes", () => {
    workdir();
    expect(presetsPath().endsWith("factory-presets.json")).toBe(true);
    expect(listPresetNames()).toEqual([]);
    savePreset("a", defaultFactoryConfig());
    savePreset("b", defaultFactoryConfig());
    expect(listPresetNames()).toEqual(["a", "b"]);
    expect(getRawPreset("a")).toBeDefined();
    expect(deletePreset("a")).toBe(true);
    expect(deletePreset("a")).toBe(false);
    expect(listPresetNames()).toEqual(["b"]);
  });
});

describe("AI Factory — preset base vs effective working copy", () => {
  it("A. an exact preset match shows the configuration with no * marker", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");

    const state = factoryBaseState(cwd);
    expect(state.preset).toBe("go-balanced");
    expect(state.dirty).toBe(false);

    const rows = await mainMenuRows(cwd, { models: ["m/base"] });
    expect(rowById(rows, "config")?.value).toBe("go-balanced");
    expect(rowById(rows, "config-based")).toBeUndefined();
    expect(rowById(rows, "role:lead")?.value).toBe("m/base");
  });

  it("A2. loading a preset replaces the working config and clears prior overrides", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    writeProjectConfig(cwd, {
      roles: { lead: { targets: { primary: "m/prev" } }, engineer: { targets: { primary: "m/eng" } } },
      maxRepairRounds: 7,
    });
    expect(factoryBaseState(cwd).dirty).toBe(true);

    let main = 0;
    let presetCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "presets" : "done";
        }
        if (title.startsWith("Factory presets")) {
          presetCalls++;
          return presetCalls === 1 ? "load" : "back";
        }
        if (title === "Load preset") return "preset:go-balanced";
        return undefined;
      },
      confirm: (title) => title === "Load preset",
    });
    await showFactoryConfigUI(ui, { cwd, models: ["m/base", "m/eng"], modelOptions: [] });

    const state = factoryBaseState(cwd);
    expect(state.preset).toBe("go-balanced");
    expect(state.dirty).toBe(false);
    expect(state.effective).toEqual(resolvePresetConfig("go-balanced"));
    expect(state.effective.roles.lead.targets.primary).toBe("m/base");
    expect(state.effective.roles.engineer.targets.primary).toBe("provider/engineer-model");
    expect(state.effective.maxRepairRounds).toBe(defaultFactoryConfig().maxRepairRounds);
    expect(readProjectConfig(cwd)).toEqual({ preset: "go-balanced" });
  });

  it("B. editing after loading changes the working config and marks it modified", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    expect(factoryBaseState(cwd).dirty).toBe(false);

    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "m/next" } } } });

    const state = factoryBaseState(cwd);
    expect(state.dirty).toBe(true);
    expect(state.effective.roles.lead.targets.primary).toBe("m/next");
    expect(resolvePresetConfig("go-balanced").roles.lead.targets.primary).toBe("m/base");

    const rows = await mainMenuRows(cwd, { models: ["m/next"] });
    expect(rowById(rows, "config")?.value).toBe("Modified");
    expect(rowById(rows, "config-based")?.value).toBe("go-balanced");
    expect(rowById(rows, "config-note")?.value).toBe("differs from go-balanced");
    expect(rowById(rows, "role:lead")?.value?.endsWith("*")).toBe(true);
    expect(rowById(rows, "role:architect")?.value?.endsWith("*")).toBe(false);
  });

  it("C. revert makes the effective config exactly the selected preset", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "m/next" } } }, maxRepairRounds: 9 });
    expect(factoryBaseState(cwd).dirty).toBe(true);

    revertProjectOverrides(cwd);

    const state = factoryBaseState(cwd);
    expect(state.dirty).toBe(false);
    expect(state.preset).toBe("go-balanced");
    expect(state.effective).toEqual(resolvePresetConfig("go-balanced"));
    expect(state.effective.roles.lead.targets.primary).toBe("m/base");
    expect(state.effective.maxRepairRounds).toBe(defaultFactoryConfig().maxRepairRounds);
  });

  it("C2. loading another preset does not leak the previous overrides", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    saveLeadPreset("other", "m/other");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "m/leak" } } } });
    expect(factoryBaseState(cwd).dirty).toBe(true);

    let main = 0;
    let presetCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "presets" : "done";
        }
        if (title.startsWith("Factory presets")) {
          presetCalls++;
          return presetCalls === 1 ? "load" : "back";
        }
        if (title === "Load preset") return "preset:other";
        return undefined;
      },
      confirm: (title) => title === "Load preset",
    });
    await showFactoryConfigUI(ui, { cwd, models: ["m/base", "m/other", "m/leak"], modelOptions: [] });

    const state = factoryBaseState(cwd);
    expect(state.preset).toBe("other");
    expect(state.dirty).toBe(false);
    expect(state.effective).toEqual(resolvePresetConfig("other"));
    expect(state.effective.roles.engineer.targets.primary).toBe("provider/engineer-model");
  });

  it("G(rows). individual rows mark only the changed roles/limits", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "m/next" } } } });

    let rows = await mainMenuRows(cwd, { models: ["m/next"] });
    expect(rowById(rows, "role:lead")?.value?.endsWith("*")).toBe(true);
    expect(rowById(rows, "role:engineer")?.value?.endsWith("*")).toBe(false);
    expect(rowById(rows, "limits")?.value?.endsWith("*")).toBe(false);

    writeProjectConfig(cwd, { maxRepairRounds: 5 });
    rows = await mainMenuRows(cwd, { models: ["m/next"] });
    expect(rowById(rows, "limits")?.value?.endsWith("*")).toBe(true);
  });

  it("D. saving the working config as a new preset leaves the old preset unchanged", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "m/next" } } } });

    let main = 0;
    let presetCalls = 0;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "presets" : "done";
        }
        if (title.startsWith("Factory presets")) {
          presetCalls++;
          return presetCalls === 1 ? "save-new" : "back";
        }
        return undefined;
      },
      input: (title) => (title === "New preset name" ? "snap" : undefined),
    });

    await showFactoryConfigUI(ui, { cwd, models: ["m/base", "m/next"], modelOptions: [] });

    expect(resolvePresetConfig("go-balanced").roles.lead.targets.primary).toBe("m/base");
    expect(resolvePresetConfig("snap").roles.lead.targets.primary).toBe("m/next");
    expect(projectPresetName(cwd)).toBe("snap");
    expect(factoryBaseState(cwd).dirty).toBe(false);
  });

  it("E. explicit update overwrites the base preset, requires confirmation, and is clean afterward", async () => {
    const cwd = workdir();
    saveLeadPreset("go-balanced", "m/base");
    loadPresetAsWorkingConfig(cwd, "go-balanced");
    writeProjectConfig(cwd, { roles: { lead: { targets: { primary: "m/next" } } } });

    let main = 0;
    let presetCalls = 0;
    let confirmed = false;
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "presets" : "done";
        }
        if (title.startsWith("Factory presets")) {
          presetCalls++;
          return presetCalls === 1 ? "update" : "back";
        }
        return undefined;
      },
      confirm: (title) => {
        if (title === "Update preset") {
          confirmed = true;
          return true;
        }
        return false;
      },
    });

    await showFactoryConfigUI(ui, { cwd, models: ["m/base", "m/next"], modelOptions: [] });

    expect(confirmed).toBe(true);
    expect(resolvePresetConfig("go-balanced").roles.lead.targets.primary).toBe("m/next");
    expect(factoryBaseState(cwd).dirty).toBe(false);
    expect(readProjectConfig(cwd)).toEqual({ preset: "go-balanced" });
  });

  it("fallback row management adds, reorders and removes fallbacks", async () => {
    const cwd = workdir();
    const options = [modelOption("m/a"), modelOption("m/b"), modelOption("m/c")];
    let main = 0;
    let role = 0;
    let fallbacks = 0;
    let action = 0;
    const added = ["m/a", "m/b"];
    const ui = scriptedUI({
      menu: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "role:engineer" : "done";
        }
        if (title === "Engineer configuration") {
          role++;
          return role === 1 ? "fallbacks" : "back";
        }
        if (title.startsWith("Engineer fallbacks")) {
          fallbacks++;
          // 1: add, 2: add, 3: open m/b (index 1), 4: open m/b (index 0), 5: back
          if (fallbacks === 1 || fallbacks === 2) return "add";
          if (fallbacks === 3) return "fb:1";
          if (fallbacks === 4) return "fb:0";
          return "back";
        }
        if (title.startsWith("Fallback ")) {
          action++;
          return action === 1 ? "up" : "remove"; // move m/b up, then remove m/b
        }
        return undefined;
      },
      pickModel: () => added.shift(),
    });
    await showFactoryConfigUI(ui, { cwd, models: options.map((m) => m.value), modelOptions: options });

    // Added [m/a, m/b] → moved m/b up → [m/b, m/a] → removed m/b → [m/a].
    expect(loadFactoryConfig(cwd).roles.engineer.targets.fallbacks).toEqual(["m/a"]);
  });
});
