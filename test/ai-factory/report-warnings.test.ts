import { describe, expect, it } from "vitest";
import { formatFactoryReport } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { emptyFactoryMetrics } from "../../src/ai-factory/metrics.js";
import { applyReportWarningDecisions, collectReportWarningEvidence } from "../../src/ai-factory/report-warnings.js";
import { createTargetPlan } from "../../src/ai-factory/targets.js";
import type { FactoryRunState, FinalReportPacket, IntegratedReviewPacket } from "../../src/ai-factory/types.js";
import { packets } from "./fakes.js";

function makeState(mode: "full" | "lean" | "verified_execution" = "lean"): FactoryRunState {
  const now = 1_000;
  const targets = [
    { id: "T1", description: "Implement component A", dependsOn: [], acceptanceCriteria: ["A works"] },
    { id: "T2", description: "Implement component B", dependsOn: [], acceptanceCriteria: ["B works"] },
  ];
  const targetPlan = createTargetPlan(targets);
  for (const target of targets) {
    targetPlan.outcomes[target.id].status = "passed";
    targetPlan.outcomes[target.id].verification = { status: "passed", evidence: `${target.id} verified` };
    targetPlan.outcomes[target.id].engineerAgentId = `engineer-${target.id}`;
    targetPlan.outcomes[target.id].reviewerAgentId = `reviewer-${target.id}`;
  }
  const integratedReview: IntegratedReviewPacket = {
    verdict: "PASS", affectedTargetIds: ["T1", "T2"], blockingFindings: [],
    nonBlockingFindings: ["The integrated reviewer noted the output contract should be documented."],
    requiredRepairs: [], testConcerns: [], architecturalIssue: false,
  };
  return {
    version: 3, runId: `warning-${mode}`, createdAt: now, updatedAt: now,
    task: "Implement components A and B", cwd: "/tmp/project", config: defaultFactoryConfig(),
    workflow: { mode }, state: "DONE", repairRound: 0, repairExhausted: false,
    effectiveArchitecture: "Two independent modules", remediationRounds: 0,
    architectEscalations: 0, leadEscalations: 0,
    targetPlan,
    results: {
      engineers: [
        { targetId: "T1", round: 0, outcome: { agentId: "engineer-T1", packet: {
          ...packets.engineer, workPackageId: "T1", summary: "Implemented component A",
          knownLimitations: ["Component B is not implemented in this work package.", "Quoted CSV fields are unsupported."],
        } } },
        { targetId: "T2", round: 0, outcome: { agentId: "engineer-T2", packet: {
          ...packets.engineer, workPackageId: "T2", summary: "Implemented component B successfully", knownLimitations: [],
        } } },
      ],
      reviewers: [
        { targetId: "T1", round: 0, outcome: { agentId: "reviewer-T1", packet: { ...packets.reviewerPass } } },
        { targetId: "T2", round: 0, outcome: { agentId: "reviewer-T2", packet: { ...packets.reviewerPass } } },
      ],
      integratedReview: { agentId: "integrated-reviewer", packet: integratedReview },
      integration: { agentId: "integration-lead", packet: {
        ...packets.integration,
        deviations: ["Report ordering is name-ascending."],
        reviewerFindingsAcceptedRisk: [],
      } },
      ...(mode === "verified_execution" ? { finalArchitect: { agentId: "final-architect", packet: {
        ...packets.accept,
        blockingIssues: ["The accepted scope does not transliterate non-ASCII IDs."],
      } } } : {}),
    },
    metrics: { ...emptyFactoryMetrics(now), runEndedAt: now + 1_000, runDurationMs: 1_000 },
    errors: [], parked: false,
  };
}

function finalize(state: FactoryRunState, overrides: Record<string, "active" | "superseded" | "historical"> = {}): FinalReportPacket {
  const evidence = collectReportWarningEvidence(state);
  const warningDecisions = evidence.map((item) => ({
    findingId: item.findingId,
    disposition: overrides[item.text] ?? "active",
    ...(overrides[item.text] === "superseded" ? { supersededBy: "Later accepted target and integration evidence" } : {}),
  }));
  const finalReport = applyReportWarningDecisions(packets.finalReport as unknown as FinalReportPacket, evidence, warningDecisions);
  if (!finalReport) throw new Error("test report warning decisions failed normalization");
  state.results.finalReport = { agentId: "final-lead", packet: finalReport };
  return finalReport;
}

