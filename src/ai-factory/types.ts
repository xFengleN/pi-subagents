/**
 * ai-factory/types.ts — Shared types for the AI Factory orchestration layer.
 *
 * The Factory is a thin, deterministic orchestration layer that runs on top of
 * pi-subagents' cross-extension surface. It owns NO model calls: every semantic
 * decision is made by one of the four role agents (Lead, Architect, Engineer,
 * Reviewer) which are spawned as ordinary pi-subagents; every deterministic
 * decision (what phase comes next, whether a transition is legal, whether a
 * limit was reached, whether capacity is available) is made here in code.
 *
 * The persisted run state is intentionally small and versioned — packets and
 * references, never child transcripts.
 */

/** The four Factory roles. `RoleName` is the identity; a role's backend model
 * is configuration, never part of the role definition. */
export type RoleName = "lead" | "architect" | "engineer" | "reviewer";

export const ROLE_NAMES: readonly RoleName[] = ["lead", "architect", "engineer", "reviewer"];

/**
 * The deterministic Factory state machine.
 *
 * `ARCHITECT_ESCALATION` is a mid-run escalation to the Architect (structural
 * problems discovered during execution), which the spec requires in addition to
 * the mandatory initial and final checkpoints.
 */
export const FACTORY_STATES = [
  "DISCOVERY",            // Lead reconnaissance + architecture proposal
  "INITIAL_ARCHITECT",    // mandatory initial architecture checkpoint
  "EXECUTION",            // Engineer works a work package
  "REVIEW",               // Reviewer assesses implementation correctness
  "ARCHITECT_ESCALATION", // exceptional structural escalation mid-run
  "INTEGRATION",          // Lead integrates + verifies the whole system
  "FINAL_ARCHITECT",      // mandatory final architecture/acceptance checkpoint
  "REMEDIATION",          // Engineer/Reviewer fix what the final Architect rejected
  "FINAL_ARCHITECT_RECHECK", // bounded Architect recheck after remediation
  "FINAL_SYNTHESIS",      // bounded Lead synthesis of the accepted evidence (no code changes)
  "WAITING_CAPACITY",     // all targets for a required role are unavailable
  "DONE",                 // accepted
  "STOPPED",              // rejected past a budget, or stopped by the user
  "FAILED",               // unrecoverable error
] as const;

export type FactoryState = (typeof FACTORY_STATES)[number];

export const TERMINAL_STATES: readonly FactoryState[] = ["DONE", "STOPPED", "FAILED"];

/* -------------------------------------------------------------------------- */
/* Structured handoff packets. These are the ONLY information that moves      */
/* upward between roles — never transcripts.                                  */
/* -------------------------------------------------------------------------- */

/** Lead architecture-proposal packet (DISCOVERY). */
export interface LeadProposalPacket {
  goal: string;
  repositoryFindings: string;
  currentArchitecture: string;
  assumptions: string[];
  proposedSolution: string;
  constraints: string[];
  workPackages: string[];
  dependencies: string;
  risks: string[];
  acceptanceCriteria: string[];
  architecturalQuestions: string[];
}

/** Initial Architect checkpoint result. */
export interface ArchitectInitialResult {
  verdict: "APPROVE" | "CORRECT";
  approvedArchitecture: string;
  constraints: string[];
  correctedWorkPackages: string[];
  importantRisks: string[];
}

/** Engineer completion packet. */
export interface EngineerPacket {
  status: "completed" | "partially_completed" | "failed";
  workPackageId: string;
  summary: string;
  changedFiles: string[];
  importantDecisions: string[];
  testsRun: string[];
  testResults: string;
  deviations: string[];
  knownLimitations: string[];
  unresolvedQuestions: string[];
  architecturalEscalationRequired: boolean;
}

/** Reviewer implementation-correctness verdict. */
export interface ReviewerPacket {
  verdict: "PASS" | "NEEDS_FIX" | "ARCHITECTURAL_ESCALATION";
  blockingFindings: string[];
  nonBlockingFindings: string[];
  requiredRepairs: string[];
  testConcerns: string[];
  architecturalIssue: boolean;
}

