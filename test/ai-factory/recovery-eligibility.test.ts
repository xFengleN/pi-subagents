/**
 * ai-factory/recovery-eligibility.test.ts — Deterministic recovery eligibility.
 *
 * Tests the `assessRecoveryEligibility()` function across all Factory states.
 * Verifies:
 *   - Terminal states (DONE, STOPPED, FAILED) are never recoverable.
 *   - WAITING_CAPACITY is recoverable without approval.
 *   - Active states are recoverable, with or without approval depending on
 *     whether a phase was interrupted mid-flight.
 *   - Interrupted Engineer phases flag partial workspace changes.
 */

import { describe, expect, it } from "vitest";
import { assessRecoveryEligibility, isTerminal } from "../../src/ai-factory/state.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";

/* -------------------------------------------------------------------------- */
/* Helpers — build minimal persisted state for each scenario                  */
/* -------------------------------------------------------------------------- */

function makeState(overrides: Partial<FactoryRunState> & { state: FactoryRunState["state"] }): FactoryRunState {
  return {
    version: 1,
    runId: "test-run",
    createdAt: 0,
    updatedAt: 0,
    task: "test task",
    cwd: "/tmp/test",
    config: {
      agentTypes: { lead: "factory-lead", architect: "factory-architect", engineer: "factory-engineer", reviewer: "factory-reviewer" },
      isolated: true,
      roles: {
        lead: { targets: { primary: "p/lead" }, maxTransientRetries: 2, retryDelayMs: 1000, policy: "equivalent" },
        architect: { targets: { primary: "p/arch" }, maxTransientRetries: 2, retryDelayMs: 1000, policy: "conservative" },
        engineer: { targets: { primary: "p/eng" }, maxTransientRetries: 2, retryDelayMs: 1000, policy: "permissive" },
        reviewer: { targets: { primary: "p/rev" }, maxTransientRetries: 2, retryDelayMs: 1000, policy: "quality_floor" },
      },
      maxRepairRounds: 1,
      maxArchitectRemediationRounds: 1,
      maxArchitectEscalations: 1,
      maxLeadEscalations: 1,
      defaultRetryAfterMs: 30 * 60_000,
    },
    state: overrides.state,
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 0,
    architectEscalations: 0,
    leadEscalations: 0,
    results: { engineers: [], reviewers: [] },
    metrics: {
      roles: {
        lead: { role: "lead", attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] },
        architect: { role: "architect", attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] },
        engineer: { role: "engineer", attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] },
        reviewer: { role: "reviewer", attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] },
      },
      calls: [],
      totalAttempts: 0,
      totalRetries: 0,
      totalFallbacks: 0,
      capacityWaits: 0,
      runStartedAt: 0,
    },
    errors: overrides.errors ?? [],
    stoppedReason: overrides.stoppedReason,
    parked: overrides.parked ?? false,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Terminal states: never recoverable                                         */
/* -------------------------------------------------------------------------- */

