/**
 * ai-factory/config-ui.ts — The interactive `/factory-config` menus.
 *
 * Interaction is expressed as an injectable {@link ConfigUI} so the flows are
 * pure and testable. The real adapter (commands.ts) renders menus with Pi's
 * `SettingsList` (native wrap-around + label/value columns) and a searchable
 * model picker with `SelectList` + `Input` + Pi's own `fuzzyFilter`.
 *
 * Working-copy semantics: loading a preset REPLACES the working config; edits
 * write project overrides and take effect immediately; saved presets are only
 * ever changed by an explicit "Update".
 */

import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  changedRoles,
  clearProjectRole,
  defaultFactoryConfig,
  factoryBaseState,
  limitsDiffer,
  loadFactoryConfig,
  loadPresetAsWorkingConfig,
  mergeFactoryConfig,
  projectPresetName,
  revertProjectOverrides,
  setProjectPreset,
  targetsForRole,
  validateFactoryConfig,
  writeProjectConfig,
} from "./config.js";
import { deletePreset, getRawPreset, hasPreset, listPresetNames, savePreset } from "./presets.js";
import { type FactoryConfig, ROLE_NAMES, type RoleName } from "./types.js";

/** One selectable model: canonical `value` plus text used for fuzzy search. */
export interface ModelOption {
  /** Canonical `provider/id` written to config. */
  value: string;
  /** Primary display text. */
  label: string;
  /** Secondary display text (e.g. the model's display name). */
  description?: string;
  /** Extra text searched by the picker (provider, id and display name). */
  search: string;
}

/** One row in a menu. `info` rows render but cannot be activated. */
export interface MenuRow {
  id: string;
  label: string;
  value?: string;
  description?: string;
  info?: boolean;
}