/** Lead integration/acceptance packet (INTEGRATION). */
export interface LeadIntegrationPacket {
  goal: string;
  approvedArchitecture: string;
  completedWorkPackages: string[];
  importantDecisions: string[];
  deviations: string[];
  systemVerification: string;
  reviewerFindingsResolved: string[];
  reviewerFindingsAcceptedRisk: string[];
  reviewerFindingsUnresolved: string[];
  selectedFiles: string[];
  factualAssessment: string;
}

/** Final Architect acceptance-checkpoint result. */
export interface ArchitectFinalResult {
  verdict: "ACCEPT" | "NEEDS_REMEDIATION";
  blockingIssues: string[];
  requiredChanges: string[];
  doNotChange: string[];
  requiredEvidence: string[];
}

/**
 * Final Lead synthesis packet (FINAL_SYNTHESIS).
 *
 * This is NOT an implementation packet: the run has already been accepted by
 * the Architect. It is the bounded, human-facing report for the actual accepted
 * state, assembled from persisted evidence only. It never reopens remediation
 * and never triggers repo changes or further agents.
 */
export interface FinalReportPacket {
  /** Final result/verdict, e.g. "ACCEPT". */
  result: string;
  /** Concise overall synthesis paragraph. */
  summary: string;
  /** Major implementation outcomes delivered by the run. */
  delivered: string[];
  /** Architecture decisions / invariants that hold in the accepted state. */
  architecture: string[];
  /** Reviewer findings and how each was resolved/accepted. */
  reviewerFindings: string[];
  /** Tests/build/probe results observed. */
  validation: string[];
  /** Commits created by the run (read-only git evidence). */
  commits: string[];
  /** Ending HEAD, or "unknown" when it could not be determined. */
  endingHead: string;
  /** Whether anything was pushed ("no", a description, or "unknown"). */
  pushed: string;
  /** Human verification still pending. */
  humanVerification: string[];
  /** Warnings, limitations, or contradictory evidence. */
  warnings: string[];
}

/** Lead disposition after a bounded repair loop is exhausted. */
export interface LeadEscalationPacket {
  verdict: "continue" | "stop";
  guidance: string;
}

/** Every packet a role may produce, keyed by role, for the packet parsers. */
export type Packet =
  | LeadProposalPacket
  | ArchitectInitialResult
  | EngineerPacket
  | ReviewerPacket
  | LeadIntegrationPacket
  | ArchitectFinalResult
  | FinalReportPacket
  | LeadEscalationPacket;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Ordered model targets for one role. Fallback order matters; role semantics
 * never change during fallback. */
export interface RoleModelTargets {
  /** Primary target, "provider/model". */
  primary: string;
  /** Ordered fallback targets, tried when the primary is unavailable. */
  fallbacks?: string[];
}

export interface RoleConfig {
  targets: RoleModelTargets;
  /** Bounded transient retries on the same target before moving to a fallback. */
  maxTransientRetries: number;
  /** Bounded backoff between transient retries, in ms. */
  retryDelayMs: number;
  /** Turn ceiling for this role's agents. 0 = inherit/undefined. */
  maxTurns?: number;
  /**
   * Fallback policy. `architect` is conservative (wait rather than degrade),
   * `reviewer` requires a configured quality floor, `engineer` is permissive,
   * `lead` allows only equivalent-capability targets. For MVP the policy is
   * carried as configuration only — the chain itself is the mechanism.
   */
  policy: "conservative" | "permissive" | "quality_floor" | "equivalent";
}

export interface FactoryConfig {
  /** Which pi-subagents agent type each role spawns as. Falls back to
   * `general-purpose` when the configured type is unavailable. */
  agentTypes: Record<RoleName, string>;
  /** Whether role children are spawned isolated (no extensions/skills/nested
   * tools) — the Factory-mode default. */
  isolated: boolean;
  roles: Record<RoleName, RoleConfig>;
  /** Maximum Engineer/Reviewer repair rounds (default 1 for MVP). */
  maxRepairRounds: number;
  /** Maximum final-Architect remediation cycles (default 1). */
  maxArchitectRemediationRounds: number;
  /** Maximum mid-run Architect escalations per run. */
  maxArchitectEscalations: number;
  /** Maximum Lead escalations from an exhausted repair loop. */
  maxLeadEscalations: number;
  /** Conservative wait before re-attempting when no retry-after is known. */
  defaultRetryAfterMs: number;
}

