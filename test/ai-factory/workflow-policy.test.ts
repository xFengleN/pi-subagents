import { describe, expect, it } from "vitest";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { parseWorkflowSelection, workflowMode, workflowPolicy } from "../../src/ai-factory/workflow-policy.js";

describe("Factory workflow policies", () => {
  it("maps public selectors to stable independent policy identities", () => {
    expect(parseWorkflowSelection("full")).toBe("full");
    expect(parseWorkflowSelection("verified")).toBe("verified_execution");
    expect(parseWorkflowSelection("lean")).toBe("lean");
    expect(parseWorkflowSelection("other")).toBeUndefined();
    expect(workflowPolicy("full")).toMatchObject({ initialArchitect: true, perTargetReviewer: true, finalArchitect: true });
    expect(workflowPolicy("verified_execution")).toMatchObject({ initialArchitect: false, perTargetReviewer: false, finalArchitect: true });
    expect(workflowPolicy("lean")).toMatchObject({ initialArchitect: false, perTargetReviewer: false, finalArchitect: false });
  });

  it("treats historical runs without a workflow as FULL", () => {
    expect(workflowMode({} as FactoryRunState)).toBe("full");
    expect(workflowMode({ workflow: { mode: "lean" } } as FactoryRunState)).toBe("lean");
  });
});
