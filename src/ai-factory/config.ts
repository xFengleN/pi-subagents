/**
 * ai-factory/config.ts — Factory configuration and defaults.
 *
 * Role configuration is separate from role code: swapping a role's backend
 * model never changes its prompt or the controller. The default targets are
 * placeholders — real deployments set `factory` settings (see
 * docs/ai-factory.md) or pass an explicit config; nothing provider-specific is
 * hardcoded here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRawPreset } from "./presets.js";
import { writeJsonAtomic } from "./store.js";
import { type FactoryConfig, ROLE_NAMES, type RoleConfig, type RoleName } from "./types.js";

/** Default agent type per role. Falls back to `general-purpose` at spawn time
 * when a type is not installed. */
const DEFAULT_AGENT_TYPES: Record<RoleName, string> = {
  lead: "factory-lead",
  architect: "factory-architect",
  engineer: "factory-engineer",
  reviewer: "factory-reviewer",
};

const roleConfig = (
  primary: string,
  policy: RoleConfig["policy"],
  maxTurns?: number,
): RoleConfig => ({
  targets: { primary, fallbacks: [] },
  maxTransientRetries: 2,
  retryDelayMs: 1_000,
  maxTurns,
  policy,
});

/**
 * The default Factory configuration.
 *
 * `primary` values here are documentation-grade examples ("provider/model"
 * identifiers), not a real deployment. A production run must supply actual
 * targets via the `factory` settings block or `Factory({ config })`.
 */
export function defaultFactoryConfig(): FactoryConfig {
  return {
    agentTypes: { ...DEFAULT_AGENT_TYPES },
    isolated: true,
    roles: {
      // Lead: equivalent-capability fallbacks only.
      lead: roleConfig("provider/lead-model", "equivalent", 80),
      // Architect: conservative — never silently degrade below configured
      // architect-quality targets.
      architect: roleConfig("provider/architect-model", "conservative", 60),
      // Engineer: the most permissive fallback chain.
      engineer: roleConfig("provider/engineer-model", "permissive", 150),
      // Reviewer: requires a configured minimum-quality target.
      reviewer: roleConfig("provider/reviewer-model", "quality_floor", 60),
    },
    maxRepairRounds: 1,
    maxArchitectRemediationRounds: 1,
    maxArchitectEscalations: 1,
    maxLeadEscalations: 1,
    defaultRetryAfterMs: 30 * 60_000,
  };
}

/** All model targets for a role in fallback order (primary first). Returns an
 * empty array only if the role config is missing a primary. */
export function targetsForRole(config: FactoryConfig, role: RoleName): string[] {
  const targets = config.roles[role]?.targets;
  if (!targets?.primary) return [];
  return [targets.primary, ...(targets.fallbacks ?? [])];
}

/* -------------------------------------------------------------------------- */
/* Configuration file loading                                                 */
/* -------------------------------------------------------------------------- */

/** Key in `.pi/factory.json` naming the user-level preset to apply. */
export const PROJECT_PRESET_KEY = "preset";

/** Project Factory configuration file, next to pi-subagents' own subagents.json. */
export function factoryConfigPath(cwd: string): string {
  return join(cwd, ".pi", "factory.json");
}