/* -------------------------------------------------------------------------- */
/* Persisted run state                                                        */
/* -------------------------------------------------------------------------- */

/** A role outcome: the compact packet plus the operational reference. */
export interface RoleOutcome<T> {
  packet: T;
  agentId: string;
  /** The model target ("provider/model") that actually ran, when known. */
  target?: string;
}

export interface EngineerOutcome {
  round: number;
  outcome: RoleOutcome<EngineerPacket>;
}

export interface ReviewerOutcome {
  round: number;
  outcome: RoleOutcome<ReviewerPacket>;
}

/** Completed phase packets. IDs/references and compact packets only — no
 * transcripts, no full child conversations. */
export interface PhaseResults {
  proposal?: RoleOutcome<LeadProposalPacket>;
  initialArchitect?: RoleOutcome<ArchitectInitialResult>;
  engineers: EngineerOutcome[];
  reviewers: ReviewerOutcome[];
  integration?: RoleOutcome<LeadIntegrationPacket>;
  finalArchitect?: RoleOutcome<ArchitectFinalResult>;
  finalRecheck?: RoleOutcome<ArchitectFinalResult>;
  /**
   * Final human-facing Lead synthesis for the ACTUAL accepted state. Produced
   * once the final Architect/ recheck accepted, for both the normal and the
   * remediated path. `integration`/`finalArchitect`/`finalRecheck` remain as
   * preserved audit history and are never overwritten by it.
   */
  finalReport?: RoleOutcome<FinalReportPacket>;
  escalationArchitect?: RoleOutcome<ArchitectInitialResult>;
  leadEscalation?: RoleOutcome<LeadEscalationPacket>;
  /** One remediation cycle: the Engineer fix + Reviewer recheck. */
  remediation?: {
    engineer?: RoleOutcome<EngineerPacket>;
    reviewer?: RoleOutcome<ReviewerPacket>;
  };
}

/** The agent currently awaited by the run. */
export interface InFlightAgent {
  role: RoleName;
  /** Stable sub-phase label, e.g. "execution.engineer". */
  phase: string;
  agentId: string;
  target: string;
  spawnedAt: number;
}

/** Persisted information for a WAITING_CAPACITY park. */
export interface WaitingState {
  phase: string;
  role: RoleName;
  /** The state to return to once capacity is available. */
  resumeState: FactoryState;
  attemptedTargets: string[];
  reasons: string[];
  /** Provider-provided retry-after in ms, when known. */
  retryAfterMs?: number;
  /** Clock time at which the next attempt is allowed. */
  nextRetryAt: number;
}

export interface FactoryError {
  phase: string;
  role?: RoleName;
  message: string;
  at: number;
}

export const LEGACY_FACTORY_STATE_VERSION = 1 as const;
export const FACTORY_STATE_VERSION = 2 as const;
export type FactoryStateVersion = typeof LEGACY_FACTORY_STATE_VERSION | typeof FACTORY_STATE_VERSION;

/** Durable provenance for one role invocation. */
export type AttemptProvenance =
  | "not_started"
  | "prepared"
  | "spawn_requested"
  | "spawned"
  | "settled_validated_packet"
  | "settled_without_valid_packet";

/** Recovery-relevant risk carried with an attempt; it is never inferred from park state. */
export type AttemptRecoveryRisk =
  | "none"
  | "uncertain_outcome"
  | "workspace_may_have_changed"
  | "validated_packet"
  | "invalid_packet";

/** Persisted lifecycle record for every invocation that reaches preparation. */
export interface FactoryAttempt {
  attemptId: string;
  role: RoleName;
  phase: string;
  round: number;
  target: string;
  provenance: AttemptProvenance;
  recoveryRisk: AttemptRecoveryRisk;
  preparedAt: number;
  spawnRequestedAt?: number;
  spawnedAt?: number;
  settledAt?: number;
  agentId?: string;
  packetKind?: string;
  packetValidated?: boolean;
  /** Identity of the effective run configuration at attempt time (Task 3). */
  configRevision?: string;
}

