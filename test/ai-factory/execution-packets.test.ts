import { describe, expect, it } from "vitest";
import { packetSchema, parsePacketTyped } from "../../src/ai-factory/packets.js";
import {
  conformanceArchitectPrompt,
  engineerPrompt,
  executionContractPrompt,
  finalReportPrompt,
  integratedReviewPrompt,
  leadIntegrationPrompt,
} from "../../src/ai-factory/prompts.js";
import type { ExecutionContractPacket, IntegratedReviewPacket } from "../../src/ai-factory/types.js";
import { packets } from "./fakes.js";

const contract: ExecutionContractPacket = {
  goal: "Add the feature",
  repositoryFindings: "Existing implementation is modular",
  currentArchitecture: "Layered modules",
  assumptions: [],
  proposedSolution: "Implement the requested layer",
  constraints: ["Do not redesign"],
  humanRequirements: ["Add the feature"],
  missionRequirements: [],
  workPackages: ["target-a"],
  targets: [{ id: "target-a", description: "Implement the feature", dependsOn: [], acceptanceCriteria: ["Works"] }],
  dependencies: "none",
  risks: [],
  acceptanceCriteria: ["Tests pass"],
  architecturalQuestions: [],
  verification: { "target-a": { command: "npm test -- feature", evidence: "Target test passes" } },
};

const review: IntegratedReviewPacket = {
  verdict: "PASS",
  affectedTargetIds: [],
  blockingFindings: [],
  nonBlockingFindings: [],
  requiredRepairs: [],
  testConcerns: [],
  architecturalIssue: false,
};

