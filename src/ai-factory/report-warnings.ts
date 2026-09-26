import type {
  FactoryRunState,
  FinalReportPacket,
  ReportWarningDecision,
  ReportWarningFinding,
  ReportWarningScope,
  ReportWarningSource,
} from "./types.js";

/** Controller-owned warning evidence sent to final synthesis. */
export type ReportWarningEvidence = Omit<ReportWarningFinding, "disposition" | "supersededBy"> & {
  /** Controller-known chronology that the Lead may not override. */
  requiredDisposition?: "historical";
};

/**
 * Collect warning-like evidence without flattening its origin or scope.
 * Target-local packets are selected from each target's latest accepted outcome;
 * integration and acceptance packets remain mission-level evidence.
 */
export function collectReportWarningEvidence(state: FactoryRunState): ReportWarningEvidence[] {
  const evidence: ReportWarningEvidence[] = [];
  let nextId = 1;
  const add = (
    source: ReportWarningSource,
    scope: ReportWarningScope,
    targetIds: string[],
    category: string,
    values: string[],
    requiredDisposition?: "historical",
  ): void => {
    for (const text of values) {
      if (text.trim() === "") continue;
      evidence.push({
        findingId: `WARN-${String(nextId++).padStart(3, "0")}`,
        source,
        scope,
        targetIds,
        category,
        text,
        ...(requiredDisposition ? { requiredDisposition } : {}),
      });
    }
  };

  const engineers = [
    ...state.results.engineers.map((item) => ({
      targetId: item.targetId ?? item.outcome.packet.workPackageId,
      agentId: item.outcome.agentId,
      packet: item.outcome.packet,
    })),
    ...(state.results.remediation?.engineer ? [{
      targetId: state.results.remediation.engineer.packet.workPackageId,
      agentId: state.results.remediation.engineer.agentId,
      packet: state.results.remediation.engineer.packet,
    }] : []),
  ];
  const reviewers = [
    ...state.results.reviewers.map((item) => ({
      targetId: item.targetId ?? "",
      agentId: item.outcome.agentId,
      packet: item.outcome.packet,
    })),
    ...(state.results.remediation?.reviewer ? [{
      targetId: state.results.remediation.engineer?.packet.workPackageId ?? "",
      agentId: state.results.remediation.reviewer.agentId,
      packet: state.results.remediation.reviewer.packet,
    }] : []),
  ];

  const targetIds = state.targetPlan?.targets.map((target) => target.id)
    ?? [...new Set(engineers.map((item) => item.targetId))];
  for (const targetId of targetIds) {
    const outcome = state.targetPlan?.outcomes[targetId];
    const engineer = [...engineers].reverse().find((item) => item.targetId === targetId
      && (outcome?.engineerAgentId === undefined || item.agentId === outcome.engineerAgentId));
    if (engineer) {
      add("engineer", "target_local", [targetId], "known limitation", engineer.packet.knownLimitations);
      add("engineer", "target_local", [targetId], "unresolved question", engineer.packet.unresolvedQuestions);
    }
    const reviewer = [...reviewers].reverse().find((item) => item.targetId === targetId
      && (outcome?.reviewerAgentId === undefined || item.agentId === outcome.reviewerAgentId));
    if (reviewer) {
      add("target_reviewer", "target_local", [targetId], "blocking finding", reviewer.packet.blockingFindings);
      add("target_reviewer", "target_local", [targetId], "non-blocking finding", reviewer.packet.nonBlockingFindings);
      add("target_reviewer", "target_local", [targetId], "test concern", reviewer.packet.testConcerns);
      add("target_reviewer", "target_local", [targetId], "required repair", reviewer.packet.requiredRepairs);
    }
  }

  const integratedReviews = state.results.integratedReviews?.length
    ? state.results.integratedReviews
    : state.results.integratedReview ? [state.results.integratedReview] : [];
  integratedReviews.forEach((outcome, index) => {
    const packet = outcome.packet;
    const category = index === integratedReviews.length - 1 ? "latest integrated review" : "earlier integrated review";
    const historical = index === integratedReviews.length - 1 ? undefined : "historical" as const;
    add("integrated_reviewer", "mission", packet.affectedTargetIds, `${category}: blocking finding`, packet.blockingFindings, historical);
    add("integrated_reviewer", "mission", packet.affectedTargetIds, `${category}: non-blocking finding`, packet.nonBlockingFindings, historical);
    add("integrated_reviewer", "mission", packet.affectedTargetIds, `${category}: test concern`, packet.testConcerns, historical);
    add("integrated_reviewer", "mission", packet.affectedTargetIds, `${category}: required repair`, packet.requiredRepairs, historical);
  });

  const integration = state.results.integration?.packet;
  if (integration) {
    const stage = state.results.remediation ? "pre-remediation integration" : "accepted integration";
    add("integration_lead", "mission", [], `${stage}: deviation`, integration.deviations);
    add("integration_lead", "mission", [], `${stage}: reviewer finding resolved`, integration.reviewerFindingsResolved, "historical");
    add("integration_lead", "mission", [], `${stage}: reviewer finding accepted as risk`, integration.reviewerFindingsAcceptedRisk);
    add("integration_lead", "mission", [], `${stage}: unresolved reviewer finding`, integration.reviewerFindingsUnresolved);
  }

  const architectPackets = [
    ...(state.results.finalArchitect ? [{ packet: state.results.finalArchitect.packet, current: state.results.finalRecheck === undefined }] : []),
    ...(state.results.finalRecheck ? [{ packet: state.results.finalRecheck.packet, current: true }] : []),
  ];
  architectPackets.forEach(({ packet, current }) => {
    const category = current ? "accepted final Architect" : "superseded final Architect";
    const affected = packet.affectedTargetIds ?? packet.architectureContradiction?.affectedTargetIds ?? [];
    const historical = current ? undefined : "historical" as const;
    add("final_architect", "mission", affected, `${category}: blocking issue`, packet.blockingIssues, historical);
    add("final_architect", "mission", affected, `${category}: required change`, packet.requiredChanges, historical);
  });
  return evidence;
}