/** A durable, approval-bindable recovery checkpoint. */
/** A validated preset replacement applied mid-run (resume V1). */
export interface PresetReplacement {
  /** The preset name selected by the user. */
  preset: string;
  /** The effective configuration for FUTURE children (original + role changes). */
  snapshot: FactoryConfig;
  appliedAt: number;
  /** The state revision at which the replacement took effect. */
  revision: number;
}

export interface FactoryCheckpoint {
  id: string;
  runId: string;
  revision: number;
  state: FactoryState;
  phase: string;
  repairRound: number;
  remediationRounds: number;
  architectEscalations: number;
  leadEscalations: number;
  attemptId?: string;
  agentId?: string;
}

export interface FactoryRunState {
  version: FactoryStateVersion;
  runId: string;
  createdAt: number;
  updatedAt: number;
  task: string;
  cwd: string;
  /** The resolved configuration the run started with, so a restart resumes
   * with identical role/model targets even if the project file or an inline
   * override has since changed. */
  config: FactoryConfig;
  state: FactoryState;
  /** Engineer/Reviewer repair loop counter (EXECUTION/REVIEW alternation). */
  repairRound: number;
  /** True once the repair loop budget is exhausted without a fix; the next
   * action is a Lead escalation (non-architectural) or Architect escalation
   * (architectural). Persisted so a restart resumes the right escalation. */
  repairExhausted: boolean;
  /** The working architecture text, updated by the initial Architect and by
   * mid-run Architect corrections. Feeds every downstream prompt. */
  effectiveArchitecture: string;
  /** Final-Architect remediation cycles used. */
  remediationRounds: number;
  /** Mid-run Architect escalations used. */
  architectEscalations: number;
  /** Lead escalations from an exhausted repair loop. */
  leadEscalations: number;
  results: PhaseResults;
  inFlight?: InFlightAgent;
  waiting?: WaitingState;
  metrics: FactoryMetrics;
  errors: FactoryError[];
  stoppedReason?: string;
  /** True when the run is parked waiting for capacity or a backoff retry. */
  parked: boolean;
  /** Monotonically increasing persisted snapshot revision (required for v2). */
  stateRevision?: number;
  /** Durable identity of this exact persisted recovery checkpoint (required for v2). */
  checkpoint?: FactoryCheckpoint;
  /** Append-only attempt provenance (required for v2). */
  attempts?: FactoryAttempt[];
  /** Optional preset replacement for future children (original config kept). */
  presetReplacement?: PresetReplacement;
}

/* -------------------------------------------------------------------------- */
/* Recovery eligibility                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic assessment of whether a persisted Factory run can be recovered.
 *
 * This is a pure function over persisted state — it never calls a model, never
 * mutates anything, and never reaches into the filesystem. It is the single
 * source of truth for all resume eligibility decisions.
 *
 * Design invariants:
 *   - Atomic JSON writes do NOT provide cross-process ownership protection.
 *     This assessment only answers "is the persisted state recoverable?";
 *     actual resume coordination is handled by the in-process `controllers` Map.
 *   - Interrupted Engineer phases may have left partial workspace changes.
 *     These are flagged but not auto-recovered — the user must approve.
 *   - Only non-terminal states are recoverable. DONE, STOPPED, and FAILED
 *     runs are terminal and cannot be resumed.
 */
export interface FactoryRecoveryEligibility {
  /** Whether the run can be recovered at all. */
  eligible: boolean;
  /** Human-readable reason for the eligibility decision. */
  reason: string;
  /** Whether explicit user approval is required before recovery.
   * True for interrupted phases (partial workspace changes) and
   * STOPPED runs (user must confirm the stop reason is correctable).
   * False for WAITING_CAPACITY and completed-phase resumes.
   */
  requiresApproval: boolean;
  /** Additional context for the user or caller. */
  notes: string[];
  /** A stable identifier for the current checkpoint, used to bind approval tokens.
   * Format: "<state>:<phase-or-parked>" e.g. "EXECUTION:execution.engineer" or
   * "WAITING_CAPACITY:parked". Changes when the run advances to a new phase,
   * making stale approvals invalid.
   */
  checkpointId: string;
  /** Task-1 planner classification; omitted by legacy callers only. */
  decision?: "automatic" | "approval_required" | "blocked";
  /** Durable checkpoint data for callers that need revision/progress binding. */
  checkpoint?: FactoryCheckpoint;
}