describe("execution workflow packets and prompts", () => {
  it("keeps Engineer completion scoped to implementation and Engineer-side checks", () => {
    const prompt = engineerPrompt({
      workPackageId: "P20-A2-BOUNDARY-VERIFY",
      architecture: "approved architecture",
      task: "Complete the boundary verification",
      acceptanceCriteria: ["Boundary test passes"],
      constraints: [],
    });
    expect(prompt).toContain("completed does NOT claim Reviewer or Architect approval");
    expect(prompt).toContain("partially_completed only when concrete assigned-package work still remains");
    expect(prompt).toContain("Do NOT use it because Reviewer, Architect, Integrated Reviewer, Final Architect");
    expect(prompt).toContain("List each concrete unfinished assigned-package item in remainingWork");
  });

  it("parses execution contracts with per-target verification", () => {
    const parsed = parsePacketTyped("execution_proposal", JSON.stringify(contract), undefined);
    expect(parsed?.verification["target-a"].evidence).toBe("Target test passes");
    expect(parsed?.requirementCatalog).toEqual([
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-002", text: "Do not redesign", source: "human_constraint" },
    ]);
    expect(packetSchema("execution_proposal")).toBeDefined();
    expect(parsePacketTyped("integrated_review", JSON.stringify({ verdict: "ARCHITECTURE_CONTRADICTION", affectedTargetIds: [] }), undefined)).toBeUndefined();
  });

  it("accepts paraphrased, reordered identity references and persists Factory-canonical wording", () => {
    const packet = parsePacketTyped("execution_proposal", JSON.stringify({
      ...contract,
      requirementCatalog: [
        { id: "REQ-002", text: "The user's no-redesign constraint", source: "human_constraint" },
        { id: "REQ-001", text: "A reusable parser is required", source: "human_requirement" },
      ],
    }), undefined);
    expect(packet?.requirementCatalog).toEqual([
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-002", text: "Do not redesign", source: "human_constraint" },
    ]);
  });

  it.each([
    ["missing identity", [{ id: "REQ-001", text: "Add the feature", source: "human_requirement" }]],
    ["unknown identity", [
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-999", text: "Constraint", source: "human_constraint" },
    ]],
    ["duplicate identity", [
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-001", text: "Constraint", source: "human_constraint" },
    ]],
    ["omitted explicit constraint", [{ id: "REQ-001", text: "Add the feature", source: "human_requirement" }]],
    ["misclassified explicit constraint", [
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-002", text: "Do not redesign", source: "human_requirement" },
    ]],
  ])("rejects %s from a supplied catalog", (_label, requirementCatalog) => {
    expect(parsePacketTyped("execution_proposal", JSON.stringify({ ...contract, requirementCatalog }), undefined)).toBeUndefined();
  });

  it("does not require model-authored IDs in the execution output schema", () => {
    const schema = packetSchema("execution_proposal").schema;
    expect(schema.required).toContain("humanRequirements");
    expect(schema.required).toContain("constraints");
    expect(schema.required).toContain("missionRequirements");
    expect(schema.properties).not.toHaveProperty("requirementCatalog");
  });

  it("keeps report/lifecycle instructions out of implementation targets and owner verification", () => {
    const packet = parsePacketTyped("execution_proposal", JSON.stringify({
      goal: "Build the inventory utility",
      proposedSolution: "Three reusable dependency-free modules",
      humanRequirements: ["Implement a reusable CSV parser", "Aggregate inventory using the parser", "Add an independent slug utility"],
      constraints: ["Use plain JavaScript and Node built-ins only"],
      missionRequirements: [
        "Include the Integrated Reviewer verdict in the final report.",
        "Report incomplete or owner-pending verification, if any.",
        "Stop after validation and final reporting.",
      ],
      workPackages: ["CSV parser", "Inventory aggregation", "Slug utility"],
      targets: [
        { id: "CSV_PARSER", description: "Implement parser", dependsOn: [], acceptanceCriteria: ["Parses required input"] },
        { id: "INVENTORY", description: "Aggregate quantities", dependsOn: ["CSV_PARSER"], acceptanceCriteria: ["Uses parser"] },
        { id: "SLUG", description: "Normalize labels", dependsOn: [], acceptanceCriteria: ["Produces stable IDs"] },
      ],
      humanDependencies: [],
      dependencies: "Inventory uses the CSV parser; slug utility is independent.",
      risks: [], acceptanceCriteria: ["Utility behavior is tested"], architecturalQuestions: [],
      verification: {
        CSV_PARSER: { command: "node --test test/csv.test.js", evidence: "Parser tests pass" },
        INVENTORY: { command: "node --test test/inventory.test.js", evidence: "Aggregation tests pass" },
        SLUG: { command: "node --test test/slug.test.js", evidence: "Slug tests pass" },
      },
    }), undefined);
    expect(packet).toBeDefined();
    expect(packet?.targets?.map((target) => target.id)).toEqual(["CSV_PARSER", "INVENTORY", "SLUG"]);
    expect(packet?.targets?.find((target) => target.id === "INVENTORY")?.dependsOn).toEqual(["CSV_PARSER"]);
    expect(packet?.missionRequirements).toHaveLength(3);
    expect(packet?.humanDependencies).toEqual([]);
    expect(Object.keys(packet?.verification ?? {})).toEqual(["CSV_PARSER", "INVENTORY", "SLUG"]);
    expect(Object.values(packet?.verification ?? {}).some((item) => item.ownerPending === true)).toBe(false);
    expect(packet?.requirementCatalog.filter((item) => item.source === "mission_requirement").map((item) => item.text)).toEqual(packet?.missionRequirements);
    expect(packet?.targets?.some((target) => target.id === "FINAL_REPORT")).toBe(false);
  });

  it("passes mission/report metadata into VERIFIED synthesis without creating owner approval", () => {
    const prompt = finalReportPrompt({
      runId: "verified-run", task: "Implement feature", architecture: "approved architecture",
      integration: packets.integration,
      finalAcceptance: { verdict: "ACCEPT", blockingIssues: [], requiredChanges: [], doNotChange: [], requiredEvidence: [] },
      engineers: [], reviewers: [], runStartedAt: 0, repairRounds: 0, remediationRounds: 0, roleTargets: [],
      missionRequirements: ["Include the Integrated Reviewer verdict", "Report owner-pending verification, if any"],
      runVerificationOutput: ["Live preview: passed; HTTP 200"],
      warningEvidence: [],
    });
    expect(prompt).toContain("Execution mission/report metadata (reporting obligations, not implementation targets)");
    expect(prompt).toContain("Include the Integrated Reviewer verdict");
    expect(prompt).toContain("Report owner-pending verification, if any");
    expect(prompt).toContain("Live preview: passed; HTTP 200");
    expect(prompt).toContain("a request to report such checks \"if any\" does not create a check");
    expect(prompt).toContain("Controller-owned warning evidence");
    expect(prompt).toContain("Factory derives the \"warnings\" array exclusively from active mission-scoped findings");
  });

  it("preserves post-implementation owner acceptance separately from machine verification", () => {
    const packet = parsePacketTyped("execution_proposal", JSON.stringify({
      ...contract,
      targets: [{ id: "SETTINGS_UI", description: "Implement settings screen", dependsOn: [], acceptanceCriteria: ["Automated layout checks pass"] }],
      workPackages: ["Settings UI"],
      humanDependencies: [],
      verification: { SETTINGS_UI: { command: "npm test -- settings", evidence: "Automated layout checks pass", ownerAcceptance: "Owner inspects rendered layout on an iPad" } },
    }), undefined);
    expect(packet?.verification.SETTINGS_UI).toMatchObject({ command: "npm test -- settings", ownerAcceptance: "Owner inspects rendered layout on an iPad" });
    expect(packet?.humanDependencies).toEqual([]);
  });

  it("parses explicit run-level checks separately from target verification", () => {
    const packet = parsePacketTyped("execution_proposal", JSON.stringify({
      ...contract,
      targets: [
        { id: "T1", description: "Tab focus", dependsOn: [], acceptanceCriteria: ["Focus routes correctly"] },
        { id: "T2", description: "Virtual paging", dependsOn: [], acceptanceCriteria: ["No gaps"] },
        { id: "T3", description: "Regression expectations", dependsOn: [], acceptanceCriteria: ["Regressions covered"] },
      ],
      verification: {
        T1: { command: "node verify-tab.mjs", evidence: "Tab focus test passes" },
        T2: { command: "node verify-paging.mjs", evidence: "Paging invariant passes" },
        T3: { command: "node verify-regressions.mjs", evidence: "Regression suite passes" },
      },
      runVerification: [{
        name: "Live preview",
        command: "node verify-live-preview.mjs",
        evidence: "HTTP 200, workspace identity matches, and tailnet exposure is restricted",
      }],
    }), undefined);
    expect(packet).toBeDefined();
    expect(Object.keys(packet?.verification ?? {})).toEqual(["T1", "T2", "T3"]);
    expect(packet?.runVerification).toEqual([{
      name: "Live preview",
      command: "node verify-live-preview.mjs",
      evidence: "HTTP 200, workspace identity matches, and tailnet exposure is restricted",
    }]);
  });

  it("parses genuine blocking human prerequisites separately from owner acceptance", () => {
    const packet = parsePacketTyped("execution_proposal", JSON.stringify({
      ...contract,
      blockingHumanDependencies: { "target-a": "Owner must provide the test device before implementation." },
    }), undefined);
    expect(packet?.blockingHumanDependencies).toEqual({ "target-a": "Owner must provide the test device before implementation." });
  });

  it("keeps FULL proposal IDs Factory-generated using the existing shared catalog", () => {
    const fullProposal = parsePacketTyped("proposal", JSON.stringify({
      goal: "Add the feature", proposedSolution: "Implement it", workPackages: ["target-a"],
      constraints: ["Do not redesign"], humanRequirements: ["Add the feature"], acceptanceCriteria: ["Works"],
    }), undefined);
    expect(fullProposal?.requirementCatalog).toEqual([
      { id: "REQ-001", text: "Add the feature", source: "human_requirement" },
      { id: "REQ-002", text: "Do not redesign", source: "human_constraint" },
    ]);
  });

  it("parses integrated review verdicts and architecture contradictions", () => {
    const packet = {
      ...review,
      verdict: "ARCHITECTURE_CONTRADICTION",
      affectedTargetIds: ["target-a"],
      architectureContradiction: {
        assumption: "The module is available",
        repositoryEvidence: "The module is absent",
        affectedTargetIds: ["target-a"],
        cannotContinueBecause: "The contract cannot be implemented",
        ownerDecisionNeeded: "Choose a supported module",
      },
    };
    const parsed = parsePacketTyped("integrated_review", JSON.stringify(packet), undefined);
    expect(parsed?.verdict).toBe("ARCHITECTURE_CONTRADICTION");
    expect(parsed?.architectureContradiction?.ownerDecisionNeeded).toBe("Choose a supported module");
    expect(parsed?.architecturalIssue).toBe(true);
  });

  it("omits contradiction-shaped explanatory text when the Reviewer says no architecture issue exists", () => {
    const parsed = parsePacketTyped("integrated_review", JSON.stringify({
      ...review,
      verdict: "PASS",
      architectureContradiction: {
        assumption: "No architecture assumption was disproved; no contradiction applies.",
        repositoryEvidence: "Continuation is not blocked.",
        affectedTargetIds: ["target-a"],
        cannotContinueBecause: "Not applicable; continuation is not blocked.",
        ownerDecisionNeeded: "None.",
      },
    }), undefined) as IntegratedReviewPacket | undefined;
    expect(parsed?.architecturalIssue).toBe(false);
    expect(parsed?.architectureContradiction).toBeUndefined();
  });

  it("parses explicit blocking Reviewer classification on integration packets", () => {
    const parsed = parsePacketTyped("integration", JSON.stringify({
      goal: "goal",
      approvedArchitecture: "architecture",
      systemVerification: "passed",
      factualAssessment: "complete",
      reviewerFindingsResolved: [],
      reviewerFindingsAcceptedRisk: [],
      reviewerFindingsUnresolved: ["blocker"],
      blockingReviewerFindings: ["blocker"],
    }), undefined) as { blockingReviewerFindings?: string[] } | undefined;
    expect(parsed?.blockingReviewerFindings).toEqual(["blocker"]);
  });

  it("makes authority, scoped commands, diff evidence, and defect distinction explicit", () => {
    const execution = executionContractPrompt("TASK");
    expect(execution).toContain("user request is authoritative");
    expect(execution).toContain("Factory assigns stable REQ-NNN identities deterministically");
    expect(execution).toContain("Do not provide a requirementCatalog or invent requirement IDs");
    expect(execution).toContain("conditional reporting such as \"report incomplete/manual/owner-pending verification, if any\"");
    expect(execution).toContain("verification.ownerAcceptance text; it is informational and does not block engineering");
    expect(execution).toContain("Never encode ownerAcceptance as a target dependency or humanDependencies edge");
    expect(execution).toContain("Use blockingHumanDependencies only for a genuine external prerequisite");
    expect(execution).toContain("whole-run, integration, live-preview, deployment, regression-matrix, artifact-identity, and packaging checks in the separate runVerification array");
    expect(execution).toContain("invent pseudo-target IDs such as live-preview");
    expect(execution).toContain("Integrated Reviewer is a configured LLM gate, not owner/manual sign-off");
    expect(execution).toContain("missionRequirements");
    expect(execution).toContain("scoped to their target");
    expect(execution).toContain("no initial or per-target Architect gate");
    expect(execution).toContain("Final integrated acceptance belongs to the configured final Architect");
    expect(execution).toContain("report architectureContradiction and stop");
    const integrated = integratedReviewPrompt({
      task: "TASK",
      architecture: "ARCH",
      contract,
      targetPlan: contract.targets ?? [],
      engineers: [],
      reviewers: [],
      latestGlobalDiff: "diff --git a/src/a.ts b/src/a.ts",
      verificationOutput: ["npm test -- feature: PASS"],
      runVerificationOutput: ["Live preview: passed"],
      pendingOwnerVerification: ["Owner confirms deployment behavior"],
    });
    expect(integrated).toContain("real code diff");
    expect(integrated).toContain("original task against every implementation requirement and hard constraint");
    expect(integrated).toContain("Do not demand a code target for missionRequirements");
    expect(integrated).toContain("this LLM workflow gate, not owner/manual sign-off");
    expect(integrated).toContain("Integrated/run-level verification output (never target outcomes)");
    expect(integrated).toContain("Live preview: passed");
    expect(integrated).toContain("REPAIR_REQUIRED");
    expect(integrated).toContain("ARCHITECTURE_CONTRADICTION");
    expect(integrated).toContain("Omit architectureContradiction when architecturalIssue is false");
    const integrationPrompt = leadIntegrationPrompt({
      task: "TASK", architecture: "ARCH", targetSummary: [], runVerificationOutput: [], engineers: [], reviewers: [],
    });
    expect(integrationPrompt).toContain("blockingReviewerFindings");
    expect(integrationPrompt).toContain("pre-Architect blockers by themselves");
    const conformance = conformanceArchitectPrompt({
      task: "TASK",
      architecture: "ARCH",
      targetOutcomes: ["target-a passed"],
      engineers: [],
      verificationEvidence: ["feature test: PASS"],
      runVerificationEvidence: ["Live preview: passed"],
      repairs: ["none"],
      limitations: ["manual deployment check pending"],
      contract,
      review,
      integration: {
        goal: "Add the feature",
        approvedArchitecture: "Layered modules",
        completedWorkPackages: ["target-a"],
        importantDecisions: [],
        deviations: [],
        systemVerification: "feature test: PASS",
        reviewerFindingsResolved: [],
        reviewerFindingsAcceptedRisk: [],
        reviewerFindingsUnresolved: [],
        selectedFiles: ["src/a.ts"],
        factualAssessment: "complete",
      },
    });
    expect(conformance).toContain("Do not redesign");
    expect(conformance).toContain("latest actual integrated workspace/state");
    expect(conformance).toContain("not a per-target Architect gate");
    expect(conformance).toContain("must not be treated as a missing per-target acceptance packet");
    expect(conformance).toContain("Integrated/run-level verification evidence");
    expect(conformance).toContain("Live preview: passed");
    expect(conformance).toContain("manual deployment check pending");
  });
});
