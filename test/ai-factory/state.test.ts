/**
 * ai-factory/state.test.ts — the deterministic transition table.
 */

import { describe, expect, it } from "vitest";
import { assertTransition, isLegalTransition, isTerminal } from "../../src/ai-factory/state.js";

describe("AI Factory — state machine legality", () => {
  it("rejects illegal transitions programmatically", () => {
    // Engineer cannot run before the initial Architect.
    expect(() => assertTransition("DISCOVERY", "EXECUTION")).toThrow(/Illegal Factory transition/);
    expect(() => assertTransition("INITIAL_ARCHITECT", "DONE")).toThrow(/Illegal Factory transition/);
    // No skipping the final Architect.
    expect(() => assertTransition("INTEGRATION", "DONE")).toThrow(/Illegal Factory transition/);
    // No Engineer/Reviewer loop past REVIEW without a transition.
    expect(() => assertTransition("DONE", "EXECUTION")).toThrow(/Illegal Factory transition/);
  });

  it("allows the documented legal flow", () => {
    expect(isLegalTransition("DISCOVERY", "INITIAL_ARCHITECT")).toBe(true);
    expect(isLegalTransition("INITIAL_ARCHITECT", "EXECUTION")).toBe(true);
    expect(isLegalTransition("EXECUTION", "REVIEW")).toBe(true);
    expect(isLegalTransition("REVIEW", "INTEGRATION")).toBe(true);
    expect(isLegalTransition("REVIEW", "EXECUTION")).toBe(true); // repair loop
    expect(isLegalTransition("REVIEW", "ARCHITECT_ESCALATION")).toBe(true);
    expect(isLegalTransition("INTEGRATION", "FINAL_ARCHITECT")).toBe(true);
    // ACCEPT must pass through the final Lead synthesis, never straight to DONE.
    expect(isLegalTransition("FINAL_ARCHITECT", "FINAL_SYNTHESIS")).toBe(true);
    expect(isLegalTransition("FINAL_ARCHITECT", "DONE")).toBe(false);
    expect(isLegalTransition("FINAL_ARCHITECT", "REMEDIATION")).toBe(true);
    expect(isLegalTransition("REMEDIATION", "FINAL_ARCHITECT_RECHECK")).toBe(true);
    expect(isLegalTransition("FINAL_ARCHITECT_RECHECK", "FINAL_SYNTHESIS")).toBe(true);
    expect(isLegalTransition("FINAL_ARCHITECT_RECHECK", "STOPPED")).toBe(true);
    expect(isLegalTransition("FINAL_SYNTHESIS", "DONE")).toBe(true);
    // A final synthesis can never re-enter implementation.
    expect(isLegalTransition("FINAL_SYNTHESIS", "REMEDIATION")).toBe(false);
    expect(isLegalTransition("FINAL_SYNTHESIS", "EXECUTION")).toBe(false);
  });

  it("treats every state as capacity-parkable and resumable", () => {
    for (const state of ["DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION", "REVIEW", "ARCHITECT_ESCALATION", "INTEGRATION", "FINAL_ARCHITECT", "REMEDIATION", "FINAL_ARCHITECT_RECHECK", "FINAL_SYNTHESIS"] as const) {
      expect(isLegalTransition(state, "WAITING_CAPACITY"), `${state} -> WAITING_CAPACITY`).toBe(true);
    }
    for (const state of ["DISCOVERY", "INITIAL_ARCHITECT", "EXECUTION", "REVIEW", "INTEGRATION", "FINAL_ARCHITECT", "FINAL_SYNTHESIS"] as const) {
      expect(isLegalTransition("WAITING_CAPACITY", state), `WAITING_CAPACITY -> ${state}`).toBe(true);
    }
  });

  it("recognises terminal states", () => {
    expect(isTerminal("DONE")).toBe(true);
    expect(isTerminal("STOPPED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("EXECUTION")).toBe(false);
  });
});
