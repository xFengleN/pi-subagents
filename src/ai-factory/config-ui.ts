/**
 * ai-factory/config-ui.ts — The interactive `/factory-config` menu.
 *
 * Built entirely from Pi's promise-based dialog primitives
 * (`select` / `input` / `confirm` / `notify`) — no custom TUI framework. Every
 * write is a deterministic file operation; no model is involved.
 *
 * Scopes the UI distinguishes:
 *   - project  — `<cwd>/.pi/factory.json` (role/limit overrides + active preset)
 *   - preset   — user-level named configs (`<getAgentDir()>/factory-presets.json`)
 *   - default  — built-in defaults (read-only view)
 */

import {
  clearProjectRole,
  defaultFactoryConfig,
  loadFactoryConfig,
  mergeFactoryConfig,
  projectPresetName,
  setProjectPreset,
  targetsForRole,
  validateFactoryConfig,
  writeProjectConfig,
} from "./config.js";
import { deletePreset, getRawPreset, hasPreset, listPresetNames, savePreset } from "./presets.js";
import { type FactoryConfig, ROLE_NAMES, type RoleName } from "./types.js";

export interface ConfigUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface FactoryConfigUIDeps {
  cwd: string;
  /** Available model ids as `provider/model`, from Pi's model registry. */
  models: string[];
}

const cap = (role: RoleName): string => role.charAt(0).toUpperCase() + role.slice(1);

function roleSummary(config: FactoryConfig, role: RoleName): string {
  const targets = targetsForRole(config, role);
  if (targets.length === 0) return "(no target)";
  const [primary, ...fallbacks] = targets;
  return fallbacks.length > 0 ? `${primary}  ←  ${fallbacks.join(", ")}` : primary;
}

/**
 * Run the config menu until the user exits. Returns when the menu is dismissed.
 * All mutations are persisted immediately to the project file or preset store.
 */
export async function showFactoryConfigUI(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const config = loadFactoryConfig(deps.cwd);
    const activePreset = projectPresetName(deps.cwd);
    const issues = validateFactoryConfig(config, deps.models);
    if (issues.length > 0) {
      ui.notify(`Factory config warnings:\n${issues.map((i) => `- ${i}`).join("\n")}`, "warning");
    }
    const options = [
      ...ROLE_NAMES.map((role) => `${cap(role)} — ${roleSummary(config, role)}`),
      `Limits — repair ${config.maxRepairRounds}, remediation ${config.maxArchitectRemediationRounds}`,
      `Presets… (${listPresetNames().length})`,
      `Active preset: ${activePreset ?? "(none)"}`,
      `View built-in defaults`,
      `Done`,
    ];
    const choice = await ui.select(`Factory configuration — ${deps.cwd}`, options);
    if (!choice || choice === "Done") return;

    if (choice.startsWith("Presets…")) {
      await presetsMenu(ui, deps);
    } else if (choice.startsWith("Active preset:")) {
      await chooseActivePreset(ui, deps);
    } else if (choice.startsWith("View built-in defaults")) {
      ui.notify(describeConfig(defaultFactoryConfig(), "Built-in Factory defaults"), "info");
    } else if (choice.startsWith("Limits")) {
      await limitsMenu(ui, deps);
    } else {
      const role = ROLE_NAMES.find((r) => choice.startsWith(`${cap(r)} `));
      if (role) await roleMenu(ui, deps, role);
    }
  }
}

async function roleMenu(ui: ConfigUI, deps: FactoryConfigUIDeps, role: RoleName): Promise<void> {
  for (;;) {
    const config = loadFactoryConfig(deps.cwd);
    const rc = config.roles[role];
    const options = [
      `Primary: ${rc.targets.primary}`,
      `Fallbacks: ${(rc.targets.fallbacks ?? []).join(", ") || "(none)"}`,
      "Set primary model",
      "Add fallback model",
      "Remove fallback model",
      `Max transient retries: ${rc.maxTransientRetries}`,
      `Retry delay: ${rc.retryDelayMs} ms`,
      `Max turns: ${rc.maxTurns ?? "(inherit)"}`,
      "Clear project override",
      "Back",
    ];
    const choice = await ui.select(`${cap(role)} configuration`, options);
    if (!choice || choice === "Back") return;

    if (choice === "Set primary model") {
      const model = await pickModel(ui, deps, role);
      if (model) writeProjectConfig(deps.cwd, { roles: { [role]: { targets: { primary: model } } } });
    } else if (choice === "Add fallback model") {
      const model = await pickModel(ui, deps, role);
      if (model && model !== rc.targets.primary && !(rc.targets.fallbacks ?? []).includes(model)) {
        writeProjectConfig(deps.cwd, {
          roles: { [role]: { targets: { fallbacks: [...(rc.targets.fallbacks ?? []), model] } } },
        });
      }
    } else if (choice === "Remove fallback model") {
      const fallbacks = rc.targets.fallbacks ?? [];
      if (fallbacks.length === 0) {
        ui.notify(`${cap(role)} has no fallbacks to remove.`, "info");
        continue;
      }
      const model = await ui.select(`Remove ${cap(role)} fallback`, fallbacks);
      if (model) {
        writeProjectConfig(deps.cwd, {
          roles: { [role]: { targets: { fallbacks: fallbacks.filter((f) => f !== model) } } },
        });
      }
    } else if (choice.startsWith("Max transient retries")) {
      await editInt(ui, deps, "Max transient retries", rc.maxTransientRetries, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { maxTransientRetries: v } } }));
    } else if (choice.startsWith("Retry delay")) {
      await editInt(ui, deps, "Retry delay (ms)", rc.retryDelayMs, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { retryDelayMs: v } } }));
    } else if (choice.startsWith("Max turns")) {
      await editInt(ui, deps, "Max turns (0 = inherit)", rc.maxTurns ?? 0, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { maxTurns: v } } }));
    } else if (choice === "Clear project override") {
      clearProjectRole(deps.cwd, role);
      ui.notify(`Cleared the project override for ${cap(role)}.`, "info");
    }
  }
}