describe("recovery eligibility — terminal states", () => {
  it("DONE is not recoverable", () => {
    const result = assessRecoveryEligibility(makeState({ state: "DONE" }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run already completed");
    expect(result.requiresApproval).toBe(false);
    expect(result.notes).toContain("The run reached DONE. No recovery needed or possible.");
  });

  it("STOPPED is not recoverable", () => {
    const result = assessRecoveryEligibility(makeState({ state: "STOPPED", stoppedReason: "remediation budget exhausted" }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run was stopped");
    expect(result.requiresApproval).toBe(false);
    expect(result.notes).toContain("Stopped reason: remediation budget exhausted");
  });

  it("STOPPED without a recorded reason still rejects", () => {
    const result = assessRecoveryEligibility(makeState({ state: "STOPPED" }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run was stopped");
    expect(result.notes).toContain("No stop reason recorded.");
  });

  it("FAILED is not recoverable", () => {
    const result = assessRecoveryEligibility(
      makeState({ state: "FAILED", errors: [{ phase: "EXECUTION", role: "engineer", message: "hard error", at: 0 }] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run failed");
    expect(result.requiresApproval).toBe(false);
    expect(result.notes).toContain("Last error: hard error");
  });

  it("FAILED without recorded errors still rejects", () => {
    const result = assessRecoveryEligibility(makeState({ state: "FAILED" }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Run failed");
    expect(result.notes).toContain("No error details recorded.");
  });

  it("all three terminal states are confirmed by isTerminal()", () => {
    for (const s of ["DONE", "STOPPED", "FAILED"] as const) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* WAITING_CAPACITY: recoverable without approval                             */
/* -------------------------------------------------------------------------- */

describe("recovery eligibility — WAITING_CAPACITY", () => {
  it("is recoverable without approval", () => {
    const result = assessRecoveryEligibility(
      makeState({
        state: "WAITING_CAPACITY",
        waiting: {
          phase: "execution.engineer",
          role: "engineer",
          resumeState: "EXECUTION",
          attemptedTargets: ["p/eng", "p/eng2"],
          reasons: ["quota exhausted"],
          nextRetryAt: Date.now() + 1000,
        },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("Parked waiting for capacity");
    expect(result.requiresApproval).toBe(false);
    expect(result.notes).toContain("Will resume into state: EXECUTION");
    expect(result.notes).toContain("Reasons: quota exhausted");
  });

  it("handles missing resumeState gracefully", () => {
    const result = assessRecoveryEligibility(
      makeState({
        state: "WAITING_CAPACITY",
        waiting: {
          phase: "unknown",
          role: "engineer",
          resumeState: "EXECUTION",
          attemptedTargets: [],
          reasons: [],
          nextRetryAt: Date.now() + 1000,
        },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Active states: recoverable, approval depends on interruption               */
/* -------------------------------------------------------------------------- */

describe("recovery eligibility — active states", () => {
  // --- No in-flight agent, not parked: clean phase boundary ---

  for (const state of [
    "DISCOVERY",
    "INITIAL_ARCHITECT",
    "INTEGRATION",
    "FINAL_ARCHITECT",
    "FINAL_ARCHITECT_RECHECK",
    "FINAL_SYNTHESIS",
    "ARCHITECT_ESCALATION",
  ] as const) {
    it(`${state} without in-flight agent is recoverable without approval`, () => {
      const result = assessRecoveryEligibility(makeState({ state }));
      expect(result.eligible).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.notes.some((n) => n.startsWith("Next action:"))).toBe(true);
      expect(result.notes.some((n) => n.includes("no replay needed"))).toBe(true);
    });
  }

  // --- EXECUTION and REMEDIATION: Engineer phases may have partial changes ---

  for (const state of ["EXECUTION", "REMEDIATION"] as const) {
    it(`${state} without in-flight agent is recoverable but requires approval`, () => {
      const result = assessRecoveryEligibility(makeState({ state }));
      expect(result.eligible).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.notes.some((n) => n.includes("partial workspace changes"))).toBe(true);
      expect(result.notes.some((n) => n.includes("User approval required"))).toBe(true);
    });
  }

  // --- REVIEW: Reviewer does not modify files ---

  it("REVIEW without in-flight agent is recoverable without approval", () => {
    const result = assessRecoveryEligibility(makeState({ state: "REVIEW" }));
    expect(result.eligible).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  // --- With in-flight agent: interrupted mid-invocation, requires approval ---

  for (const state of [
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
  ] as const) {
    it(`${state} with in-flight agent requires approval`, () => {
      const result = assessRecoveryEligibility(
        makeState({
          state,
          inFlight: { role: "engineer", phase: `${state.toLowerCase()}.agent`, agentId: "abc123", target: "p/eng", spawnedAt: 0 },
        }),
      );
      expect(result.eligible).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain("Interrupted");
      expect(result.notes.some((n) => n.includes("Retrying from scratch"))).toBe(true);
    });
  }

  // --- Parked on backoff: safe to resume without approval ---

  it("EXECUTION parked on backoff is recoverable without approval", () => {
    const result = assessRecoveryEligibility(makeState({ state: "EXECUTION", parked: true }));
    expect(result.eligible).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.reason).toContain("Parked on backoff");
  });

  it("WAITING_CAPACITY parked is recoverable without approval (covered by WAITING_CAPACITY section)", () => {
    const result = assessRecoveryEligibility(
      makeState({
        state: "WAITING_CAPACITY",
        parked: true,
        waiting: {
          phase: "execution.engineer",
          role: "engineer",
          resumeState: "EXECUTION",
          attemptedTargets: [],
          reasons: [],
          nextRetryAt: Date.now(),
        },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Invariants and edge cases                                                  */
/* -------------------------------------------------------------------------- */

describe("recovery eligibility — invariants", () => {
  it("every non-terminal state is recoverable (eligible = true)", () => {
    const allStates = [
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
      "WAITING_CAPACITY",
    ] as const;

    for (const s of allStates) {
      const result = assessRecoveryEligibility(makeState({ state: s }));
      expect(result.eligible, `${s} should be eligible`).toBe(true);
    }
  });

  it("every terminal state is not recoverable (eligible = false)", () => {
    const terminalStates = ["DONE", "STOPPED", "FAILED"] as const;

    for (const s of terminalStates) {
      const result = assessRecoveryEligibility(makeState({ state: s }));
      expect(result.eligible, `${s} should not be eligible`).toBe(false);
    }
  });

  it("requiresApproval is never true when eligible is false", () => {
    for (const s of ["DONE", "STOPPED", "FAILED"] as const) {
      const result = assessRecoveryEligibility(makeState({ state: s }));
      expect(result.requiresApproval, `${s} should not require approval when not eligible`).toBe(false);
    }
  });

  it("every result has a non-empty reason and notes", () => {
    const allStates = [
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
      "WAITING_CAPACITY",
      "DONE",
      "STOPPED",
      "FAILED",
    ] as const;

    for (const s of allStates) {
      const result = assessRecoveryEligibility(makeState({ state: s }));
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.notes.length).toBeGreaterThan(0);
    }
  });

  it("does not mutate the input state", () => {
    const state = makeState({ state: "EXECUTION" });
    const before = JSON.stringify(state);
    assessRecoveryEligibility(state);
    const after = JSON.stringify(state);
    expect(before).toBe(after);
  });

  it("returns consistent results for identical input", () => {
    const state = makeState({ state: "EXECUTION" });
    const r1 = assessRecoveryEligibility(state);
    const r2 = assessRecoveryEligibility(state);
    expect(r1).toEqual(r2);
  });
});

/* -------------------------------------------------------------------------- */
/* State-specific approval matrix                                             */
/* -------------------------------------------------------------------------- */

describe("recovery eligibility — approval matrix", () => {
  interface ApprovalCase {
    state: FactoryRunState["state"];
    inFlight?: boolean;
    parked?: boolean;
    eligible: boolean;
    requiresApproval: boolean;
  }

  const cases: ApprovalCase[] = [
    // Terminal: never eligible, never requires approval
    { state: "DONE", eligible: false, requiresApproval: false },
    { state: "STOPPED", eligible: false, requiresApproval: false },
    { state: "FAILED", eligible: false, requiresApproval: false },

    // WAITING_CAPACITY: eligible, no approval
    { state: "WAITING_CAPACITY", eligible: true, requiresApproval: false },

    // Active states without in-flight, not parked
    { state: "DISCOVERY", eligible: true, requiresApproval: false },
    { state: "INITIAL_ARCHITECT", eligible: true, requiresApproval: false },
    { state: "EXECUTION", eligible: true, requiresApproval: true }, // Engineer phase
    { state: "REVIEW", eligible: true, requiresApproval: false },
    { state: "ARCHITECT_ESCALATION", eligible: true, requiresApproval: false },
    { state: "INTEGRATION", eligible: true, requiresApproval: false },
    { state: "FINAL_ARCHITECT", eligible: true, requiresApproval: false },
    { state: "REMEDIATION", eligible: true, requiresApproval: true }, // Engineer phase
    { state: "FINAL_ARCHITECT_RECHECK", eligible: true, requiresApproval: false },
    { state: "FINAL_SYNTHESIS", eligible: true, requiresApproval: false },

    // Active states with in-flight: always require approval
    { state: "DISCOVERY", inFlight: true, eligible: true, requiresApproval: true },
    { state: "INITIAL_ARCHITECT", inFlight: true, eligible: true, requiresApproval: true },
    { state: "EXECUTION", inFlight: true, eligible: true, requiresApproval: true },
    { state: "REVIEW", inFlight: true, eligible: true, requiresApproval: true },
    { state: "ARCHITECT_ESCALATION", inFlight: true, eligible: true, requiresApproval: true },
    { state: "INTEGRATION", inFlight: true, eligible: true, requiresApproval: true },
    { state: "FINAL_ARCHITECT", inFlight: true, eligible: true, requiresApproval: true },
    { state: "REMEDIATION", inFlight: true, eligible: true, requiresApproval: true },
    { state: "FINAL_ARCHITECT_RECHECK", inFlight: true, eligible: true, requiresApproval: true },
    { state: "FINAL_SYNTHESIS", inFlight: true, eligible: true, requiresApproval: true },

    // Active states parked on backoff: no approval
    { state: "EXECUTION", parked: true, eligible: true, requiresApproval: false },
    { state: "REVIEW", parked: true, eligible: true, requiresApproval: false },
    { state: "FINAL_SYNTHESIS", parked: true, eligible: true, requiresApproval: false },
  ];

  for (const c of cases) {
    it(`${c.state}${c.inFlight ? " (in-flight)" : ""}${c.parked ? " (parked)" : ""}: eligible=${c.eligible}, approval=${c.requiresApproval}`, () => {
      const overrides: Partial<FactoryRunState> & { state: FactoryRunState["state"] } = {
        state: c.state,
        parked: c.parked ?? false,
      };
      if (c.inFlight) {
        overrides.inFlight = { role: "engineer", phase: `${c.state.toLowerCase()}.agent`, agentId: "abc123", target: "p/eng", spawnedAt: 0 };
      }
      const result = assessRecoveryEligibility(makeState(overrides));
      expect(result.eligible).toBe(c.eligible);
      expect(result.requiresApproval).toBe(c.requiresApproval);
    });
  }
});