export interface ConfigUI {
  /** Wrapping, columnar menu. Returns the activated row id (or undefined). */
  menu(title: string, rows: MenuRow[]): Promise<string | undefined>;
  /** Searchable model picker. Returns a `ModelOption.value` (or undefined). */
  pickModel(title: string, models: ModelOption[], current?: string): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface FactoryConfigUIDeps {
  cwd: string;
  /** Available model ids as `provider/model` (for validation). */
  models: string[];
  /** Richer options for the searchable picker. */
  modelOptions: ModelOption[];
  /** Pi's current interactive chat model as `provider/model`, when known. */
  chatModel?: string;
  /**
   * Change Pi's interactive chat model. Optional so the UI degrades to a
   * display-only explanation when the host does not expose it. Only ever
   * called from an explicit user selection — never on preset activation.
   */
  setChatModel?: (label: string) => Promise<boolean>;
}

const cap = (role: RoleName): string => role.charAt(0).toUpperCase() + role.slice(1);

/** Deterministic, forgiving model filter — empty query returns everything. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim();
  if (q === "") return models;
  return fuzzyFilter(models, q, (m) => m.search);
}

/** Compact section prefix so grouped rows read as one aligned column. */
const section = (prefix: string, name = ""): string => `${prefix.padEnd(10)}${name}`;

function roleSummary(config: FactoryConfig, role: RoleName): string {
  const targets = targetsForRole(config, role);
  if (targets.length === 0) return "(no target)";
  const [primary, ...fallbacks] = targets;
  return fallbacks.length > 0 ? `${primary}  ←  ${fallbacks.join(", ")}` : primary;
}

/** The scope-separation explanation shown from the config menu. */
const SCOPE_EXPLANATION =
  "Factory role agents and Pi's ordinary chat model are separate.\n\n"
  + "- The base Factory preset plus any project overrides control ONLY the models "
  + "Factory's Lead, Architect, Engineer and Reviewer roles run on.\n"
  + "- Pi's main chat model is what your normal conversation uses. Loading, saving "
  + "or activating a Factory preset never changes it.\n"
  + "- Normal messages stay normal Pi messages; Factory runs only when you invoke "
  + "/factory or the Factory tool.";

/**
 * Run the config menu until the user exits. The top level is the WORKING
 * configuration — exactly what the next `/factory` run will use.
 */
export async function showFactoryConfigUI(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const state = factoryBaseState(deps.cwd);
    const issues = validateFactoryConfig(state.effective, deps.models);
    if (issues.length > 0) {
      ui.notify(`Factory config warnings:\n${issues.map((i) => `- ${i}`).join("\n")}`, "warning");
    }
    if (state.missingPreset) {
      ui.notify(
        `Preset "${state.missingPreset}" is selected but has no saved snapshot; built-in defaults apply.`,
        "warning",
      );
    }
    const baseName = state.preset ?? state.missingPreset ?? "built-in defaults";
    const changed = new Set(changedRoles(state.base, state.effective));
    const limitsChanged = limitsDiffer(state.base, state.effective);

    const rows: MenuRow[] = [
      ...ROLE_NAMES.map((role) => ({
        id: `role:${role}`,
        label: section("ROLES", cap(role)),
        value: `${state.effective.roles[role].targets.primary}${changed.has(role) ? "  *" : ""}`,
      })),
      {
        id: "config",
        label: section("CONFIG", "Configuration"),
        value: state.dirty ? "Modified" : baseName,
      },
      ...(state.dirty
        ? [
            { id: "config-based", label: section("CONFIG", "Based on"), value: baseName },
            { id: "config-note", label: section("CONFIG", "*"), value: `differs from ${baseName}`, info: true },
          ]
        : []),
      {
        id: "limits",
        label: section("EXECUTION", "Limits"),
        value: `repair ${state.effective.maxRepairRounds}, remediation ${state.effective.maxArchitectRemediationRounds}${limitsChanged ? "  *" : ""}`,
      },
      { id: "pi-chat", label: section("PI CHAT", "Chat model"), value: deps.chatModel ?? "(unknown)" },
      { id: "scopes", label: section("PI CHAT", "Model scopes"), value: "Factory roles vs Pi chat" },
      { id: "presets", label: section("ACTIONS", "Presets…"), value: `(${listPresetNames().length})` },
      { id: "defaults", label: section("ACTIONS", "View built-in defaults") },
      { id: "done", label: section("ACTIONS", "Done") },
    ];

    const choice = await ui.menu("Factory configuration — effective for next run", rows);
    if (!choice || choice === "done") return;

    if (choice.startsWith("role:")) {
      await roleMenu(ui, deps, choice.slice("role:".length) as RoleName);
    } else if (choice.startsWith("config")) {
      await presetsMenu(ui, deps);
    } else if (choice === "limits") {
      await limitsMenu(ui, deps);
    } else if (choice === "pi-chat") {
      await chatModelMenu(ui, deps);
    } else if (choice === "scopes") {
      ui.notify(SCOPE_EXPLANATION, "info");
    } else if (choice === "defaults") {
      ui.notify(describeConfig(defaultFactoryConfig(), "Built-in Factory defaults"), "info");
    } else if (choice === "presets") {
      await presetsMenu(ui, deps);
    }
  }
}