async function limitsMenu(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const config = loadFactoryConfig(deps.cwd);
    const options = [
      `maxRepairRounds: ${config.maxRepairRounds}`,
      `maxArchitectRemediationRounds: ${config.maxArchitectRemediationRounds}`,
      `maxArchitectEscalations: ${config.maxArchitectEscalations}`,
      `maxLeadEscalations: ${config.maxLeadEscalations}`,
      `defaultRetryAfterMs: ${config.defaultRetryAfterMs}`,
      "Back",
    ];
    const choice = await ui.select("Factory limits", options);
    if (!choice || choice === "Back") return;
    const field = choice.split(":")[0] as keyof FactoryConfig;
    const current = config[field];
    if (typeof current !== "number") continue;
    await editInt(ui, deps, field, current, (v) => writeProjectConfig(deps.cwd, { [field]: v }));
  }
}

async function presetsMenu(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const names = listPresetNames();
    const options = [
      `Active preset: ${projectPresetName(deps.cwd) ?? "(none)"}`,
      "Set active preset",
      "Save current config as new preset",
      "Overwrite existing preset",
      "Delete preset",
      "View presets",
      "Back",
    ];
    const choice = await ui.select("Factory presets", options);
    if (!choice || choice === "Back") return;

    if (choice.startsWith("Active preset:")) {
      await chooseActivePreset(ui, deps);
    } else if (choice === "Set active preset") {
      await chooseActivePreset(ui, deps);
    } else if (choice === "Save current config as new preset") {
      const name = (await ui.input("New preset name", "e.g. fast-local"))?.trim();
      if (!name) continue;
      if (hasPreset(name) && !(await ui.confirm("Overwrite preset", `A preset named "${name}" already exists. Overwrite it?`))) {
        continue;
      }
      savePreset(name, loadFactoryConfig(deps.cwd));
      ui.notify(`Saved preset "${name}".`, "info");
    } else if (choice === "Overwrite existing preset") {
      const name = await pickPreset(ui, names, "Overwrite preset");
      if (!name) continue;
      if (!(await ui.confirm("Overwrite preset", `Replace preset "${name}" with the current configuration?`))) continue;
      savePreset(name, loadFactoryConfig(deps.cwd));
      ui.notify(`Overwrote preset "${name}".`, "info");
    } else if (choice === "Delete preset") {
      const name = await pickPreset(ui, names, "Delete preset");
      if (!name) continue;
      if (!(await ui.confirm("Delete preset", `Delete preset "${name}"? This cannot be undone.`))) continue;
      deletePreset(name);
      if (projectPresetName(deps.cwd) === name) setProjectPreset(deps.cwd, undefined);
      ui.notify(`Deleted preset "${name}".`, "info");
    } else if (choice === "View presets") {
      ui.notify(
        names.length === 0
          ? "No presets saved."
          : names.map((n) => describeConfig(presetConfig(n), n)).join("\n\n"),
        "info",
      );
    }
  }
}

async function chooseActivePreset(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  const names = listPresetNames();
  const none = "(none)";
  const choice = await ui.select("Active preset", [none, ...names]);
  if (choice === undefined) return;
  setProjectPreset(deps.cwd, choice === none ? undefined : choice);
  ui.notify(choice === none ? "Project preset cleared." : `Active preset set to "${choice}".`, "info");
}

async function pickPreset(ui: ConfigUI, names: string[], title: string): Promise<string | undefined> {
  if (names.length === 0) {
    ui.notify("No presets saved.", "info");
    return undefined;
  }
  return await ui.select(title, names);
}

async function pickModel(ui: ConfigUI, deps: FactoryConfigUIDeps, role: RoleName): Promise<string | undefined> {
  if (deps.models.length === 0) {
    ui.notify("No models are currently available through Pi's model registry.", "warning");
    return undefined;
  }
  return await ui.select(`Select model for ${cap(role)}`, deps.models);
}

/** Prompt for a non-negative integer; no-op on cancel/invalid. */
async function editInt(
  ui: ConfigUI,
  _deps: FactoryConfigUIDeps,
  title: string,
  current: number,
  apply: (value: number) => void,
): Promise<void> {
  const raw = await ui.input(title, String(current));
  if (raw === undefined) return;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    ui.notify(`"${raw}" is not a non-negative integer.`, "error");
    return;
  }
  apply(value);
}

/** Read-only summary of a resolved config (used for the defaults view/preset list). */
export function describeConfig(config: FactoryConfig, label: string): string {
  const roles = ROLE_NAMES.map((r) => `  ${cap(r)}: ${roleSummary(config, r)}`).join("\n");
  return `${label}\n${roles}\n  Limits: repair ${config.maxRepairRounds}, remediation ${config.maxArchitectRemediationRounds}`;
}

/**
 * Resolve a named preset for display, without mutating the project. Uses the
 * same merge as the run resolver so the view matches what a run would use.
 */
function presetConfig(name: string): FactoryConfig {
  const raw = getRawPreset(name);
  return raw ? mergeFactoryConfig(defaultFactoryConfig(), raw) : defaultFactoryConfig();
}
