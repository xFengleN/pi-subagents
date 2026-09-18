/**
 * ai-factory/prompts.ts — Deterministic role prompts for Factory agents.
 *
 * Prompts are assembled here from stored packets only — no parent conversation
 * is copied in, and every role child starts with a fresh context. Each prompt
 * ends by directing the child to report through the `StructuredOutput` tool,
 * whose schema (see packets.ts) is passed as the spawn's `structuredOutput`.
 */

import type {
  ArchitectFinalResult,
  EngineerPacket,
  LeadIntegrationPacket,
  LeadProposalPacket,
  ReviewerPacket,
} from "./types.js";

const STRUCTURED = "Report your complete final answer by calling the StructuredOutput tool. Prose outside that call is discarded.";

const list = (items: string[] | undefined): string => {
  if (!items || items.length === 0) return "(none)";
  return items.map((i) => `- ${i}`).join("\n");
};

/** Lead reconnaissance + architecture proposal (DISCOVERY). */
export function leadProposalPrompt(task: string): string {
  return `You are the Technical Lead of an AI Factory run. Your job is bounded repository reconnaissance and an architecture proposal for the goal below. Do NOT implement anything.

User goal:
${task}

Perform enough repository reconnaissance to ground your proposal (read key files, note the current architecture), then produce a compact architecture packet containing: the original goal, relevant repository findings, the important current architecture, assumptions, the proposed solution, constraints, proposed work packages, dependencies, risks/uncertainties, acceptance criteria, and specific architectural questions for the Architect.

${STRUCTURED}`;
}

/** Initial Architect checkpoint (INITIAL_ARCHITECT). */
export function initialArchitectPrompt(proposal: LeadProposalPacket): string {
  return `You are the Architect — a premium, temporary consultant. A Technical Lead has produced the following architecture proposal. Review it for structural soundness.

Proposal:
- Goal: ${proposal.goal}
- Proposed solution: ${proposal.proposedSolution}
- Current architecture: ${proposal.currentArchitecture || "(not described)"}
- Repository findings: ${proposal.repositoryFindings || "(none)"}
- Assumptions:
${list(proposal.assumptions)}
- Constraints:
${list(proposal.constraints)}
- Proposed work packages:
${list(proposal.workPackages)}
- Dependencies: ${proposal.dependencies || "(none)"}
- Risks:
${list(proposal.risks)}
- Acceptance criteria:
${list(proposal.acceptanceCriteria)}
- Architectural questions:
${list(proposal.architecturalQuestions)}

Respond with APPROVE (optionally with constraints/corrections) or CORRECT (a replacement/corrected architecture). One response; there will be no back-and-forth.

${STRUCTURED}`;
}

/** Engineer implementation prompt (EXECUTION / REMEDIATION). */
export function engineerPrompt(input: {
  workPackageId: string;
  architecture: string;
  task: string;
  acceptanceCriteria: string[];
  constraints: string[];
  repairFindings?: ReviewerPacket;      // present on repair rounds
  remediationChanges?: ArchitectFinalResult; // present on remediation
  priorDecisions?: string;
}): string {
  const parts: string[] = [
    `You are the Engineer in an AI Factory run. Implement ONE coherent work package deterministically and thoroughly.`,
    ``,
    `Work package: ${input.workPackageId}`,
    `Original goal: ${input.task}`,
    `Approved architecture: ${input.architecture}`,
    `Acceptance criteria:`,
    list(input.acceptanceCriteria),
    `Constraints:`,
    list(input.constraints),
  ];
  if (input.priorDecisions) parts.push(`Prior important decisions:\n${input.priorDecisions}`);
  if (input.repairFindings) {
    parts.push(
      `A Reviewer found issues with the previous attempt. Address ONLY these concrete findings; do not rework unrelated code:`,
      `Blocking findings:`,
      list(input.repairFindings.blockingFindings),
      `Required repairs:`,
      list(input.repairFindings.requiredRepairs),
      `Test concerns:`,
      list(input.repairFindings.testConcerns),
    );
  }
  if (input.remediationChanges) {
    parts.push(
      `The final Architect requires remediation. Apply these required changes (and do not change the listed do-not-change areas):`,
      `Required changes:`,
      list(input.remediationChanges.requiredChanges),
      `Blocking issues:`,
      list(input.remediationChanges.blockingIssues),
      `Do NOT change:`,
      list(input.remediationChanges.doNotChange),
      `Required evidence:`,
      list(input.remediationChanges.requiredEvidence),
    );
  }
  parts.push(
    ``,
    `Implement the work package, run the fundamental tests, and report a compact completion packet: status, workPackageId, summary, changedFiles, importantDecisions, testsRun, testResults, deviations, knownLimitations, unresolvedQuestions, and architecturalEscalationRequired (true only if the architecture itself is wrong).`,
    ``,
    STRUCTURED,
  );
  return parts.join("\n");
}

