import { describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { createFactoryCheckpoint, validatePersistedFactoryRunState } from "../../src/ai-factory/recovery-model.js";
import { createRequirementCatalog, createTargetPlan } from "../../src/ai-factory/targets.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { packets } from "./fakes.js";

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

  it("reads a historical VERIFIED target with requiresArchitectAcceptance after Engineer and verification pass", () => {
    const state = baseState();
    const target = { id: "T1-TAB-FOCUS-ROUTING", description: "Tab focus", dependsOn: [], acceptanceCriteria: ["Focus routes correctly"], requiresArchitectAcceptance: true };
    state.workflow = { mode: "verified_execution" };
    state.state = "EXECUTION";
    state.results.executionProposal = {
      packet: { ...proposal, workPackages: [target.id], targets: [target], verification: { [target.id]: { command: "npm test", evidence: "target verification passed" } } },
      agentId: "lead-1",
    };
    state.results.engineers = [{
      targetId: target.id,
      round: 0,
      outcome: { packet: { ...packets.engineer, workPackageId: target.id }, agentId: "engineer-1" },
    }];
    state.targetPlan = createTargetPlan([target]);
    state.targetPlan.outcomes[target.id] = {
      status: "passed",
      engineerAgentId: "engineer-1",
      verification: { status: "passed", command: "npm test", evidence: "target verification passed" },
    };
    state.stateRevision = 2;
    state.checkpoint = createFactoryCheckpoint(state, state.stateRevision);
    expect(validatePersistedFactoryRunState(state).issues).toEqual([]);
  });

  it("still rejects a passed FULL target that lacks its configured Architect acceptance", () => {
    const state = baseState();
    const target = { id: "WP0", description: "Target", dependsOn: [], acceptanceCriteria: ["criterion"], requiresArchitectAcceptance: true };
    state.workflow = { mode: "full" };
    state.state = "EXECUTION";
    state.results.engineers = [{ targetId: target.id, round: 0, outcome: { packet: { ...packets.engineer, workPackageId: target.id }, agentId: "engineer-1" } }];
    state.results.reviewers = [{ targetId: target.id, round: 0, outcome: { packet: packets.reviewerPass, agentId: "reviewer-1" } }];
    state.targetPlan = createTargetPlan([target]);
    state.targetPlan.outcomes[target.id] = {
      status: "passed", engineerAgentId: "engineer-1", reviewerAgentId: "reviewer-1",
      verification: { status: "passed", command: "npm test", evidence: "target verification passed" },
    };
    state.stateRevision = 2;
    state.checkpoint = createFactoryCheckpoint(state, state.stateRevision);
    expect(validatePersistedFactoryRunState(state).issues).toContain("targetPlan.outcomes.WP0 requires target Architect acceptance");
  });

  it("continues to read the historical stopped flat-map contract with a live-preview pseudo-target", () => {
    const state = baseState();
    state.workflow = { mode: "verified_execution" };
    state.state = "STOPPED";
    state.stoppedReason = "Invalid execution contract: verification contains an unknown target";
    state.checkpoint = { ...state.checkpoint!, state: "STOPPED", phase: "terminal:STOPPED" };
    state.results.executionProposal = {
      packet: {
        ...proposal,
        targets: [
          { id: "T1", description: "Tab focus", dependsOn: [], acceptanceCriteria: ["Focus works"] },
          { id: "T2", description: "Paging", dependsOn: [], acceptanceCriteria: ["No gaps"] },
          { id: "T3", description: "Regression update", dependsOn: [], acceptanceCriteria: ["Tests updated"] },
        ],
        verification: {
          T1: { command: "npm test -- T1", evidence: "T1 check" },
          T2: { command: "npm test -- T2", evidence: "T2 check" },
          T3: { command: "npm test -- T3", evidence: "T3 check" },
          "live-preview": { command: "curl https://preview/schema19-edit", evidence: "HTTP 200 and workspace identity" },
        },
      },
      agentId: "lead-1",
    };
    expect(validatePersistedFactoryRunState(state).issues).toEqual([]);
  });

  it("continues to read legacy contracts with ownerPending and command but no new metadata fields", () => {
    const state = baseState();
    state.workflow = { mode: "verified_execution" };
    state.results.executionProposal = {
      packet: {
        ...proposal,
        humanDependencies: [{ targetId: "WP0", dependsOn: "Owner performs the real-device acceptance checklist" }],
        verification: { WP0: { command: "npm run verify", evidence: "Automated verification and device checklist", ownerPending: true } },
      },
      agentId: "lead-1",
    };
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
