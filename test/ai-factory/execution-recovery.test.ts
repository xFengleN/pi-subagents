import { describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { validatePersistedFactoryRunState } from "../../src/ai-factory/recovery-model.js";
import { createRequirementCatalog, createTargetPlan } from "../../src/ai-factory/targets.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";

function baseState(): FactoryRunState {
  return {
    version: 3,
    runId: "execution_recovery",
    createdAt: 1,
    updatedAt: 1,
    task: "task",
    cwd: process.cwd(),
    config: defaultFactoryConfig(),
    workflow: { mode: "lean" },
    state: "DISCOVERY",
    repairRound: 0,
    repairExhausted: false,
    effectiveArchitecture: "",
    remediationRounds: 0,
    architectEscalations: 0,
    leadEscalations: 0,
    results: { engineers: [], reviewers: [] },
    metrics: {
      roles: Object.fromEntries(["lead", "architect", "engineer", "reviewer"].map((role) => [role, { role, attempts: 0, retries: 0, fallbacks: 0, targetsAttempted: [] }])),
      totalAttempts: 0,
      totalRetries: 0,
      totalFallbacks: 0,
      capacityWaits: 0,
      runStartedAt: 1,
    } as FactoryRunState["metrics"],
    errors: [],
    parked: false,
    stateRevision: 1,
    checkpoint: { id: "checkpoint", runId: "execution_recovery", revision: 1, state: "DISCOVERY", phase: "discovery.lead", repairRound: 0, remediationRounds: 0, architectEscalations: 0, leadEscalations: 0 },
    attempts: [],
  };
}

const proposal = {
  goal: "goal", repositoryFindings: "findings", currentArchitecture: "architecture", assumptions: ["assumption"],
  proposedSolution: "solution", humanRequirements: ["goal"], constraints: ["constraint"],
  missionRequirements: ["Include the actual Reviewer verdict in the final report"],
  requirementCatalog: createRequirementCatalog(["goal"], ["constraint"], ["Include the actual Reviewer verdict in the final report"]),
  workPackages: ["WP0"], dependencies: "none", risks: ["risk"],
  acceptanceCriteria: ["criterion"], architecturalQuestions: [], targets: [{ id: "WP0", description: "target", dependsOn: [], acceptanceCriteria: ["criterion"] }],
  verification: { WP0: { evidence: "not yet verified" } },
};

describe("execution workflow persisted recovery", () => {
  it("never reinterprets historical version-2 snapshots as execution workflows", () => {
    const state = baseState();
    state.version = 2;
    expect(validatePersistedFactoryRunState(state).issues).toContain("historical runs cannot contain a workflow override");
  });
  it.each(["verified_execution", "lean"] as const)("accepts canonical %s state and contract", (mode) => {
    const state = baseState();
    state.workflow = { mode };
    state.results.executionProposal = { packet: proposal, agentId: "lead-1" };
    expect(validatePersistedFactoryRunState(state).issues).toEqual([]);
  });

  it("accepts reordered identity references with paraphrased explanatory text in persisted state", () => {
    const state = baseState();
    state.results.executionProposal = {
      packet: { ...proposal, requirementCatalog: [
        { id: "REQ-003", text: "Include the real integrated review result in the report", source: "mission_requirement" },
        { id: "REQ-002", text: "A paraphrase of the no-redesign constraint", source: "human_constraint" },
        { id: "REQ-001", text: "A paraphrase of the user goal", source: "human_requirement" },
      ] },
      agentId: "lead-1",
    };
    expect(validatePersistedFactoryRunState(state).issues.filter((issue) => issue.includes("requirementCatalog"))).toEqual([]);
  });

  it.each([
    ["missing", [{ id: "REQ-001", text: "goal", source: "human_requirement" }]],
    ["unknown", [
      { id: "REQ-001", text: "goal", source: "human_requirement" },
      { id: "REQ-999", text: "constraint", source: "human_constraint" },
    ]],
    ["duplicate", [
      { id: "REQ-001", text: "goal", source: "human_requirement" },
      { id: "REQ-001", text: "constraint", source: "human_constraint" },
    ]],
    ["omitted explicit constraint", [{ id: "REQ-001", text: "goal", source: "human_requirement" }]],
  ])("rejects %s persisted requirement identity", (_label, requirementCatalog) => {
    const state = baseState();
    state.results.executionProposal = { packet: { ...proposal, requirementCatalog }, agentId: "lead-1" };
    expect(validatePersistedFactoryRunState(state).issues.join(" ")).toContain("identities do not match");
  });

  it.each([
    ["missing", {}],
    ["unknown", { WP0: { evidence: "target test" }, UNKNOWN: { evidence: "not a target" } }],
  ])("still rejects %s verification coverage for a real target", (_label, verification) => {
    const state = baseState();
    state.workflow = { mode: "lean" };
    state.targetPlan = createTargetPlan(proposal.targets);
    state.results.executionProposal = { packet: { ...proposal, verification }, agentId: "lead-1" };
    expect(validatePersistedFactoryRunState(state).issues.join(" ")).toContain("verification must contain exactly one entry for every canonical target");
  });

  it("rejects non-canonical verification and contradiction target identities", () => {
    const state = baseState();
    state.results.executionProposal = { packet: { ...proposal, verification: { "bad id": { evidence: "evidence" } }, architectureContradiction: { assumption: "a", repositoryEvidence: "e", affectedTargetIds: ["UNKNOWN"], cannotContinueBecause: "c", ownerDecisionNeeded: "d" } }, agentId: "lead-1" };
    const result = validatePersistedFactoryRunState(state);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("canonical target identifier");
  });
});