/** Role editor: the setting rows themselves are the controls. */
async function roleMenu(ui: ConfigUI, deps: FactoryConfigUIDeps, role: RoleName): Promise<void> {
  for (;;) {
    const config = loadFactoryConfig(deps.cwd);
    const rc = config.roles[role];
    const fallbacks = rc.targets.fallbacks ?? [];
    const rows: MenuRow[] = [
      { id: "primary", label: "Primary", value: rc.targets.primary },
      { id: "fallbacks", label: "Fallbacks", value: fallbacks.length > 0 ? fallbacks.join(", ") : "(none)" },
      { id: "retries", label: "Retries", value: String(rc.maxTransientRetries) },
      { id: "retry-delay", label: "Retry delay", value: `${rc.retryDelayMs} ms` },
      { id: "max-turns", label: "Max turns", value: String(rc.maxTurns ?? 0) },
      { id: "clear", label: "Clear project override" },
      { id: "back", label: "Back" },
    ];
    const choice = await ui.menu(`${cap(role)} configuration`, rows);
    if (!choice || choice === "back") return;

    if (choice === "primary") {
      const model = await ui.pickModel("Select primary model", deps.modelOptions, rc.targets.primary);
      if (model) writeProjectConfig(deps.cwd, { roles: { [role]: { targets: { primary: model } } } });
    } else if (choice === "fallbacks") {
      await fallbackMenu(ui, deps, role);
    } else if (choice === "retries") {
      await editInt(ui, "Max transient retries", rc.maxTransientRetries, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { maxTransientRetries: v } } }));
    } else if (choice === "retry-delay") {
      await editInt(ui, "Retry delay (ms)", rc.retryDelayMs, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { retryDelayMs: v } } }));
    } else if (choice === "max-turns") {
      await editInt(ui, "Max turns (0 = inherit)", rc.maxTurns ?? 0, (v) =>
        writeProjectConfig(deps.cwd, { roles: { [role]: { maxTurns: v } } }));
    } else if (choice === "clear") {
      clearProjectRole(deps.cwd, role);
      ui.notify(`Cleared the project override for ${cap(role)}.`, "info");
    }
  }
}

/** Ordered fallback list: add, remove, and reorder by execution priority. */
async function fallbackMenu(ui: ConfigUI, deps: FactoryConfigUIDeps, role: RoleName): Promise<void> {
  for (;;) {
    const fallbacks = loadFactoryConfig(deps.cwd).roles[role].targets.fallbacks ?? [];
    const rows: MenuRow[] = [
      ...fallbacks.map((model, index) => ({ id: `fb:${index}`, label: `${index + 1}.`, value: model })),
      { id: "add", label: "Add fallback…" },
      { id: "back", label: "Back" },
    ];
    const choice = await ui.menu(`${cap(role)} fallbacks (in priority order)`, rows);
    if (!choice || choice === "back") return;

    if (choice === "add") {
      const model = await ui.pickModel("Add fallback model", deps.modelOptions);
      const config = loadFactoryConfig(deps.cwd);
      const primary = config.roles[role].targets.primary;
      if (model && model !== primary && !fallbacks.includes(model)) {
        writeProjectConfig(deps.cwd, { roles: { [role]: { targets: { fallbacks: [...fallbacks, model] } } } });
      }
    } else if (choice.startsWith("fb:")) {
      const index = Number.parseInt(choice.slice("fb:".length), 10);
      await fallbackActionMenu(ui, deps, role, index);
    }
  }
}

async function fallbackActionMenu(ui: ConfigUI, deps: FactoryConfigUIDeps, role: RoleName, index: number): Promise<void> {
  const fallbacks = loadFactoryConfig(deps.cwd).roles[role].targets.fallbacks ?? [];
  const model = fallbacks[index];
  if (model === undefined) return;
  const rows: MenuRow[] = [
    { id: "up", label: "Move up", description: index === 0 ? "Already first." : undefined },
    { id: "down", label: "Move down", description: index === fallbacks.length - 1 ? "Already last." : undefined },
    { id: "remove", label: "Remove" },
    { id: "back", label: "Back" },
  ];
  const choice = await ui.menu(`Fallback ${index + 1} — ${model}`, rows);
  if (!choice || choice === "back") return;

  const write = (next: string[]): void => {
    writeProjectConfig(deps.cwd, { roles: { [role]: { targets: { fallbacks: next } } } });
  };
  if (choice === "up" && index > 0) {
    const next = [...fallbacks];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    write(next);
  } else if (choice === "down" && index < fallbacks.length - 1) {
    const next = [...fallbacks];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    write(next);
  } else if (choice === "remove") {
    write(fallbacks.filter((_, i) => i !== index));
  }
}