/** Reviewer prompt (REVIEW). */
export function reviewerPrompt(input: {
  workPackageId: string;
  engineer: EngineerPacket;
  task: string;
}): string {
  return `You are the Reviewer — an independent implementation-correctness role in an AI Factory run. Answer one question: "Was this implementation done correctly?" You are NOT the Architect; you assess correctness, regressions, edge cases, required tests, unnecessary complexity, contract compliance, and implementation quality — not whether the overall architecture is right.

Task: ${input.task}
Work package: ${input.workPackageId}

Engineer's completion packet:
- Status: ${input.engineer.status}
- Summary: ${input.engineer.summary}
- Changed files:
${list(input.engineer.changedFiles)}
- Important decisions:
${list(input.engineer.importantDecisions)}
- Tests run:
${list(input.engineer.testsRun)}
- Test results: ${input.engineer.testResults || "(none reported)"}
- Deviations:
${list(input.engineer.deviations)}
- Known limitations:
${list(input.engineer.knownLimitations)}
- Unresolved questions:
${list(input.engineer.unresolvedQuestions)}
- Architectural escalation required: ${input.engineer.architecturalEscalationRequired}

Inspect the actual changed files when useful. Respond with verdict PASS, NEEDS_FIX (with blocking findings and concrete required repairs), or ARCHITECTURAL_ESCALATION (only when the issue is truly architectural, not a coding problem). Set architecturalIssue only for genuine architectural problems.

${STRUCTURED}`;
}

/** Lead integration + system verification (INTEGRATION). */
export function leadIntegrationPrompt(input: {
  task: string;
  architecture: string;
  engineers: EngineerPacket[];
  reviewers: ReviewerPacket[];
}): string {
  return `You are the Technical Lead of an AI Factory run. The implementation work is complete. Integrate and verify the whole system, then produce a compact acceptance packet.

Original goal: ${input.task}
Approved architecture: ${input.architecture}

Completed work packages:
${input.engineers.map((e) => `- [${e.workPackageId}] ${e.summary}`).join("\n") || "(none)"}

Reviewer findings — EVERY finding listed below must appear in exactly one of
reviewerFindingsResolved, reviewerFindingsAcceptedRisk or reviewerFindingsUnresolved.
Do not write "None" while a finding is listed, and do not summarize a finding away:
${reviewerFindingsBlock(input.reviewers)}

Verify the integrated system (run the relevant tests/checks), then report the acceptance packet: goal, approved architecture, completed work packages, important implementation decisions, deviations from plan, system-level verification, reviewer findings (resolved / accepted risk / unresolved — one explicit disposition per finding listed above), relevant selected files/diffs, and your factual assessment.

${STRUCTURED}`;
}

/** Render every Reviewer finding, by category, so none is invisible to the Lead. */
function reviewerFindingsBlock(reviewers: ReviewerPacket[]): string {
  if (reviewers.length === 0) return "(none)";
  return reviewers.map((r, i) => {
    const lines: string[] = [`Reviewer ${i + 1} (verdict ${r.verdict}):`];
    const section = (label: string, items: string[]): void => {
      if (items.length > 0) lines.push(`  ${label}:`, ...items.map((t) => `    - ${t}`));
    };
    section("blocking", r.blockingFindings);
    section("non-blocking", r.nonBlockingFindings);
    section("required repairs", r.requiredRepairs);
    section("test concerns", r.testConcerns);
    if (lines.length === 1) lines.push("  (no findings)");
    return lines.join("\n");
  }).join("\n");
}

