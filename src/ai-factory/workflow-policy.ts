import type { FactoryRunState } from "./types.js";

/** Stable persisted identities, independent of UI labels and model presets. */
export type FactoryWorkflowMode = "full" | "verified_execution" | "lean";

export interface FactoryWorkflowPolicy {
  mode: FactoryWorkflowMode;
  displayName: string;
  initialArchitect: boolean;
  perTargetReviewer: boolean;
  finalArchitect: boolean;
}

const POLICIES: Record<FactoryWorkflowMode, FactoryWorkflowPolicy> = {
  full: { mode: "full", displayName: "FULL", initialArchitect: true, perTargetReviewer: true, finalArchitect: true },
  verified_execution: { mode: "verified_execution", displayName: "VERIFIED EXECUTION", initialArchitect: false, perTargetReviewer: false, finalArchitect: true },
  lean: { mode: "lean", displayName: "LEAN", initialArchitect: false, perTargetReviewer: false, finalArchitect: false },
};

export function workflowPolicy(mode: FactoryWorkflowMode): FactoryWorkflowPolicy {
  return POLICIES[mode];
}

/** Historical runs had no workflow field; they always retain FULL semantics. */
export function workflowMode(state: FactoryRunState): FactoryWorkflowMode {
  return state.workflow?.mode ?? "full";
}

export function parseWorkflowSelection(label: string): FactoryWorkflowMode | undefined {
  switch (label.trim().toLowerCase()) {
    case "full": return "full";
    case "verified": return "verified_execution";
    case "lean": return "lean";
    default: return undefined;
  }
}
