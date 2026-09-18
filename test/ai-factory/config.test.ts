/**
 * ai-factory/config.test.ts — config resolution, project writes, presets and
 * validation (spec tests D, E, F, plus backwards compatibility).
 *
 * All file I/O is hermetic (temp cwd + temp PI_CODING_AGENT_DIR). No model or
 * pi-subagents is involved.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearProjectRole,
  defaultFactoryConfig,
  factoryConfigPath,
  loadFactoryConfig,
  mergeFactoryConfig,
  projectPresetName,
  readProjectConfig,
  setProjectPreset,
  validateFactoryConfig,
  writeProjectConfig,
} from "../../src/ai-factory/config.js";
import { type ConfigUI, showFactoryConfigUI } from "../../src/ai-factory/config-ui.js";
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
  select: (title: string, options: string[]) => string | undefined;
  input?: (title: string) => string | undefined;
  confirm?: (title: string) => boolean;
}): ScriptedUI {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    select: async (title, options) => handlers.select(title, options),
    input: async (title) => handlers.input?.(title),
    confirm: async (title) => handlers.confirm?.(title) ?? false,
    notify: (message, type) => {
      notifications.push({ message, type });
    },
  };
}

describe("AI Factory — config resolution and validation", () => {
  it("D. the config UI writes valid .pi/factory.json that loadFactoryConfig reflects", async () => {
    const cwd = workdir();
    const models = ["p/lead", "p/arch", "p/eng", "p/rev"];
    let main = 0;
    let roleCalls = 0;
    let limitCalls = 0;
    const ui = scriptedUI({
      select: (title, options) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          if (main === 1) return options.find((o) => o.startsWith("Engineer "));
          if (main === 2) return options.find((o) => o.startsWith("Limits "));
          return "Done";
        }
        if (title === "Engineer configuration") {
          roleCalls++;
          return roleCalls === 1 ? "Set primary model" : "Back";
        }
        if (title === "Select model for Engineer") return "p/eng";
        if (title === "Factory limits") {
          limitCalls++;
          return limitCalls === 1 ? options.find((o) => o.startsWith("maxRepairRounds:")) : "Back";
        }
        return undefined;
      },
      input: (title) => (title === "maxRepairRounds" ? "3" : undefined),
    });

    await showFactoryConfigUI(ui, { cwd, models });

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

    // A project override wins over the preset, and the preset's fallback survives.
    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "project/eng" } } } });
    const overridden = loadFactoryConfig(cwd);
    expect(overridden.roles.engineer.targets.primary).toBe("project/eng");
    expect(overridden.roles.engineer.targets.fallbacks).toEqual(["preset/eng2"]);

    // Clearing the preset selection falls back to built-in defaults once the
    // project override is cleared too (preset selection and project overrides
    // are independent).
    setProjectPreset(cwd, undefined);
    expect(projectPresetName(cwd)).toBeUndefined();
    clearProjectRole(cwd, "engineer");
    expect(loadFactoryConfig(cwd).roles.engineer.targets.primary).toBe("provider/engineer-model");
  });

  it("E2. the UI saves the current config as a named preset and activates it", async () => {
    const cwd = workdir();
    writeProjectConfig(cwd, { roles: { engineer: { targets: { primary: "p/eng" } } } });
    let main = 0;
    let presetCalls = 0;
    const ui = scriptedUI({
      select: (title, options) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? options.find((o) => o.startsWith("Presets")) : "Done";
        }
        if (title === "Factory presets") {
          presetCalls++;
          if (presetCalls === 1) return "Save current config as new preset";
          if (presetCalls === 2) return "Set active preset";
          return "Back";
        }
        if (title === "Active preset") return "snap";
        return undefined;
      },
      input: (title) => (title === "New preset name" ? "snap" : undefined),
    });

    await showFactoryConfigUI(ui, { cwd, models: ["p/eng"] });

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

    let main = 0;
    const ui = scriptedUI({
      select: (title) => {
        if (title.startsWith("Factory configuration")) {
          main++;
          return main === 1 ? "Done" : undefined;
        }
        return undefined;
      },
    });
    await showFactoryConfigUI(ui, { cwd, models: ["p/eng"] });
    expect(ui.notifications.some((n) => n.type === "warning" && n.message.includes("not currently available"))).toBe(true);
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
    expect(raw?.roles?.engineer?.targets?.primary).toBe("p/eng"); // preserved
    expect(raw?.roles?.engineer?.maxTurns).toBe(42); // merged
    expect(raw?.roles?.lead?.targets?.primary).toBe("p/lead"); // preserved
    expect(raw?.maxRepairRounds).toBe(2); // preserved

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