/** Final Architect acceptance checkpoint (FINAL_ARCHITECT / FINAL_ARCHITECT_RECHECK). */
export function finalArchitectPrompt(input: {
  task: string;
  integration: LeadIntegrationPacket;
  /** Present on the recheck: what the remediation cycle actually changed, so
   * the re-assessment is of the fixed system, not the pre-fix packet. */
  remediation?: { engineer: EngineerPacket; reviewer: ReviewerPacket };
}): string {
  const head = input.remediation
    ? "This is the recheck after the remediation cycle you required. Re-assess against your required changes."
    : "This is the final architecture/acceptance checkpoint.";
  const remediationBlock = input.remediation
    ? `

Remediation cycle (what changed since your rejection):
- Engineer status: ${input.remediation.engineer.status}
- Engineer summary: ${input.remediation.engineer.summary}
- Changed files:
${list(input.remediation.engineer.changedFiles)}
- Tests run:
${list(input.remediation.engineer.testsRun)}
- Test results: ${input.remediation.engineer.testResults || "(none reported)"}
- Reviewer verdict on the remediation: ${input.remediation.reviewer.verdict}
- Reviewer blocking findings on the remediation:
${list(input.remediation.reviewer.blockingFindings)}
- Reviewer non-blocking findings on the remediation:
${list(input.remediation.reviewer.nonBlockingFindings)}`
    : "";
  return `You are the Architect — a premium, temporary consultant. ${head} You are deciding whether this completed system is the RIGHT architectural/system solution and should be accepted.

Original goal: ${input.task}

Lead's acceptance packet:
- Approved architecture: ${input.integration.approvedArchitecture}
- Completed work packages:
${list(input.integration.completedWorkPackages)}
- System verification: ${input.integration.systemVerification}
- Important decisions:
${list(input.integration.importantDecisions)}
- Deviations:
${list(input.integration.deviations)}
- Reviewer findings — RESOLVED:
${list(input.integration.reviewerFindingsResolved)}
- Reviewer findings — ACCEPTED RISK:
${list(input.integration.reviewerFindingsAcceptedRisk)}
- Reviewer findings — UNRESOLVED:
${list(input.integration.reviewerFindingsUnresolved)}
- Selected files:
${list(input.integration.selectedFiles)}
- Factual assessment: ${input.integration.factualAssessment}${remediationBlock}

Respond with ACCEPT, or NEEDS_REMEDIATION (with blocking issues, required changes, do-not-change areas, and required evidence). You should not receive every child transcript — assess from this packet.

${STRUCTURED}`;
}

/** Mid-run Architect escalation (ARCHITECT_ESCALATION). */
export function architectEscalationPrompt(input: {
  task: string;
  architecture: string;
  reason: string;
  engineering?: EngineerPacket;
  review?: ReviewerPacket;
}): string {
  return `You are the Architect — a premium, temporary consultant. An exceptional structural problem arose during execution and has been escalated to you.

Original goal: ${input.task}
Current approved architecture: ${input.architecture}

Escalation reason: ${input.reason}
${input.engineering ? `- Engineer packet: status=${input.engineering.status}, escalation=${input.engineering.architecturalEscalationRequired}\n${input.engineering.summary}` : ""}
${input.review ? `- Reviewer: verdict=${input.review.verdict}, architecturalIssue=${input.review.architecturalIssue}\n${input.review.blockingFindings.join("\n") || "(none)"}` : ""}

Determine whether the architecture must change. Respond with APPROVE (architecture stands, with constraints) or CORRECT (a replacement/corrected architecture). One response; there will be no back-and-forth.

${STRUCTURED}`;
}

/** Lead disposition after the bounded repair loop is exhausted. */
export function leadEscalationPrompt(input: {
  task: string;
  reviewer: ReviewerPacket;
  repairRound: number;
  maxRepairRounds: number;
}): string {
  return `You are the Technical Lead of an AI Factory run. The Engineer/Reviewer repair loop reached its configured limit (${input.repairRound} of ${input.maxRepairRounds} round(s)) and the Reviewer still is not satisfied.

Original goal: ${input.task}

Reviewer verdict: ${input.reviewer.verdict}
Blocking findings:
${list(input.reviewer.blockingFindings)}
Required repairs:
${list(input.reviewer.requiredRepairs)}
Architectural issue? ${input.reviewer.architecturalIssue}

Decide how to proceed. Respond with verdict "continue" (the work should proceed — with your guidance) or "stop" (the run should stop). This is a technical decision, not a relay.

${STRUCTURED}`;
}

/** Short, deterministic description shown in the subagent widget/fleet. */
export function roleDescription(runId: string, role: string, phase: string): string {
  return `[factory ${runId.slice(0, 8)}] ${role} — ${phase}`;
}
