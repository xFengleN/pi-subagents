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

import {
  type CallMetric,
  type FactoryMetrics,
  type FactoryRunState,
  type FactoryRunSummary,
  type FactoryState,
  ROLE_NAMES,
  type RoleMetrics,
  type RoleName,
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
    calls: [],
    totalAttempts: 0,
    totalRetries: 0,
    totalFallbacks: 0,
    capacityWaits: 0,
    runStartedAt,
  };
}

/** The token/usage shape the transport reports for a settled role call. */
export interface SettleUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** The display-total fallback shape used when `usage` is not exposed. */
export interface SettleTokens {
  input: number;
  output: number;
  total: number;
}

/** Settle info shared by the role aggregate and the per-call record. */
export interface RecordSettleInput {
  ok: boolean;
  status: string;
  usage?: SettleUsage;
  tokens?: SettleTokens;
  toolUses?: number;
  durationMs?: number;
  modelName?: string;
  modelId?: string;
  compactionCount?: number;
  error?: string;
  completedAt?: number;
}

/**
 * Fill the operational/metrics half of a role outcome from the settle info the
 * transport gathered. Values the run cannot observe are left untouched.
 */
export function recordSettleMetrics(m: RoleMetrics, info: RecordSettleInput): void {
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

/**
 * Append one settled call to the run's append-only telemetry. Unknown fields
 * stay `undefined`; nothing is coerced to 0.
 */
export function appendCallMetric(
  metrics: FactoryMetrics,
  input: RecordSettleInput & { role: RoleName; phase: string; agentId: string; target?: string },
): void {
  const call: CallMetric = {
    role: input.role,
    phase: input.phase,
    agentId: input.agentId,
    ok: input.ok,
  };
  if (input.target !== undefined) call.target = input.target;
  if (input.modelName !== undefined) call.modelName = input.modelName;
  if (input.modelId !== undefined) call.modelId = input.modelId;
  if (input.completedAt !== undefined) call.completedAt = input.completedAt;
  if (input.durationMs !== undefined) call.durationMs = input.durationMs;
  if (input.toolUses !== undefined) call.toolUses = input.toolUses;
  if (input.compactionCount !== undefined) call.compactionCount = input.compactionCount;
  if (input.usage !== undefined) {
    call.input = input.usage.input;
    call.output = input.usage.output;
    call.cacheRead = input.usage.cacheRead;
    call.cacheWrite = input.usage.cacheWrite;
    call.logicalTokens = input.usage.input + input.usage.output + input.usage.cacheWrite;
    if (input.usage.cost.total > 0) call.cost = input.usage.cost.total;
  } else if (input.tokens !== undefined && input.tokens.total > 0) {
    call.input = input.tokens.input;
    call.output = input.tokens.output;
    call.logicalTokens = input.tokens.total;
  }
  if (metrics.calls === undefined) metrics.calls = [];
  metrics.calls.push(call);
}

/* -------------------------------------------------------------------------- */
/* Run metrics report                                                        */
/* -------------------------------------------------------------------------- */

/** One settled call's model identity, in call order. */
export interface CallModelEntry {
  phase: string;
  /** Canonical model identity (`modelId`, else target, else display name). */
  model?: string;
  ok: boolean;
}

/** Per-role aggregate for `/factory-metrics`, derived from per-call records. */
export interface RoleCallSummary {
  role: RoleName;
  /** Spawn attempts for this role (the authoritative call count). */
  calls: number;
  /** Settled calls that actually reported usage. */
  usageCalls: number;
  /** Canonical model identity: `modelId`, else target, else display name. */
  model?: string;
  target?: string;
  /** Ordered per-call model identities (calls-based runs only). */
  callModels: CallModelEntry[];
  /** Ordered configured targets attempted (persisted role aggregate). */
  targetsAttempted: string[];
  /** Transient retries on the same target. */
  retries: number;
  /** Advances to a fallback target. */
  fallbacks: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  logicalTokens?: number;
  cost?: number;
  durationMs?: number;
  toolUses?: number;
}

/** Canonical identity for a call, preferring the resolved id over the display name. */
function callModel(call: CallMetric): string | undefined {
  return call.modelId ?? call.target ?? call.modelName;
}

/**
 * Whether a role's calls should be listed individually. A single aggregate row
 * is enough when every call used the same model with no retries or fallbacks.
 */
function needsModelSequence(role: RoleCallSummary): boolean {
  const distinct = new Set(role.callModels.map((c) => c.model).filter((m): m is string => m !== undefined));
  return distinct.size > 1 || role.retries > 0 || role.fallbacks > 0 || role.targetsAttempted.length > 1;
}

export interface RunMetricsSummary {
  runId: string;
  state: FactoryState;
  roles: RoleCallSummary[];
  totals: {
    calls: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    logicalTokens?: number;
    cost?: number;
    durationMs?: number;
  };
  context: { largest?: number; average?: number; median?: number; samples: number };
  performance: { medianDurationMs?: number; slowest?: { role: RoleName; phase: string; durationMs: number } };
  orchestration: {
    repairRounds: number;
    remediationRounds: number;
    retries: number;
    fallbacks: number;
    capacityWaits: number;
  };
  completion: { finalResult?: string; validation?: string; commits?: number };
  /** True when per-call telemetry is absent and figures fall back to roles. */
  legacyTelemetry: boolean;
  notes: string[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function addRecord(into: Record<string, number | undefined>, key: string, delta: number | undefined): void {
  if (delta === undefined) return;
  into[key] = (into[key] ?? 0) + delta;
}

/**
 * Derive a compact metrics report from persisted run state.
 *
 * Prefers the append-only per-call records; when they are absent (a run written
 * before per-call telemetry existed) it degrades to the per-role aggregate and
 * flags `legacyTelemetry`, so a reader knows the token/cost figures are only the
 * last reported call per role — never totals it cannot actually support.
 */
export function buildRunMetrics(state: FactoryRunState): RunMetricsSummary {
  const metrics = state.metrics;
  const calls = metrics.calls ?? [];
  const legacyTelemetry = metrics.calls === undefined;
  const notes: string[] = [];

  const byRole = new Map<RoleName, CallMetric[]>();
  for (const role of ROLE_NAMES) byRole.set(role, []);
  for (const call of calls) byRole.get(call.role)?.push(call);

  let anyUsage = false;
  const roles: RoleCallSummary[] = ROLE_NAMES.map((role) => {
    const roleCalls = byRole.get(role) ?? [];
    const roleMetrics = metrics.roles[role];
    const summary: RoleCallSummary = {
      role,
      calls: roleMetrics.attempts,
      usageCalls: roleCalls.filter((c) => c.input !== undefined || c.output !== undefined).length,
      callModels: roleCalls.map((c) => {
        const model = callModel(c);
        return { phase: c.phase, ok: c.ok, ...(model !== undefined ? { model } : {}) };
      }),
      targetsAttempted: [...roleMetrics.targetsAttempted],
      retries: roleMetrics.retries,
      fallbacks: roleMetrics.fallbacks,
    };
    // Canonical model identity: prefer the resolved id over the display name.
    // Calls-based runs use the last settled call; a legacy run falls back to
    // the persisted role aggregate.
    let model: string | undefined;
    for (const c of roleCalls) {
      const canonical = callModel(c);
      if (canonical !== undefined) model = canonical;
    }
    if (model === undefined) model = roleMetrics.modelId ?? roleMetrics.targetUsed ?? roleMetrics.modelName;
    if (model !== undefined) summary.model = model;
    if (roleMetrics.targetUsed !== undefined) summary.target = roleMetrics.targetUsed;

    if (legacyTelemetry) {
      // No per-call records: the role aggregate holds the last reported call.
      const has = roleMetrics.input !== undefined || roleMetrics.output !== undefined
        || roleMetrics.cacheRead !== undefined || roleMetrics.cost !== undefined;
      if (has) {
        summary.input = roleMetrics.input;
        summary.output = roleMetrics.output;
        summary.cacheRead = roleMetrics.cacheRead;
        summary.logicalTokens = roleMetrics.logicalTokens;
        summary.cost = roleMetrics.cost;
        summary.durationMs = roleMetrics.durationMs;
        summary.toolUses = roleMetrics.toolUses;
        summary.usageCalls = 1;
      }
    } else {
      const tokenSums: Record<string, number | undefined> = {};
      for (const c of roleCalls) {
        addRecord(tokenSums, "input", c.input);
        addRecord(tokenSums, "output", c.output);
        addRecord(tokenSums, "cacheRead", c.cacheRead);
        addRecord(tokenSums, "cacheWrite", c.cacheWrite);
        addRecord(tokenSums, "logicalTokens", c.logicalTokens);
        addRecord(tokenSums, "cost", c.cost);
        addRecord(tokenSums, "durationMs", c.durationMs);
        addRecord(tokenSums, "toolUses", c.toolUses);
      }
      summary.input = tokenSums.input;
      summary.output = tokenSums.output;
      summary.cacheRead = tokenSums.cacheRead;
      summary.cacheWrite = tokenSums.cacheWrite;
      summary.logicalTokens = tokenSums.logicalTokens;
      summary.cost = tokenSums.cost;
      summary.durationMs = roleMetrics.durationMs ?? tokenSums.durationMs;
      summary.toolUses = roleMetrics.toolUses ?? tokenSums.toolUses;
      if (summary.usageCalls > 0) anyUsage = true;
    }
    return summary;
  });

  // Sum the per-role attempts rather than trusting the parallel totalAttempts
  // counter, so the per-role table and the total can never disagree.
  const totals: RunMetricsSummary["totals"] = { calls: roles.reduce((sum, r) => sum + r.calls, 0) };
  const totalSums: Record<string, number | undefined> = {};
  for (const role of roles) {
    addRecord(totalSums, "input", role.input);
    addRecord(totalSums, "output", role.output);
    addRecord(totalSums, "cacheRead", role.cacheRead);
    addRecord(totalSums, "cacheWrite", role.cacheWrite);
    addRecord(totalSums, "logicalTokens", role.logicalTokens);
    addRecord(totalSums, "cost", role.cost);
    addRecord(totalSums, "durationMs", role.durationMs);
  }
  totals.input = totalSums.input;
  totals.output = totalSums.output;
  totals.cacheRead = totalSums.cacheRead;
  totals.cacheWrite = totalSums.cacheWrite;
  totals.logicalTokens = totalSums.logicalTokens;
  totals.cost = totalSums.cost;
  totals.durationMs = metrics.runDurationMs ?? totalSums.durationMs;
  if (!legacyTelemetry && !anyUsage) {
    notes.push("No call reported usage; token and cost figures are unavailable (n/a).");
  }

  // Request context ≈ full prompt: uncached input + cache read + cache write.
  const contexts: number[] = [];
  for (const c of calls) {
    const value = (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
    if (value > 0) contexts.push(value);
  }
  const durations = calls.map((c) => c.durationMs).filter((d): d is number => d !== undefined);
  let slowest: { role: RoleName; phase: string; durationMs: number } | undefined;
  for (const c of calls) {
    if (c.durationMs === undefined) continue;
    if (!slowest || c.durationMs > slowest.durationMs) slowest = { role: c.role, phase: c.phase, durationMs: c.durationMs };
  }

  const report: RunMetricsSummary = {
    runId: state.runId,
    state: state.state,
    roles,
    totals,
    context: {
      largest: contexts.length > 0 ? Math.max(...contexts) : undefined,
      average: contexts.length > 0 ? Math.round(contexts.reduce((a, b) => a + b, 0) / contexts.length) : undefined,
      median: median(contexts),
      samples: contexts.length,
    },
    performance: {
      medianDurationMs: median(durations),
      ...(slowest ? { slowest } : {}),
    },
    orchestration: {
      repairRounds: state.repairRound,
      remediationRounds: state.remediationRounds,
      retries: metrics.totalRetries,
      fallbacks: metrics.totalFallbacks,
      capacityWaits: metrics.capacityWaits,
    },
    completion: {},
    legacyTelemetry,
    notes,
  };
  const finalReport = state.results.finalReport?.packet;
  const architectOutcome = state.results.finalRecheck?.packet ?? state.results.finalArchitect?.packet;
  const currentFinalReport = state.state === "DONE" && architectOutcome?.verdict !== "NEEDS_REMEDIATION" ? finalReport : undefined;
  report.completion.finalResult = architectOutcome?.verdict ?? currentFinalReport?.result;
  if (currentFinalReport) {
    report.completion.validation = currentFinalReport.validation[0];
    report.completion.commits = currentFinalReport.commits.length;
  }
  return report;
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));
const fmtInt = (n: number): string => n.toLocaleString("en-US");
const fmtCost = (n: number): string => `$${n.toFixed(6)}`;

/** Compact human duration: `750ms`, `12.3s`, `4m 30s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Render the run metrics report. Only fields the run can support honestly are
 * shown; a metric the provider never exposed prints `n/a` or is omitted.
 */
export function formatRunMetrics(state: FactoryRunState): string {
  const m = buildRunMetrics(state);
  const lines: string[] = ["Factory metrics", `Run: ${m.runId}`, `State: ${m.state}`];
  if (m.legacyTelemetry) {
    // Make the degraded mode impossible to miss: these figures are the last
    // reported call per role, not totals.
    lines.push("");
    lines.push("Telemetry mode: legacy role aggregates");
    lines.push("Model shown: last reported model per role");
    lines.push("Token/cost figures may not equal true run totals");
  }
  lines.push("");

  const invoked = m.roles.filter((r) => r.calls > 0 || r.usageCalls > 0);
  lines.push("Calls");
  for (const r of invoked) lines.push(`  ${pad(r.role, 12)} ${r.calls}   ${r.model ?? "n/a"}`);
  lines.push(`  ${pad("Total", 12)} ${m.totals.calls}`);
  lines.push("");

  // Per-call model sequence, shown only where the aggregate row would hide a
  // model change or a recovery (retries, fallbacks, or more than one target).
  const sequenced = invoked.filter((r) => needsModelSequence(r));
  if (sequenced.length > 0) {
    lines.push("Model sequence");
    for (const r of sequenced) {
      const tags: string[] = [];
      if (r.retries > 0) tags.push(`retries: ${r.retries}`);
      if (r.fallbacks > 0) tags.push(`fallbacks: ${r.fallbacks}`);
      lines.push(`  ${r.role}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`);
      if (r.targetsAttempted.length > 1) lines.push(`    targets: ${r.targetsAttempted.join(" -> ")}`);
      for (const c of r.callModels) {
        lines.push(`    ${pad(c.phase, 24)} ${c.model ?? "n/a"}${c.ok ? "" : " [failed]"}`);
      }
    }
    lines.push("");
  }

  lines.push("Tokens");
  const tokenLines: string[] = [];
  if (m.totals.input !== undefined) tokenLines.push(`  ${pad("Input", 12)} ${fmtInt(m.totals.input)}`);
  if (m.totals.cacheRead !== undefined) tokenLines.push(`  ${pad("Cached", 12)} ${fmtInt(m.totals.cacheRead)}`);
  if (m.totals.output !== undefined) tokenLines.push(`  ${pad("Output", 12)} ${fmtInt(m.totals.output)}`);
  if (m.totals.logicalTokens !== undefined) tokenLines.push(`  ${pad("Logical", 12)} ${fmtInt(m.totals.logicalTokens)}`);
  lines.push(...(tokenLines.length > 0 ? tokenLines : ["  n/a"]));
  lines.push("");

  lines.push("Cost");
  const costLines: string[] = [];
  for (const r of invoked) {
    if (r.cost !== undefined) costLines.push(`  ${pad(r.role, 12)} ${fmtCost(r.cost)}`);
  }
  if (m.totals.cost !== undefined) costLines.push(`  ${pad("Total", 12)} ${fmtCost(m.totals.cost)}`);
  lines.push(...(costLines.length > 0 ? costLines : ["  n/a"]));
  lines.push("");

  lines.push("Context");
  if (m.context.samples === 0) {
    lines.push("  n/a");
  } else {
    if (m.context.largest !== undefined) lines.push(`  ${pad("Largest request", 18)} ${fmtInt(m.context.largest)}`);
    if (m.context.average !== undefined) lines.push(`  ${pad("Average request", 18)} ${fmtInt(m.context.average)}`);
    if (m.context.median !== undefined) lines.push(`  ${pad("Median request", 18)} ${fmtInt(m.context.median)}`);
    lines.push(`  ${pad("Samples", 18)} ${m.context.samples}`);
  }
  lines.push("");

  lines.push("Performance");
  lines.push(`  ${pad("Median call", 18)} ${m.performance.medianDurationMs !== undefined ? formatDuration(m.performance.medianDurationMs) : "n/a"}`);
  if (m.performance.slowest) {
    lines.push(`  ${pad("Slowest call", 18)} ${m.performance.slowest.role} (${m.performance.slowest.phase}) ${formatDuration(m.performance.slowest.durationMs)}`);
  }
  lines.push(`  ${pad("TTFT", 18)} n/a`);
  lines.push(`  ${pad("Generation", 18)} n/a`);
  lines.push("");

  lines.push("Orchestration");
  lines.push(`  ${pad("Repair rounds", 18)} ${m.orchestration.repairRounds}`);
  lines.push(`  ${pad("Remediation rounds", 18)} ${m.orchestration.remediationRounds}`);
  lines.push(`  ${pad("Retries", 18)} ${m.orchestration.retries}`);
  lines.push(`  ${pad("Fallbacks", 18)} ${m.orchestration.fallbacks}`);
  lines.push(`  ${pad("Capacity waits", 18)} ${m.orchestration.capacityWaits}`);

  const completion = m.completion;
  if (completion.finalResult !== undefined || completion.validation !== undefined || completion.commits !== undefined) {
    lines.push("");
    lines.push("Completion");
    if (completion.finalResult !== undefined) lines.push(`  ${pad("Final result", 18)} ${completion.finalResult}`);
    if (completion.validation !== undefined) lines.push(`  ${pad("Validation", 18)} ${completion.validation}`);
    if (completion.commits !== undefined) lines.push(`  ${pad("Commits", 18)} ${completion.commits}`);
  }

  if (m.notes.length > 0) {
    lines.push("");
    lines.push("Notes");
    for (const note of m.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
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
