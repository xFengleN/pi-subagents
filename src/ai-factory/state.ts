/**
 * ai-factory/state.ts — The deterministic Factory state machine.
 *
 * Transitions are the one place the run decides "what comes next", and they are
 * pure code: applying a transition never asks a model anything. Illegal
 * transitions are rejected programmatically so a bug cannot silently skip a
 * mandatory checkpoint.
 */

import { hasPersistedAttemptPacket, latestAttemptForPhase, unresolvedSpawnAttempt } from "./recovery-model.js";
import { type FactoryRecoveryEligibility, type FactoryRunState, type FactoryState, TERMINAL_STATES } from "./types.js";

export { createFactoryCheckpoint, planFactoryRecovery, unresolvedSpawnAttempt } from "./recovery-model.js";

/**
 * The legal transition table. Every entry is a decision the code is allowed to
 * make with no model input.
 *
 *   DISCOVERY            --(Lead proposal)--> INITIAL_ARCHITECT
 *   INITIAL_ARCHITECT    --(APPROVE/CORRECT)--> EXECUTION
 *   EXECUTION            --(Engineer packet)--> REVIEW
 *   REVIEW               --(PASS)--> INTEGRATION
 *   REVIEW               --(NEEDS_FIX, rounds left)--> EXECUTION        [local loop]
 *   REVIEW / EXECUTION   --(architectural)--> ARCHITECT_ESCALATION
 *   ARCHITECT_ESCALATION --(Architect corrected)--> EXECUTION
 *   INTEGRATION          --(Lead acceptance packet)--> FINAL_ARCHITECT
 *   FINAL_ARCHITECT      --(ACCEPT)--> FINAL_SYNTHESIS
 *   FINAL_ARCHITECT      --(NEEDS_REMEDIATION, rounds left)--> REMEDIATION
 *   REMEDIATION          --(Engineer+Reviewer done)--> FINAL_ARCHITECT_RECHECK
 *   FINAL_ARCHITECT_RECHECK --(ACCEPT)--> FINAL_SYNTHESIS
 *   FINAL_ARCHITECT_RECHECK --(reject, budget exhausted)--> STOPPED
 *   FINAL_SYNTHESIS      --(Lead report persisted)--> DONE
 *   any active state     --(all targets unavailable)--> WAITING_CAPACITY
 *   WAITING_CAPACITY     --(capacity available)--> resumeState
 *   any active state     --(unrecoverable)--> FAILED / STOPPED
 *
 * FINAL_SYNTHESIS is the mandatory finalization gate: EVERY accepted run,
 * including one that went through remediation, must produce exactly one final
 * Lead synthesis before DONE. It cannot go back to implementation.
 *
 * WAITING_CAPACITY may transition back to any resume state (it records the
 * state to resume into), so it is intentionally open.
 */