describe("AI Factory report warning provenance", () => {
  it("keeps superseded target-local incompleteness out of mission warnings", () => {
    const state = makeState("lean");
    const report = finalize(state, { "Component B is not implemented in this work package.": "superseded" });
    expect(report.warnings).not.toContain("Component B is not implemented in this work package.");
    expect(report.warningFindings?.find((item) => item.text.startsWith("Component B"))).toMatchObject({
      source: "engineer", scope: "target_local", targetIds: ["T1"], disposition: "superseded",
    });
    const rendered = formatFactoryReport(state);
    expect(rendered).not.toContain("Warnings / limitations\n- engineer [T1] (known limitation): Component B is not implemented");
    expect(rendered).toContain("Superseded / historical findings");
    expect(rendered).toContain("T1");
  });

  it("preserves a genuine target limitation with explicit target attribution", () => {
    const state = makeState();
    const report = finalize(state);
    expect(report.warningFindings?.find((item) => item.text === "Quoted CSV fields are unsupported.")).toMatchObject({
      source: "engineer", scope: "target_local", targetIds: ["T1"], disposition: "active",
    });
    const rendered = formatFactoryReport(state);
    expect(rendered).toContain("Target-local limitations");
    expect(rendered).toContain("engineer [T1]");
    expect(rendered).toContain("Quoted CSV fields are unsupported.");
    expect(report.warnings).not.toContain("Quoted CSV fields are unsupported.");
  });

  it("retains target Reviewer source and target scope in the terminal report", () => {
    const state = makeState();
    state.results.reviewers[0]!.outcome.packet.nonBlockingFindings = ["T1 has a target-local reviewer note."];
    const report = finalize(state);
    expect(report.warningFindings?.find((item) => item.text === "T1 has a target-local reviewer note.")).toMatchObject({
      source: "target_reviewer", scope: "target_local", targetIds: ["T1"],
    });
    expect(formatFactoryReport(state)).toContain("target_reviewer [T1] non-blocking: T1 has a target-local reviewer note.");
  });

  it("keeps Integration Lead findings mission-level", () => {
    const state = makeState();
    const report = finalize(state);
    expect(report.warnings).toContain("Report ordering is name-ascending.");
    expect(report.warningFindings?.find((item) => item.text === "Report ordering is name-ascending.")).toMatchObject({
      source: "integration_lead", scope: "mission", disposition: "active",
    });
    expect(formatFactoryReport(state)).toContain("integration_lead (accepted integration: deviation): Report ordering is name-ascending.");
  });

  it("preserves Integrated Reviewer findings as mission-scope evidence", () => {
    const state = makeState();
    const report = finalize(state);
    expect(report.warningFindings?.find((item) => item.text.includes("integrated reviewer noted"))).toMatchObject({
      source: "integrated_reviewer", scope: "mission", targetIds: ["T1", "T2"], disposition: "active",
    });
    expect(report.warnings.some((item) => item.includes("integrated reviewer noted"))).toBe(true);
  });

  it("labels integration findings from before remediation as historical when superseded", () => {
    const state = makeState("verified_execution");
    state.results.integration!.packet.reviewerFindingsUnresolved = ["The parser still lacks Component B."];
    state.results.remediation = {
      engineer: { agentId: "repair-engineer", packet: { ...packets.engineer, workPackageId: "T2", summary: "Implemented Component B" } },
      reviewer: { agentId: "repair-reviewer", packet: packets.reviewerPass },
    };
    const report = finalize(state, { "The parser still lacks Component B.": "historical" });
    expect(report.warnings).not.toContain("The parser still lacks Component B.");
    expect(report.warningFindings?.find((item) => item.text === "The parser still lacks Component B.")).toMatchObject({
      source: "integration_lead", scope: "mission", disposition: "historical",
    });
    expect(formatFactoryReport(state)).toContain("Pre-remediation integration evidence (historical)");
  });

  it("keeps VERIFIED EXECUTION Final Architect findings separate from Engineer limitations", () => {
    const state = makeState("verified_execution");
    const report = finalize(state);
    expect(report.warningFindings?.find((item) => item.text.startsWith("The accepted scope"))).toMatchObject({
      source: "final_architect", scope: "mission", disposition: "active",
    });
    expect(report.warningFindings?.find((item) => item.text === "Quoted CSV fields are unsupported.")).toMatchObject({
      source: "engineer", scope: "target_local", targetIds: ["T1"],
    });
    expect(report.warnings).toContain("The accepted scope does not transliterate non-ASCII IDs.");
    expect(report.warnings).not.toContain("Quoted CSV fields are unsupported.");
  });

  it("keeps FULL legacy report rendering compatible when provenance is absent", () => {
    const state = makeState("full");
    const report = { ...packets.finalReport, warningDecisions: undefined } as unknown as FinalReportPacket;
    state.workflow = undefined;
    state.results.finalReport = { agentId: "old-final-lead", packet: report };
    const rendered = formatFactoryReport(state);
    expect(rendered).toContain("Warnings / limitations");
    expect(rendered).toContain("manual smoke test still pending");
    expect(rendered).not.toContain("Target-local limitations");
  });

  it("does not retain a LEAN target-local incompleteness statement as a mission warning after success", () => {
    const state = makeState("lean");
    const report = finalize(state, { "Component B is not implemented in this work package.": "historical" });
    expect(report.warnings).toEqual(["The integrated reviewer noted the output contract should be documented.", "Report ordering is name-ascending."]);
    expect(formatFactoryReport(state)).not.toContain("Warnings / limitations\n- engineer [T1] (known limitation): Component B");
  });

  it("keeps terminal warning rendering idempotent and leaves persisted dispositions unchanged", () => {
    const state = makeState("lean");
    finalize(state, { "Component B is not implemented in this work package.": "superseded" });
    const persistedBefore = structuredClone(state.results.finalReport?.packet);
    const first = formatFactoryReport(state);
    const second = formatFactoryReport(state);
    expect(second).toBe(first);
    expect(state.results.finalReport?.packet).toEqual(persistedBefore);
  });

  it("defaults omitted dispositions without changing controller-owned scope and rejects unknown or duplicate IDs", () => {
    const state = makeState();
    const evidence = collectReportWarningEvidence(state);
    const defaulted = applyReportWarningDecisions(packets.finalReport as unknown as FinalReportPacket, evidence, []);
    expect(defaulted?.warningFindings?.filter((item) => item.scope === "target_local").every((item) => item.disposition === "active")).toBe(true);
    expect(defaulted?.warnings).toEqual(defaulted?.warningFindings?.filter((item) => item.scope === "mission" && item.disposition === "active").map((item) => item.text));
    const complete = evidence.map((item) => ({ findingId: item.findingId, disposition: "active" as const }));
    expect(applyReportWarningDecisions(packets.finalReport as unknown as FinalReportPacket, evidence, [
      ...complete, { findingId: "WARN-999", disposition: "active" },
    ])).toBeUndefined();
    expect(applyReportWarningDecisions(packets.finalReport as unknown as FinalReportPacket, evidence, [
      ...complete, complete[0]!,
    ])).toBeUndefined();
  });
});
