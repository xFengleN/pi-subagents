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