const TRANSITIONS: Record<FactoryState, readonly FactoryState[]> = {
  DISCOVERY: ["INITIAL_ARCHITECT", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  INITIAL_ARCHITECT: ["EXECUTION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  EXECUTION: ["REVIEW", "INTEGRATION", "ARCHITECT_ESCALATION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  REVIEW: ["INTEGRATION", "EXECUTION", "ARCHITECT_ESCALATION", "FINAL_ARCHITECT_RECHECK", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  ARCHITECT_ESCALATION: ["EXECUTION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  INTEGRATION: ["FINAL_ARCHITECT", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  FINAL_ARCHITECT: ["FINAL_SYNTHESIS", "REMEDIATION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  REMEDIATION: ["REVIEW", "FINAL_ARCHITECT_RECHECK", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  FINAL_ARCHITECT_RECHECK: ["FINAL_SYNTHESIS", "STOPPED", "WAITING_CAPACITY", "FAILED"],
  FINAL_SYNTHESIS: ["DONE", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  WAITING_CAPACITY: [
    // Resume targets; the run records which one it came from and may return to
    // any active state. Terminal states are also reachable if a wake discovers
    // the situation has become unrecoverable.
    "DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION", "REVIEW", "ARCHITECT_ESCALATION",
    "INTEGRATION", "FINAL_ARCHITECT", "REMEDIATION", "FINAL_ARCHITECT_RECHECK",
    "FINAL_SYNTHESIS", "FAILED", "STOPPED",
  ],
  DONE: [],
  STOPPED: [],
  FAILED: [],
};

/** True when a transition from `from` to `to` is legal. */
export function isLegalTransition(from: FactoryState, to: FactoryState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Apply a state change, rejecting illegal transitions.
 *
 * Throws rather than silently ignoring so an orchestration bug surfaces in
 * tests and logs instead of producing a run that skipped a mandatory
 * checkpoint (e.g. Engineer running before the initial Architect approved).
 */
export function assertTransition(from: FactoryState, to: FactoryState): void {
  if (from === to) return;
  if (!isLegalTransition(from, to)) {
    throw new Error(
      `Illegal Factory transition: ${from} -> ${to}. Legal: ${TRANSITIONS[from].join(", ") || "(terminal)"}`,
    );
  }
}

/** Whether a state is terminal (the run can never leave it). */
export function isTerminal(state: FactoryState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Whether a state is one the run actively drives (not terminal, not parked). */
export function isActive(state: FactoryState): boolean {
  return !isTerminal(state) && state !== "WAITING_CAPACITY";
}

/* -------------------------------------------------------------------------- */
/* Recovery eligibility                                                        */
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
/** Compute the checkpoint identifier for a given state snapshot. */
function computeCheckpointId(state: FactoryRunState): string {
  // Preserve the existing approval-token spelling for compatibility. The
  // durable Task-1 identity is exposed separately as `checkpoint` by the
  // recovery model and includes run id, progress, invocation, and revision.
  const s = state.state;
  const scope = state.version === 3 && (state.targetPlan?.targets.length ?? 0) > 1
    ? `:target=${state.targetPlan?.currentTargetId ?? state.results.finalArchitect?.packet.affectedTargetIds?.[0] ?? "none"}:revision=${state.stateRevision ?? 0}` : "";

  // Terminal states
  if (s === "DONE" || s === "STOPPED" || s === "FAILED") {
    return `terminal:${s}`;
  }

  // WAITING_CAPACITY: park state
  if (s === "WAITING_CAPACITY") {
    return `WAITING_CAPACITY:${state.waiting?.phase ?? "unknown"}${scope}`;
  }

  // Active states with an in-flight agent: interrupted mid-invocation.
  // Include the agentId so the checkpoint is unique per invocation — a new
  // Engineer spawn in a later repair round gets a different agentId, making
  // a stale approval token invalid.
  if (state.inFlight !== undefined) {
    return `${s}:${state.inFlight.phase}:${state.inFlight.agentId}${scope}`;
  }

  // Active states parked on backoff: safe to resume
  if (state.parked) {
    return `${s}:parked${scope}`;
  }

  // Clean boundary: no in-flight, not parked
  return `${s}:clean${scope}`;
}

export function assessRecoveryEligibility(state: FactoryRunState): FactoryRecoveryEligibility {
  const { state: s, stoppedReason, errors } = state;

  // --- Terminal states: never recoverable ---

  if (s === "DONE") {
    return {
      eligible: false,
      reason: "Run already completed",
      requiresApproval: false,
      notes: ["The run reached DONE. No recovery needed or possible."],
      checkpointId: computeCheckpointId(state),
    };
  }

  if (s === "STOPPED") {
    return {
      eligible: false,
      reason: "Run was stopped",
      requiresApproval: false,
      notes: stoppedReason ? [`Stopped reason: ${stoppedReason}`] : ["No stop reason recorded."],
      checkpointId: computeCheckpointId(state),
    };
  }

  if (s === "FAILED") {
    return {
      eligible: false,
      reason: "Run failed",
      requiresApproval: false,
      notes: errors.length > 0
        ? [`Last error: ${errors[errors.length - 1].message}`]
        : ["No error details recorded."],
      checkpointId: computeCheckpointId(state),
    };
  }

  // --- WAITING_CAPACITY: park state, recoverable without approval ---

  if (s === "WAITING_CAPACITY") {
    return {
      eligible: true,
      reason: "Parked waiting for capacity",
      requiresApproval: false,
      notes: [
        `Will resume into state: ${state.waiting?.resumeState ?? "unknown"}`,
        ...(state.waiting?.reasons.length ? ["Reasons: " + state.waiting.reasons.join(", ")] : []),
      ],
      checkpointId: computeCheckpointId(state),
    };
  }

  // --- Active states: recoverable, but may require approval ---

  const activeStates = [
    "DISCOVERY",
    "INITIAL_ARCHITECT",
    "EXECUTION",
    "REVIEW",
    "ARCHITECT_ESCALATION",
    "INTEGRATION",
    "FINAL_ARCHITECT",
    "REMEDIATION",
    "FINAL_ARCHITECT_RECHECK",
    "FINAL_SYNTHESIS",
  ] as const;

  if (!activeStates.includes(s)) {
    // Should never happen — the state machine enforces this.
    return {
      eligible: false,
      reason: `Unknown state: ${s}`,
      requiresApproval: false,
      notes: ["This state is not recognized by the recovery system."],
      checkpointId: computeCheckpointId(state),
    };
  }

  // The run is in an active state. It is recoverable because the persisted
  // state carries all completed phase packets (the controller never advances
  // without persisting a valid result first).
  //
  // However, if the run was interrupted (no inFlight agent but not at a
  // natural phase boundary), the interrupted phase may have left partial
  // workspace changes. The user must approve before replaying.

  // The phase the run would drive next may have an unresolved spawn attempt
  // (prepared / spawn_requested with no settlement): a child may have been
  // dispatched whose outcome is unknown. Automatic replay is never allowed;
  // only explicit approval may authorize it. This is checked before the
  // in-flight and parked branches so it cannot be masked by either flag.
  const currentPhase = state.inFlight?.phase ?? state.waiting?.phase ?? (s === "EXECUTION" ? "execution.engineer" : s === "REMEDIATION" ? "remediation.engineer" : undefined);
  const currentAttempt = currentPhase === undefined ? undefined : latestAttemptForPhase(state, currentPhase);
  if (currentAttempt?.provenance === "settled_validated_packet"
    && (currentPhase === "execution.engineer" || currentPhase === "remediation.engineer")
    && !hasPersistedAttemptPacket(state, currentAttempt)) {
    return {
      eligible: true,
      reason: `Validated Engineer provenance for ${currentPhase} has no matching persisted packet`,
      requiresApproval: true,
      notes: ["The run will not replay this Engineer automatically.", "Explicit approval is required before retrying the uncertain workspace operation."],
      checkpointId: computeCheckpointId(state),
    };
  }

  const unresolved = unresolvedSpawnAttempt(state);
  if (unresolved !== undefined) {
    return {
      eligible: true,
      reason: `Phase "${unresolved.phase}" has unresolved spawn provenance (${unresolved.provenance}); automatic replay is not allowed`,
      requiresApproval: true,
      notes: [
        `A spawn for ${unresolved.phase} was requested but never settled; its outcome is unknown.`,
        "Explicit approval is required before the phase may be replayed.",
      ],
      checkpointId: computeCheckpointId(state),
    };
  }

  const inFlight = state.inFlight;
  const isParked = state.parked;

  // If the run has an in-flight agent, it was interrupted mid-invocation.
  // The agent cannot have survived process death (agents are in-process),
  // so the phase must be retried from scratch.
  if (inFlight !== undefined) {
    return {
      eligible: true,
      reason: `Interrupted in ${s} — phase "${inFlight.phase}" (${inFlight.role}) must be retried`,
      requiresApproval: true,
      notes: [
        `Phase ${inFlight.phase} was in-flight when the run was interrupted.`,
        `Retrying from scratch (no partial results to replay).`,
      ],
      checkpointId: computeCheckpointId(state),
    };
  }

  // If the run is parked (backoff retry), it is safe to resume without
  // approval — no phase was interrupted, the run was just waiting.
  if (isParked) {
    return {
      eligible: true,
      reason: `Parked on backoff retry in ${s}`,
      requiresApproval: false,
      notes: ["The run was parked on a transient backoff; no phase was interrupted."],
      checkpointId: computeCheckpointId(state),
    };
  }

  // The run is in an active state with no in-flight agent and not parked.
  // This means the process died between phases (after a phase completed but
  // before the next action was taken). The persisted state is consistent
  // (all completed phases have valid packets), so recovery is safe.
  //
  // However, if the current phase is one that modifies files (Engineer),
  // we flag it for user approval because the Engineer may have left partial
  // workspace changes before producing its result packet.
  if (state.version === 3 && s === "EXECUTION" && state.targetPlan && !state.targetPlan.currentTargetId) {
    return {
      eligible: true,
      reason: "Accepted target checkpoint; the next eligible target has not been dispatched",
      requiresApproval: false,
      notes: ["All completed targets have persisted Reviewer PASS evidence.", "No successor Engineer attempt has started."],
      checkpointId: computeCheckpointId(state),
    };
  }

  const phaseRequiresApproval = s === "EXECUTION" || s === "REMEDIATION";

  return {
    eligible: true,
    reason: `Can resume from ${s} — all completed phases have valid persisted packets`,
    requiresApproval: phaseRequiresApproval,
    notes: phaseRequiresApproval
      ? [
          `The ${s} phase may have left partial workspace changes.`,
          "User approval required before replaying.",
        ]
      : [
          `Next action: ${nextPhaseLabel(s)}`,
          "All completed phases have valid persisted packets — no replay needed.",
        ],
    checkpointId: computeCheckpointId(state),
  };
}

/** Human-readable label for the next phase from a given state. */
function nextPhaseLabel(state: FactoryState): string {
  switch (state) {
    case "DISCOVERY":
      return "spawn Lead for DISCOVERY";
    case "INITIAL_ARCHITECT":
      return "spawn Architect for INITIAL_ARCHITECT";
    case "EXECUTION":
      return "spawn Engineer for EXECUTION";
    case "REVIEW":
      return "spawn Reviewer for REVIEW";
    case "ARCHITECT_ESCALATION":
      return "spawn Architect for ARCHITECT_ESCALATION";
    case "INTEGRATION":
      return "spawn Lead for INTEGRATION";
    case "FINAL_ARCHITECT":
      return "spawn Architect for FINAL_ARCHITECT";
    case "REMEDIATION":
      return "spawn Engineer for REMEDIATION";
    case "FINAL_ARCHITECT_RECHECK":
      return "spawn Architect for FINAL_ARCHITECT_RECHECK";
    case "FINAL_SYNTHESIS":
      return "spawn Lead for FINAL_SYNTHESIS";
    default:
      return "unknown";
  }
}