/** The project config as raw JSON, or undefined when absent/corrupt. */
export function readProjectConfig(cwd: string): Record<string, unknown> | undefined {
  const path = factoryConfigPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/** The preset named by the project config, if any. */
export function projectPresetName(cwd: string): string | undefined {
  const name = readProjectConfig(cwd)?.[PROJECT_PRESET_KEY];
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

function withoutPresetKey(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const { [PROJECT_PRESET_KEY]: _preset, ...rest } = config;
  return rest;
}

/**
 * Load the effective Factory config for a project, in resolution order:
 * built-in defaults <- named preset <- `<cwd>/.pi/factory.json` overrides
 * <- inline per-call overrides.
 *
 * A project with no `preset` key resolves exactly as before (defaults <- file),
 * so existing `.pi/factory.json` files are unaffected.
 */
export function loadFactoryConfig(cwd: string, inline?: Record<string, unknown>): FactoryConfig {
  const base = defaultFactoryConfig();
  const presetName = projectPresetName(cwd);
  const preset = presetName !== undefined ? getRawPreset(presetName) : undefined;
  return mergeFactoryConfig(base, preset, withoutPresetKey(readProjectConfig(cwd)), inline);
}

/** Overwrite the project config file (whole object), atomically. */
export function writeProjectConfigFile(cwd: string, config: Record<string, unknown>): void {
  writeJsonAtomic(factoryConfigPath(cwd), config);
}

/** Deep-merge a partial patch into the project config, preserving other keys. */
export function writeProjectConfig(cwd: string, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = deepMergeJson(readProjectConfig(cwd) ?? {}, patch);
  writeProjectConfigFile(cwd, merged);
  return merged;
}

/** Select the active preset for a project (`undefined` clears the selection). */
export function setProjectPreset(cwd: string, name: string | undefined): void {
  writeProjectConfig(cwd, { [PROJECT_PRESET_KEY]: name });
}

/** Remove a role's project override so the preset/default applies again. */
export function clearProjectRole(cwd: string, role: RoleName): void {
  const current = readProjectConfig(cwd) ?? {};
  const roles = asRecord(current.roles);
  if (roles) {
    delete roles[role];
    if (Object.keys(roles).length === 0) delete current.roles;
  }
  writeProjectConfigFile(cwd, current);
}

function deepMergeJson(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = asRecord(out[key]);
    const incoming = asRecord(value);
    if (existing && incoming) out[key] = deepMergeJson(existing, incoming);
    else if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Deterministic config validation against the currently available model ids
 * (`provider/model`). Returns human-readable issues; an empty array is valid.
 * Used by the config UI and as a pre-launch warning — never as an LLM check.
 */
export function validateFactoryConfig(config: FactoryConfig, availableModels: readonly string[]): string[] {
  const available = new Set(availableModels);
  const issues: string[] = [];
  for (const role of ROLE_NAMES) {
    const targets = targetsForRole(config, role);
    if (targets.length === 0) issues.push(`${role}: no model target configured`);
    for (const target of targets) {
      if (!available.has(target)) issues.push(`${role}: model "${target}" is not currently available`);
    }
  }
  const limits: Array<[string, number]> = [
    ["maxRepairRounds", config.maxRepairRounds],
    ["maxArchitectRemediationRounds", config.maxArchitectRemediationRounds],
    ["maxArchitectEscalations", config.maxArchitectEscalations],
    ["maxLeadEscalations", config.maxLeadEscalations],
  ];
  for (const [name, value] of limits) {
    if (!Number.isFinite(value) || value < 0) issues.push(`${name} must be >= 0`);
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Base preset vs effective working configuration, and dirty detection        */
/* -------------------------------------------------------------------------- */

/**
 * Two distinct concepts, kept explicit:
 *   - the BASE preset is the saved snapshot the project selected; and
 *   - the EFFECTIVE config is what the next `/factory` run will actually use
 *     (base <- project overrides).
 * A project is "dirty" when the two differ, computed by deep comparison — never
 * a mutable boolean.
 */
export interface FactoryBaseState {
  /** The selected base preset, when its saved snapshot exists. */
  preset?: string;
  /** A selected preset name with no saved snapshot (stale project config). */
  missingPreset?: string;
  /** Resolved base configuration (`defaults <- preset`). */
  base: FactoryConfig;
  /** Effective configuration the next run uses (`base <- project overrides`). */
  effective: FactoryConfig;
  /** True when project overrides make the effective config differ from the base. */
  dirty: boolean;
}

/** Resolve a saved preset over the built-in defaults (no project overrides). */
export function resolvePresetConfig(name: string): FactoryConfig {
  return mergeFactoryConfig(defaultFactoryConfig(), getRawPreset(name));
}

/** The base/effective/dirty state for a project. */
export function factoryBaseState(cwd: string): FactoryBaseState {
  const selected = projectPresetName(cwd);
  const raw = selected !== undefined ? getRawPreset(selected) : undefined;
  const base = mergeFactoryConfig(defaultFactoryConfig(), raw);
  const effective = loadFactoryConfig(cwd);
  return {
    ...(selected !== undefined && raw !== undefined ? { preset: selected } : {}),
    ...(selected !== undefined && raw === undefined ? { missingPreset: selected } : {}),
    base,
    effective,
    dirty: !factoryConfigEquals(base, effective),
  };
}

/** Deep structural equality of two resolved Factory configs. */
export function factoryConfigEquals(a: FactoryConfig, b: FactoryConfig): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Structural equality of two role configs. */

export function roleConfigEquals(a: RoleConfig, b: RoleConfig): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * The effective configuration after a preset replacement (resume V1). Only
 * future-child settings change — role targets, fallbacks, retry settings, and
 * role turn limits. Workflow budgets (repair/remediation/escalation limits),
 * isolation policy, agent types, and the original role policy are preserved,
 * so no live child's model is ever changed mid-invocation.
 */
export function replacementConfig(original: FactoryConfig, preset: FactoryConfig): FactoryConfig {
  const roles = { ...original.roles };
  for (const role of ROLE_NAMES) {
    const from = preset.roles[role];
    if (from === undefined) continue;
    roles[role] = {
      ...roles[role],
      targets: from.targets,
      maxTransientRetries: from.maxTransientRetries,
      retryDelayMs: from.retryDelayMs,
      ...(from.maxTurns !== undefined ? { maxTurns: from.maxTurns } : {}),
    };
  }
  return { ...original, roles };
}

/**
 * A stable revision identity for a resolved Factory config snapshot (sorted
 * keys, deterministic hash). Records which configuration an attempt ran under;
 * constant per run because the run config is an immutable snapshot.
 */
export function configRevision(config: FactoryConfig): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(sortKeysDeep(config));
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cfg-${(hash >>> 0).toString(36)}`;
}

/** Roles whose effective config differs from the base preset. */
export function changedRoles(base: FactoryConfig, effective: FactoryConfig): RoleName[] {
  return ROLE_NAMES.filter((role) => !roleConfigEquals(base.roles[role], effective.roles[role]));
}

/** Whether any execution limit differs between the base preset and the effective config. */
export function limitsDiffer(a: FactoryConfig, b: FactoryConfig): boolean {
  return a.maxRepairRounds !== b.maxRepairRounds
    || a.maxArchitectRemediationRounds !== b.maxArchitectRemediationRounds
    || a.maxArchitectEscalations !== b.maxArchitectEscalations
    || a.maxLeadEscalations !== b.maxLeadEscalations
    || a.defaultRetryAfterMs !== b.defaultRetryAfterMs;
}

/**
 * Replace the project's working configuration with a saved preset (or the
 * built-in defaults when `name` is undefined). Every project override is
 * dropped, so the effective config equals the resolved preset immediately.
 *
 * Loading a preset is a REPLACE, not a layer: stale role/limit overrides from
 * the previous working configuration must not survive.
 */
export function loadPresetAsWorkingConfig(cwd: string, name: string | undefined): void {
  const next: Record<string, unknown> = {};
  if (name !== undefined && name !== "") next[PROJECT_PRESET_KEY] = name;
  writeProjectConfigFile(cwd, next);
}

/**
 * Drop all project overrides, keeping the base preset selection. After this the
 * effective config equals the saved base preset again.
 */
export function revertProjectOverrides(cwd: string): void {
  loadPresetAsWorkingConfig(cwd, projectPresetName(cwd));
}

/** Deterministic serialization with keys sorted, so equality is order-independent. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeysDeep(src[key]);
    return out;
  }
  return value;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function mergeRole(base: RoleConfig, raw: unknown): RoleConfig {
  const src = asRecord(raw);
  if (!src) return base;
  const targets = asRecord(src.targets);
  const result: RoleConfig = {
    targets: {
      primary: typeof targets?.primary === "string" ? targets.primary : base.targets.primary,
      fallbacks: Array.isArray(targets?.fallbacks)
        ? (targets.fallbacks as unknown[]).filter((x): x is string => typeof x === "string")
        : base.targets.fallbacks,
    },
    maxTransientRetries: typeof src.maxTransientRetries === "number" ? src.maxTransientRetries : base.maxTransientRetries,
    retryDelayMs: typeof src.retryDelayMs === "number" ? src.retryDelayMs : base.retryDelayMs,
    maxTurns: typeof src.maxTurns === "number" ? src.maxTurns : base.maxTurns,
    policy: (src.policy === "conservative" || src.policy === "permissive"
      || src.policy === "quality_floor" || src.policy === "equivalent") ? src.policy : base.policy,
  };
  return result;
}

function num(v: unknown, d: number): number {
  return typeof v === "number" ? v : d;
}

/** Merge one or more partial config sources over the defaults. */
export function mergeFactoryConfig(
  base: FactoryConfig,
  ...partials: Array<Record<string, unknown> | undefined>
): FactoryConfig {
  const result: FactoryConfig = {
    agentTypes: { ...base.agentTypes },
    isolated: base.isolated,
    roles: { ...base.roles },
    maxRepairRounds: base.maxRepairRounds,
    maxArchitectRemediationRounds: base.maxArchitectRemediationRounds,
    maxArchitectEscalations: base.maxArchitectEscalations,
    maxLeadEscalations: base.maxLeadEscalations,
    defaultRetryAfterMs: base.defaultRetryAfterMs,
  };
  for (const partial of partials) {
    const src = asRecord(partial);
    if (!src) continue;
    const agentTypes = asRecord(src.agentTypes);
    if (agentTypes) {
      for (const role of Object.keys(agentTypes) as RoleName[]) {
        if (typeof agentTypes[role] === "string") result.agentTypes[role] = agentTypes[role] as string;
      }
    }
    if (typeof src.isolated === "boolean") result.isolated = src.isolated;
    const roles = asRecord(src.roles);
    if (roles) {
      for (const role of Object.keys(roles) as RoleName[]) {
        result.roles[role] = mergeRole(result.roles[role], roles[role]);
      }
    }
    result.maxRepairRounds = num(src.maxRepairRounds, result.maxRepairRounds);
    result.maxArchitectRemediationRounds = num(src.maxArchitectRemediationRounds, result.maxArchitectRemediationRounds);
    result.maxArchitectEscalations = num(src.maxArchitectEscalations, result.maxArchitectEscalations);
    result.maxLeadEscalations = num(src.maxLeadEscalations, result.maxLeadEscalations);
    result.defaultRetryAfterMs = num(src.defaultRetryAfterMs, result.defaultRetryAfterMs);
  }
  return result;
}