async function limitsMenu(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const config = loadFactoryConfig(deps.cwd);
    const rows: MenuRow[] = [
      { id: "maxRepairRounds", label: "maxRepairRounds", value: String(config.maxRepairRounds) },
      { id: "maxArchitectRemediationRounds", label: "maxArchitectRemediationRounds", value: String(config.maxArchitectRemediationRounds) },
      { id: "maxArchitectEscalations", label: "maxArchitectEscalations", value: String(config.maxArchitectEscalations) },
      { id: "maxLeadEscalations", label: "maxLeadEscalations", value: String(config.maxLeadEscalations) },
      { id: "defaultRetryAfterMs", label: "defaultRetryAfterMs", value: String(config.defaultRetryAfterMs) },
      { id: "back", label: "Back" },
    ];
    const choice = await ui.menu("Factory limits", rows);
    if (!choice || choice === "back") return;
    const current = config[choice as keyof FactoryConfig];
    if (typeof current !== "number") continue;
    await editInt(ui, choice, current, (v) => writeProjectConfig(deps.cwd, { [choice]: v }));
  }
}

async function presetsMenu(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const state = factoryBaseState(deps.cwd);
    const names = listPresetNames();
    const rows: MenuRow[] = [];
    if (state.preset && state.dirty) rows.push({ id: "revert", label: `Revert to ${state.preset}` });
    rows.push({ id: "save-new", label: "Save as new preset…" });
    if (state.preset && state.dirty) rows.push({ id: "update", label: `Update ${state.preset}…` });
    rows.push(
      { id: "load", label: "Load another preset…" },
      { id: "delete", label: "Delete preset…" },
      { id: "view", label: "View presets" },
      { id: "back", label: "Back" },
    );
    const title = state.dirty
      ? "Factory presets — modified"
      : state.preset
        ? `Factory presets — ${state.preset}`
        : "Factory presets";
    const choice = await ui.menu(title, rows);
    if (!choice || choice === "back") return;

    if (choice === "revert") {
      revertProjectOverrides(deps.cwd);
      ui.notify(`Reverted to preset "${state.preset}".`, "info");
    } else if (choice === "save-new") {
      const name = (await ui.input("New preset name", "e.g. fast-local"))?.trim();
      if (!name) continue;
      if (hasPreset(name) && !(await ui.confirm("Overwrite preset", `A preset named "${name}" already exists. Overwrite it?`))) {
        continue;
      }
      savePreset(name, state.effective);
      loadPresetAsWorkingConfig(deps.cwd, name);
      ui.notify(`Saved and loaded preset "${name}".`, "info");
    } else if (choice === "update") {
      const name = state.preset;
      if (!name) continue;
      if (!(await ui.confirm("Update preset", `Overwrite preset "${name}" with the current configuration?`))) continue;
      savePreset(name, state.effective);
      revertProjectOverrides(deps.cwd);
      ui.notify(`Updated preset "${name}".`, "info");
    } else if (choice === "load") {
      await loadPresetFlow(ui, deps);
    } else if (choice === "delete") {
      const name = await pickName(ui, names, "Delete preset");
      if (!name) continue;
      if (!(await ui.confirm("Delete preset", `Delete preset "${name}"? This cannot be undone.`))) continue;
      deletePreset(name);
      if (projectPresetName(deps.cwd) === name) setProjectPreset(deps.cwd, undefined);
      ui.notify(`Deleted preset "${name}".`, "info");
    } else if (choice === "view") {
      ui.notify(
        names.length === 0
          ? "No presets saved."
          : names.map((n) => describeConfig(presetConfig(n), n)).join("\n\n"),
        "info",
      );
    }
  }
}

/**
 * Load a preset as the working configuration. REPLACES it: all project
 * overrides are cleared, so effective == preset immediately. Confirms first
 * when unsaved working changes would be discarded.
 */