/** Result of an explicit `FactoryController.resume()` call. */
export type FactoryResumeResult =
  | { kind: "ok"; state: FactoryRunState["state"] }
  | { kind: "terminal"; reason: string }
  | { kind: "duplicate" }
  | { kind: "approvalRequired"; reason: string }
  | { kind: "staleApproval"; reason: string };

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-role operational metrics. Fields a provider/runner does not expose stay
 * `undefined` ("unknown") — never coerced to 0.
 */
export interface RoleMetrics {
  role: RoleName;
  agentId?: string;
  /** Total spawn attempts for this role across the run. */
  attempts: number;
  /** Transient retries on the same target. */
  retries: number;
  /** Times the run advanced to a fallback target. */
  fallbacks: number;
  /** Model targets attempted, most recent last. */
  targetsAttempted: string[];
  /** The target that ran (or was attempted last). */
  targetUsed?: string;
  status?: "running" | "completed" | "failed" | "stopped" | "skipped";
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** Actual resolved model name/id from the record's invocation, if exposed. */
  modelName?: string;
  modelId?: string;
  /**
   * Logical (billed-by-work) tokens: input + output + cacheWrite.
   * Deliberately separate from cacheRead — never conflated with it.
   */
  logicalTokens?: number;
  /** Cache-read tokens, reported separately (they are re-billed per call). */
  cacheRead?: number;
  /** Input tokens. */
  input?: number;
  /** Output tokens. */
  output?: number;
  /** Billed cost in USD, when the provider prices it. */
  cost?: number;
  /** Tool uses (a proxy for work performed; not a model-request count). */
  toolUses?: number;
  /** Compaction count (context boundedness signal). */
  compactionCount?: number;
  error?: string;
}

/**
 * One settled role-agent call. Append-only per-call telemetry, so totals and
 * context/performance aggregates are derived honestly instead of only seeing
 * the last settle per role. Optional on the run state: runs persisted before it
 * existed simply have no per-call records, and readers degrade gracefully.
 */
export interface CallMetric {
  role: RoleName;
  /** Stable sub-phase label the call ran for, e.g. "execution.engineer". */
  phase: string;
  agentId: string;
  /** Configured target attempted, when known. */
  target?: string;
  /** Actual resolved model name/id from the settle record, when exposed. */
  modelName?: string;
  modelId?: string;
  ok: boolean;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Logical (billed-by-work) tokens: input + output + cacheWrite. */
  logicalTokens?: number;
  cost?: number;
  toolUses?: number;
  compactionCount?: number;
}

export interface FactoryMetrics {
  roles: Record<RoleName, RoleMetrics>;
  /**
   * Append-only settled-call records. Absent on runs persisted before this
   * field existed; readers must treat `undefined` as "unknown", never as zero.
   */
  calls?: CallMetric[];
  /** Total spawn attempts across all roles. */
  totalAttempts: number;
  /** Total transient retries across all roles. */
  totalRetries: number;
  /** Total fallback transitions across all roles. */
  totalFallbacks: number;
  /** Number of times the run entered WAITING_CAPACITY. */
  capacityWaits: number;
  runStartedAt: number;
  runEndedAt?: number;
  runDurationMs?: number;
}

/**
 * Compact, machine-readable run summary produced at completion. Every metric
 * is either present or omitted ("unknown") — never a fabricated zero.
 */
export interface FactoryRunSummary {
  runId: string;
  state: FactoryState;
  task: string;
  stoppedReason?: string;
  roles: Record<RoleName, Omit<RoleMetrics, "role"> | undefined>;
  totals: {
    modelRequests: number;
    retries: number;
    fallbacks: number;
    capacityWaits: number;
    durationMs?: number;
  };
  notes: string[];
}
