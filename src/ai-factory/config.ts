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
import type { FactoryConfig, RoleConfig, RoleName } from "./types.js";

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

/** Project Factory configuration file, next to pi-subagents' own subagents.json. */
export function factoryConfigPath(cwd: string): string {
  return join(cwd, ".pi", "factory.json");
}

/**
 * Load the effective Factory config for a project:
 * defaults <- `<cwd>/.pi/factory.json` <- inline per-call overrides.
 * The file is plain JSON (no model involved) so deployments pin real provider
 * targets without touching code.
 */
export function loadFactoryConfig(cwd: string, inline?: Record<string, unknown>): FactoryConfig {
  const base = defaultFactoryConfig();
  const fromFile = existsSync(factoryConfigPath(cwd))
    ? (JSON.parse(readFileSync(factoryConfigPath(cwd), "utf8")) as Record<string, unknown>)
    : undefined;
  return mergeFactoryConfig(base, fromFile, inline);
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