async function loadPresetFlow(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  const names = listPresetNames();
  const defaultsId = "__defaults__";
  const rows: MenuRow[] = [
    { id: defaultsId, label: "(built-in defaults)" },
    ...names.map((n) => ({ id: `preset:${n}`, label: n })),
    { id: "__cancel__", label: "Cancel" },
  ];
  const choice = await ui.menu("Load preset", rows);
  if (!choice || choice === "__cancel__") return;
  const name = choice === defaultsId ? undefined : choice.slice("preset:".length);
  const state = factoryBaseState(deps.cwd);
  if (state.dirty) {
    const ok = await ui.confirm("Load preset", `Loading "${name ?? "built-in defaults"}" discards your unsaved working changes. Continue?`);
    if (!ok) return;
  }
  loadPresetAsWorkingConfig(deps.cwd, name);
  ui.notify(name ? `Loaded preset "${name}".` : "Working configuration reset to built-in defaults.", "info");
}

/** Explicit, opt-in control of Pi's chat model — never triggered by a preset. */
async function chatModelMenu(ui: ConfigUI, deps: FactoryConfigUIDeps): Promise<void> {
  for (;;) {
    const rows: MenuRow[] = [
      { id: "current", label: "Current", value: deps.chatModel ?? "(unknown)", info: true },
      { id: "leave", label: "Leave unchanged" },
      { id: "same-as-lead", label: "Same as Factory Lead" },
      { id: "choose", label: "Choose model…" },
      { id: "back", label: "Back" },
    ];
    const choice = await ui.menu("Pi chat model (separate from Factory roles)", rows);
    if (!choice || choice === "back" || choice === "current") return;

    if (choice === "leave") {
      ui.notify("Pi chat model left unchanged.", "info");
      return;
    }
    let label: string | undefined;
    if (choice === "same-as-lead") {
      label = loadFactoryConfig(deps.cwd).roles.lead.targets.primary;
      if (!deps.models.includes(label)) {
        ui.notify(`Factory Lead model "${label}" is not currently available; Pi chat model left unchanged.`, "warning");
        return;
      }
    } else {
      label = await ui.pickModel("Choose Pi chat model", deps.modelOptions, deps.chatModel);
    }
    if (!label) return;
    if (!deps.setChatModel) {
      ui.notify("Pi's extension API does not expose changing the chat model here; left unchanged.", "warning");
      return;
    }
    const ok = await deps.setChatModel(label);
    ui.notify(ok ? `Pi chat model set to "${label}".` : `Could not set Pi chat model to "${label}" (no credentials?).`, ok ? "info" : "warning");
    return;
  }
}

async function pickName(ui: ConfigUI, names: string[], title: string): Promise<string | undefined> {
  if (names.length === 0) {
    ui.notify("No presets saved.", "info");
    return undefined;
  }
  const choice = await ui.menu(title, [...names.map((n) => ({ id: n, label: n })), { id: "__cancel__", label: "Cancel" }]);
  return choice && choice !== "__cancel__" ? choice : undefined;
}

/** Prompt for a non-negative integer; no-op on cancel/invalid. */
async function editInt(ui: ConfigUI, title: string, current: number, apply: (value: number) => void): Promise<void> {
  const raw = await ui.input(title, String(current));
  if (raw === undefined) return;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    ui.notify(`"${raw}" is not a non-negative integer.`, "error");
    return;
  }
  apply(value);
}

/** Read-only summary of a resolved config (defaults view / preset list). */
export function describeConfig(config: FactoryConfig, label: string): string {
  const roles = ROLE_NAMES.map((r) => `  ${cap(r)}: ${roleSummary(config, r)}`).join("\n");
  return `${label}\n${roles}\n  Limits: repair ${config.maxRepairRounds}, remediation ${config.maxArchitectRemediationRounds}`;
}

function presetConfig(name: string): FactoryConfig {
  const raw = getRawPreset(name);
  return raw ? mergeFactoryConfig(defaultFactoryConfig(), raw) : defaultFactoryConfig();
}
