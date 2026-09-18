/**
 * ai-factory/metrics.ts — Per-role usage/metrics accounting and the run summary.
 *
 * A first-class requirement of the Factory is quantitative context/cost
 * instrumentation. Two invariants are enforced here:
 *
 *  1. Logical token work (input + output + cacheWrite) is NEVER conflated with
 *     billed cache reads (cacheRead) — both are reported, separately.
 *  2. A metric a provider does not expose stays `undefined` ("unknown"), never
 *     a fabricated 0.
 */

import type {
  FactoryMetrics,
  FactoryRunState,
  FactoryRunSummary,
  RoleMetrics,
  RoleName,
} from "./types.js";

/** A fresh per-role metrics record. */
export function emptyRoleMetrics(role: RoleName): RoleMetrics {
  return { role, attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] };
}

/** Fresh run metrics. */
export function emptyFactoryMetrics(runStartedAt: number): FactoryMetrics {
  return {
    roles: {
      lead: emptyRoleMetrics("lead"),
      architect: emptyRoleMetrics("architect"),
      engineer: emptyRoleMetrics("engineer"),
      reviewer: emptyRoleMetrics("reviewer"),
    },
    totalAttempts: 0,
    totalRetries: 0,
    totalFallbacks: 0,
    capacityWaits: 0,
    runStartedAt,
  };
}

/**
 * Fill the operational/metrics half of a role outcome from the settle info the
 * transport gathered. Values the run cannot observe are left untouched.
 */
export function recordSettleMetrics(
  m: RoleMetrics,
  info: {
    ok: boolean;
    status: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
    tokens?: { input: number; output: number; total: number };
    toolUses?: number;
    durationMs?: number;
    modelName?: string;
    modelId?: string;
    compactionCount?: number;
    error?: string;
    completedAt?: number;
  },
): void {
  m.status = info.ok ? "completed" : "failed";
  m.completedAt = info.completedAt;
  if (info.durationMs !== undefined) m.durationMs = info.durationMs;
  if (info.modelName !== undefined) m.modelName = info.modelName;
  if (info.modelId !== undefined) m.modelId = info.modelId;
  if (info.toolUses !== undefined) m.toolUses = info.toolUses;
  if (info.compactionCount !== undefined) m.compactionCount = info.compactionCount;
  if (info.error !== undefined) m.error = info.error;
  if (info.usage !== undefined) {
    m.input = info.usage.input;
    m.output = info.usage.output;
    // Logical work excludes cacheRead; cacheRead is reported separately.
    m.logicalTokens = info.usage.input + info.usage.output + info.usage.cacheWrite;
    m.cacheRead = info.usage.cacheRead;
    if (info.usage.cost.total > 0) m.cost = info.usage.cost.total;
  } else if (info.tokens !== undefined && info.tokens.total > 0) {
    m.input = info.tokens.input;
    m.output = info.tokens.output;
    m.logicalTokens = info.tokens.total; // event display total = input+output+cacheWrite
  }
}

/** Build the compact machine-readable run summary. Unknown fields are omitted. */
export function buildRunSummary(state: FactoryRunState): FactoryRunSummary {
  const { metrics } = state;
  const roles = {} as FactoryRunSummary["roles"];
  for (const role of Object.keys(metrics.roles) as RoleName[]) {
    const m = metrics.roles[role];
    const { role: _role, ...summary } = m;
    if (m.attempts === 0 && m.status === undefined) {
      roles[role] = undefined; // never invoked — no data, not zeros
      continue;
    }
    roles[role] = summary;
  }
  const notes: string[] = [];
  if (metrics.roles.architect.attempts === 0) notes.push("Architect was never invoked.");
  if (metrics.capacityWaits > 0) notes.push(`Entered WAITING_CAPACITY ${metrics.capacityWaits} time(s).`);
  for (const role of Object.keys(metrics.roles) as RoleName[]) {
    const m = metrics.roles[role];
    if (m.status === undefined && m.attempts === 0) continue;
    if (m.cacheRead === undefined && m.logicalTokens !== undefined) {
      notes.push(`${role}: cache-read usage not exposed by provider (unknown).`);
    }
  }
  return {
    runId: state.runId,
    state: state.state,
    task: state.task,
    ...(state.stoppedReason !== undefined ? { stoppedReason: state.stoppedReason } : {}),
    roles,
    totals: {
      modelRequests: metrics.totalAttempts,
      retries: metrics.totalRetries,
      fallbacks: metrics.totalFallbacks,
      capacityWaits: metrics.capacityWaits,
      ...(metrics.runDurationMs !== undefined ? { durationMs: metrics.runDurationMs } : {}),
    },
    notes,
  };
}