/**
 * Bind model dispositions to controller-owned source/scope metadata. This
 * prevents target-local evidence from entering mission warnings by relabeling.
 */
export function applyReportWarningDecisions(
  report: FinalReportPacket,
  evidence: ReportWarningEvidence[],
  decisions: ReportWarningDecision[] | undefined,
): FinalReportPacket | undefined {
  if (!decisions) return undefined;
  const byId = new Map(evidence.map((item) => [item.findingId, item]));
  const findings: ReportWarningFinding[] = [];
  const byDecision = new Map<string, ReportWarningDecision>();
  for (const decision of decisions) {
    const source = byId.get(decision.findingId);
    if (!source || byDecision.has(decision.findingId)) return undefined;
    if (source.requiredDisposition && decision.disposition !== source.requiredDisposition) return undefined;
    if (decision.disposition === "superseded" && (!decision.supersededBy || decision.supersededBy.trim() === "")) return undefined;
    byDecision.set(decision.findingId, decision);
  }
  for (const source of evidence) {
    const decision = byDecision.get(source.findingId);
    const disposition = decision?.disposition ?? source.requiredDisposition ?? "active";
    const { requiredDisposition: _requiredDisposition, ...canonicalSource } = source;
    findings.push({ ...canonicalSource, disposition, ...(decision?.supersededBy ? { supersededBy: decision.supersededBy } : {}) });
  }
  const warnings = findings.filter((finding) => finding.scope === "mission" && finding.disposition === "active").map((finding) => finding.text);
  const { warningDecisions: _warningDecisions, ...persisted } = report;
  return { ...persisted, warnings, warningFindings: findings };
}
