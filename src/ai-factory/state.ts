/**
 * ai-factory/state.ts — The deterministic Factory state machine.
 *
 * Transitions are the one place the run decides "what comes next", and they are
 * pure code: applying a transition never asks a model anything. Illegal
 * transitions are rejected programmatically so a bug cannot silently skip a
 * mandatory checkpoint.
 */

import { type FactoryState, TERMINAL_STATES } from "./types.js";

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
  EXECUTION: ["REVIEW", "ARCHITECT_ESCALATION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  REVIEW: ["INTEGRATION", "EXECUTION", "ARCHITECT_ESCALATION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  ARCHITECT_ESCALATION: ["EXECUTION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  INTEGRATION: ["FINAL_ARCHITECT", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  FINAL_ARCHITECT: ["FINAL_SYNTHESIS", "REMEDIATION", "WAITING_CAPACITY", "FAILED", "STOPPED"],
  REMEDIATION: ["FINAL_ARCHITECT_RECHECK", "WAITING_CAPACITY", "FAILED", "STOPPED"],
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
