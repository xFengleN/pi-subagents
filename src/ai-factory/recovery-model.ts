/** Pure persisted-state validation, checkpoint identity, and recovery planning. */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createRequirementCatalog, TARGET_ID, validateArchitectTargetApproval, validateTargets } from "./targets.js";
import {
  type ArchitectPlanAssessment,
  type AttemptProvenance,
  FACTORY_STATE_VERSION,
  FACTORY_STATES,
  type FactoryAttempt,
  type FactoryCheckpoint,
  type FactoryConfig,
  type FactoryRunState,
  type FactoryState,
  type FactoryTarget,
  LEGACY_FACTORY_STATE_VERSION,
  type LeadProposalPacket,
  RECOVERY_FACTORY_STATE_VERSION,
  ROLE_NAMES,
  type RoleName,
  TERMINAL_STATES,
} from "./types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PHASE_ROLES: Record<string, RoleName> = {
  "discovery.lead": "lead",
  "initial.architect": "architect",
  "execution.engineer": "engineer",
  "review.reviewer": "reviewer",
  "escalation.architect": "architect",
  "integration.lead": "lead",
  "final.architect": "architect",
  "remediation.engineer": "engineer",
  "remediation.reviewer": "reviewer",
  "final_recheck.architect": "architect",
  "final_synthesis.lead": "lead",
  "escalation.lead": "lead",
};

const PHASE_PACKET_KEYS: Record<string, { required: string[]; optional: string[]; kinds: string[] }> = {
  "discovery.lead": {
    required: ["goal", "repositoryFindings", "currentArchitecture", "assumptions", "proposedSolution", "constraints", "workPackages", "dependencies", "risks", "acceptanceCriteria", "architecturalQuestions"],
    optional: ["targets", "humanRequirements", "requirementCatalog", "humanDependencies"],
    kinds: ["proposal"],
  },
  "initial.architect": {
    required: ["verdict", "approvedArchitecture", "constraints", "correctedWorkPackages", "importantRisks"],
    optional: ["approvedTargets", "planAssessment", "clarificationQuestions"],
    kinds: ["architect_initial"],
  },
  "execution.engineer": {
    required: ["status", "workPackageId", "summary", "changedFiles", "importantDecisions", "testsRun", "testResults", "deviations", "knownLimitations", "unresolvedQuestions", "architecturalEscalationRequired"],
    optional: [],
    kinds: ["engineer"],
  },
  "review.reviewer": {
    required: ["verdict", "blockingFindings", "nonBlockingFindings", "requiredRepairs", "testConcerns", "architecturalIssue"],
    optional: [],
    kinds: ["reviewer"],
  },
  "integration.lead": {
    required: ["goal", "approvedArchitecture", "completedWorkPackages", "importantDecisions", "deviations", "systemVerification", "reviewerFindingsResolved", "reviewerFindingsAcceptedRisk", "reviewerFindingsUnresolved", "selectedFiles", "factualAssessment"],
    optional: [],
    kinds: ["integration"],
  },
  "final.architect": {
    required: ["verdict", "blockingIssues", "requiredChanges", "doNotChange", "requiredEvidence"],
    optional: ["affectedTargetIds", "integrationOnly"],
    kinds: ["architect_final"],
  },
  "final_recheck.architect": {
    required: ["verdict", "blockingIssues", "requiredChanges", "doNotChange", "requiredEvidence"],
    optional: ["affectedTargetIds", "integrationOnly"],
    kinds: ["architect_final"],
  },
  "final_synthesis.lead": {
    required: ["result", "summary", "delivered", "architecture", "reviewerFindings", "validation", "commits", "endingHead", "pushed", "humanVerification", "warnings"],
    optional: [],
    kinds: ["final_report"],
  },
  "remediation.engineer": {
    required: ["status", "workPackageId", "summary", "changedFiles", "importantDecisions", "testsRun", "testResults", "deviations", "knownLimitations", "unresolvedQuestions", "architecturalEscalationRequired"],
    optional: [],
    kinds: ["engineer"],
  },
  "remediation.reviewer": {
    required: ["verdict", "blockingFindings", "nonBlockingFindings", "requiredRepairs", "testConcerns", "architecturalIssue"],
    optional: [],
    kinds: ["reviewer"],
  },
  "escalation.architect": {
    required: ["verdict", "approvedArchitecture", "constraints", "correctedWorkPackages", "importantRisks"],
    optional: ["approvedTargets", "planAssessment", "clarificationQuestions"],
    kinds: ["architect_initial"],
  },
  "escalation.lead": {
    required: ["verdict", "guidance"],
    optional: [],
    kinds: ["lead_escalation"],
  },
};

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function validateDependencyArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value)) { issues.push(`${path} must be an array`); return; }
  for (const [index, item] of value.entries()) {
    if (!record(item)) { issues.push(`${path}[${index}] must be an object`); continue; }
    exactKeys(item, ["targetId", "dependsOn"], [], `${path}[${index}]`, issues);
    if (typeof item.targetId !== "string" || typeof item.dependsOn !== "string") issues.push(`${path}[${index}] has invalid dependency fields`);
  }
}

function validatePlanAssessment(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  exactKeys(value, ["verdict", "missionRequirements", "missionDependencies", "requirementCoverage", "uncoveredRequirements"], ["preservedConstraintIds"], path, issues);
  if (!(value.verdict === "complete" || value.verdict === "incomplete")) issues.push(`${path}.verdict is invalid`);
  if (!strings(value.missionRequirements)) issues.push(`${path}.missionRequirements must be an array of strings`);
  validateDependencyArray(value.missionDependencies, `${path}.missionDependencies`, issues);
  if (!strings(value.uncoveredRequirements)) issues.push(`${path}.uncoveredRequirements must be an array of strings`);
  if (value.preservedConstraintIds !== undefined && !strings(value.preservedConstraintIds)) issues.push(`${path}.preservedConstraintIds must be an array of strings`);
  if (!Array.isArray(value.requirementCoverage)) { issues.push(`${path}.requirementCoverage must be an array`); return; }
  for (const [index, item] of value.requirementCoverage.entries()) {
    if (!record(item)) { issues.push(`${path}.requirementCoverage[${index}] must be an object`); continue; }
    if ("requirementId" in item) {
      exactKeys(item, ["requirementId", "targetIds"], [], `${path}.requirementCoverage[${index}]`, issues);
      if (typeof item.requirementId !== "string" || !strings(item.targetIds)) issues.push(`${path}.requirementCoverage[${index}] has invalid fields`);
    } else {
      exactKeys(item, ["requirement", "targetIds"], [], `${path}.requirementCoverage[${index}]`, issues);
      if (typeof item.requirement !== "string" || !strings(item.targetIds)) issues.push(`${path}.requirementCoverage[${index}] has invalid legacy fields`);
    }
  }
}

function validateRequirementCatalog(value: unknown, proposal: Record<string, unknown>, path: string, issues: string[]): void {
  if (!Array.isArray(value)) { issues.push(`${path} must be an array`); return; }
  for (const [index, item] of value.entries()) {
    if (!record(item)) { issues.push(`${path}[${index}] must be an object`); continue; }
    exactKeys(item, ["id", "text", "source"], [], `${path}[${index}]`, issues);
    if (typeof item.id !== "string" || typeof item.text !== "string"
      || (item.source !== "human_requirement" && item.source !== "human_constraint")) issues.push(`${path}[${index}] has invalid fields`);
  }
  if (!strings(proposal.humanRequirements ?? []) || !strings(proposal.constraints ?? [])) return;
  const humanRequirements = strings(proposal.humanRequirements) ? proposal.humanRequirements : [];
  const constraints = strings(proposal.constraints) ? proposal.constraints : [];
  const expected = createRequirementCatalog(humanRequirements, constraints);
  if (JSON.stringify(value) !== JSON.stringify(expected)) issues.push(`${path} does not match the deterministic Lead requirement inventory`);
}

function validateTargetArray(value: unknown, path: string, issues: string[]): value is FactoryTarget[] {
  const before = issues.length;
  if (!Array.isArray(value)) { issues.push(`${path} must be an array`); return false; }
  for (const [index, target] of value.entries()) {
    if (!record(target)) { issues.push(`${path}[${index}] must be an object`); continue; }
    exactKeys(target, ["id", "description", "dependsOn", "acceptanceCriteria"], ["requiresArchitectAcceptance"], `${path}[${index}]`, issues);
    if (typeof target.id !== "string" || typeof target.description !== "string" || !strings(target.dependsOn)
      || !strings(target.acceptanceCriteria) || (target.requiresArchitectAcceptance !== undefined && typeof target.requiresArchitectAcceptance !== "boolean")) issues.push(`${path}[${index}] has invalid target fields`);
  }
  return issues.length === before;
}

function validateTargetPlan(value: unknown, state: Record<string, unknown>, issues: string[]): void {
  if (!record(value)) { issues.push("targetPlan must be an object"); return; }
  exactKeys(value, ["targets", "outcomes", "revision", "rationale"], ["currentTargetId", "awaitingArchitectAcceptance", "revalidationIds"], "targetPlan", issues);
  const before = issues.length;
  validateTargetArray(value.targets, "targetPlan.targets", issues);
  if (before === issues.length) issues.push(...validateTargets(value.targets as FactoryTarget[]));
  if (!integer(value.revision) || value.revision === 0 || !strings(value.rationale)) issues.push("targetPlan revision/rationale is invalid");
  if (value.awaitingArchitectAcceptance !== undefined && typeof value.awaitingArchitectAcceptance !== "boolean") issues.push("targetPlan.awaitingArchitectAcceptance must be boolean");
  if (value.revalidationIds !== undefined && (!strings(value.revalidationIds) || !Array.isArray(value.targets)
    || value.revalidationIds.some((id: string) => !Array.isArray(value.targets) || !value.targets.filter(record).some((target) => target.id === id)))) issues.push("targetPlan.revalidationIds is invalid");
  if (!record(value.outcomes) || !Array.isArray(value.targets)) { issues.push("targetPlan.outcomes must be an object"); return; }
  const outcomes = value.outcomes;
  const ids = new Set(value.targets.filter(record).map((target) => target.id));
  for (const id of Object.keys(value.outcomes)) if (!ids.has(id)) issues.push(`targetPlan.outcomes.${id} has no target`);
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const outcome = value.outcomes[id];
    if (!record(outcome)) { issues.push(`targetPlan.outcomes.${id} is missing`); continue; }
    exactKeys(outcome, ["status"], ["reason", "blockedBy", "engineerAgentId", "reviewerAgentId", "architectAgentId"], `targetPlan.outcomes.${id}`, issues);
    if (!["pending", "active", "passed", "failed", "blocked"].includes(String(outcome.status))) issues.push(`targetPlan.outcomes.${id}.status is invalid`);
    if (outcome.blockedBy !== undefined && (!strings(outcome.blockedBy) || outcome.blockedBy.some((dep) => !ids.has(dep)))) issues.push(`targetPlan.outcomes.${id}.blockedBy is invalid`);
    for (const key of ["reason", "engineerAgentId", "reviewerAgentId", "architectAgentId"]) if (outcome[key] !== undefined && typeof outcome[key] !== "string") issues.push(`targetPlan.outcomes.${id}.${key} must be a string`);
    if (outcome.status === "passed") {
      const reviewed = record(state.results) && Array.isArray(state.results.reviewers)
        && state.results.reviewers.some((item: unknown) => record(item) && item.targetId === id && record(item.outcome)
          && item.outcome.agentId === outcome.reviewerAgentId && record(item.outcome.packet) && item.outcome.packet.verdict === "PASS");
      const remediation = record(state.results) && record(state.results.remediation) && record(state.results.remediation.reviewer)
        && state.results.remediation.reviewer.agentId === outcome.reviewerAgentId
        && record(state.results.remediation.reviewer.packet) && state.results.remediation.reviewer.packet.verdict === "PASS"
        && record(state.results.remediation.engineer) && record(state.results.remediation.engineer.packet)
        && state.results.remediation.engineer.packet.workPackageId === id;
      if (typeof outcome.reviewerAgentId !== "string" || (!reviewed && !remediation)) issues.push(`targetPlan.outcomes.${id} passed without matching Reviewer PASS evidence`);
      const engineered = record(state.results) && Array.isArray(state.results.engineers)
        && state.results.engineers.some((item: unknown) => record(item) && item.targetId === id && record(item.outcome)
          && item.outcome.agentId === outcome.engineerAgentId && record(item.outcome.packet)
          && item.outcome.packet.workPackageId === id && item.outcome.packet.status === "completed");
      const remediated = record(state.results) && record(state.results.remediation) && record(state.results.remediation.engineer)
        && state.results.remediation.engineer.agentId === outcome.engineerAgentId
        && record(state.results.remediation.engineer.packet) && state.results.remediation.engineer.packet.workPackageId === id
        && state.results.remediation.engineer.packet.status === "completed";
      if (typeof outcome.engineerAgentId !== "string" || (!engineered && !remediated)) issues.push(`targetPlan.outcomes.${id} passed without matching completed Engineer evidence`);
      const target = value.targets.find((item: unknown) => record(item) && item.id === id) as FactoryTarget | undefined;
      if (target?.dependsOn.some((dep) => {
        const dependency = outcomes[dep];
        return !record(dependency) || (dependency.status !== "passed"
          && !(strings(value.revalidationIds) && value.revalidationIds.includes(id) && value.revalidationIds.includes(dep)));
      })) issues.push(`targetPlan.outcomes.${id} passed while a dependency is not accepted`);
      if (target?.requiresArchitectAcceptance && typeof outcome.architectAgentId !== "string" && !(value.awaitingArchitectAcceptance === true && value.currentTargetId === id)) issues.push(`targetPlan.outcomes.${id} requires target Architect acceptance`);
    }
  }
  const activeIds = Object.entries(value.outcomes).filter(([, outcome]) => record(outcome) && outcome.status === "active").map(([id]) => id);
  if (activeIds.length > 1 || (activeIds.length === 1 && activeIds[0] !== value.currentTargetId)) issues.push("targetPlan active outcome must match currentTargetId");
  if (value.currentTargetId !== undefined) {
    const active = typeof value.currentTargetId === "string" ? value.outcomes[value.currentTargetId] : undefined;
    if (typeof value.currentTargetId !== "string" || !ids.has(value.currentTargetId)
      || !record(active) || !["active", "passed"].includes(String(active.status))) issues.push("targetPlan.currentTargetId must identify the active target");
    if (record(active) && active.status === "passed" && value.awaitingArchitectAcceptance !== true) issues.push("passed current target must be awaiting Architect acceptance");
  }
  if (["INTEGRATION", "FINAL_ARCHITECT", "FINAL_ARCHITECT_RECHECK", "FINAL_SYNTHESIS", "DONE"].includes(String(state.state))
    && (Object.values(value.outcomes).some((outcome) => !record(outcome) || outcome.status !== "passed") || value.revalidationIds !== undefined)) issues.push(`${state.state} requires every target to be Reviewer-approved`);
}


function validateTargetApprovalConsistency(state: Record<string, unknown>, issues: string[]): void {
  if (state.version !== FACTORY_STATE_VERSION || !record(state.targetPlan)) return;
  if (!record(state.results)) { issues.push("targetPlan requires persisted proposal and Architect evidence"); return; }
  const proposalOutcome = state.results.proposal;
  const architectOutcome = state.results.initialArchitect;
  if (!record(proposalOutcome) || !record(proposalOutcome.packet) || !record(architectOutcome) || !record(architectOutcome.packet)) {
    issues.push("targetPlan requires persisted proposal and initial Architect evidence");
    return;
  }
  const proposal = proposalOutcome.packet;
  const architect = architectOutcome.packet;
  const packetIssues: string[] = [];
  validatePacket(proposal, "discovery.lead", "results.proposal.packet", packetIssues);
  validatePacket(architect, "initial.architect", "results.initialArchitect.packet", packetIssues);
  if (packetIssues.length > 0) return;
  if (!strings(proposal.constraints) || !strings(proposal.workPackages) || !strings(proposal.acceptanceCriteria)) return;
  if (architect.verdict === "CLARIFY") issues.push("targetPlan cannot exist after Architect requested clarification");
  const proposalTargets = Array.isArray(proposal.targets) ? proposal.targets : undefined;
  const approvedTargets = Array.isArray(architect.approvedTargets) ? architect.approvedTargets : undefined;
  const proposedCount = Math.max(proposalTargets?.length ?? 0, proposal.workPackages.length);
  const requiresExplicitPlan = proposedCount > 1 || (approvedTargets?.length ?? 0) > 1;
  if (requiresExplicitPlan && approvedTargets === undefined) issues.push("multi-target state has no explicit Architect-approved target plan");
  if (requiresExplicitPlan && !record(architect.planAssessment)) issues.push("multi-target state has no persisted Architect coverage assessment");

  const assessment = architect.planAssessment;
  if (assessment !== undefined && record(assessment) && Array.isArray(assessment.missionRequirements)
    && Array.isArray(assessment.missionDependencies) && Array.isArray(assessment.requirementCoverage)
    && Array.isArray(assessment.uncoveredRequirements)) {
    const validProposalTargets = proposalTargets === undefined || validateTargetArray(proposalTargets, "results.proposal.packet.targets", []);
    const validApprovedTargets = approvedTargets && validateTargetArray(approvedTargets, "results.initialArchitect.packet.approvedTargets", []);
    if (validProposalTargets && validApprovedTargets) {
      issues.push(...validateArchitectTargetApproval(
        proposal as unknown as LeadProposalPacket,
        approvedTargets as FactoryTarget[],
        assessment as unknown as ArchitectPlanAssessment,
        strings(architect.constraints) ? architect.constraints : [],
      ));
    }
  }

  let expected: FactoryTarget[] | undefined;
  if (approvedTargets && validateTargetArray(approvedTargets, "results.initialArchitect.packet.approvedTargets", [])) {
    expected = approvedTargets as FactoryTarget[];
  } else if (proposalTargets && validateTargetArray(proposalTargets, "results.proposal.packet.targets", [])) {
    expected = proposalTargets as FactoryTarget[];
  } else if (proposal.workPackages.length === 1) {
    const id = TARGET_ID.test(proposal.workPackages[0]) ? proposal.workPackages[0] : "WP0";
    expected = [{ id, description: proposal.workPackages[0], dependsOn: [], acceptanceCriteria: proposal.acceptanceCriteria }];
  }
  if (expected && integer(state.targetPlan.revision) && state.targetPlan.revision === 1
    && JSON.stringify(state.targetPlan.targets) !== JSON.stringify(expected)) {
    issues.push("persisted targetPlan does not match the initial Architect-approved plan");
  }
  if (integer(state.targetPlan.revision) && state.targetPlan.revision > 1 && record(state.results.escalationArchitect)
    && record(state.results.escalationArchitect.packet) && Array.isArray(state.results.escalationArchitect.packet.approvedTargets)
    && JSON.stringify(state.targetPlan.targets) !== JSON.stringify(state.results.escalationArchitect.packet.approvedTargets)) {
    issues.push("persisted targetPlan does not match the latest Architect-approved revision");
  }
}

export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId);
}

export function validateRunId(runId: unknown): string[] {
  return isValidRunId(runId)
    ? []
    : ["runId must match [A-Za-z0-9][A-Za-z0-9_-]{0,127} and contain no path separators"];
}

export function assertValidRunId(runId: unknown): asserts runId is string {
  const issues = validateRunId(runId);
  if (issues.length > 0) throw new FactoryStateValidationError(issues);
}

/** Resolve both sides before comparing, so a symlink cannot escape the project boundary. */
export function canonicalWorkspacePath(workspace: string, intendedProjectDir: string): string[] {
  if (!isAbsolute(workspace) || !isAbsolute(intendedProjectDir)) return ["workspace and intended project directory must be absolute paths"];
  try {
    const actual = realpathSync(resolve(workspace));
    const intended = realpathSync(resolve(intendedProjectDir));
    return actual === intended ? [] : [`workspace path ${workspace} is not the intended project directory ${intendedProjectDir}`];
  } catch {
    return ["workspace and intended project directory must exist and be canonicalizable"];
  }
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], path: string, issues: string[]): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) issues.push(`${path}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
}

function validateConfig(value: unknown, issues: string[]): value is FactoryConfig {
  if (!record(value)) {
    issues.push("config must be an object");
    return false;
  }
  exactKeys(value, ["agentTypes", "isolated", "roles", "maxRepairRounds", "maxArchitectRemediationRounds", "maxArchitectEscalations", "maxLeadEscalations", "defaultRetryAfterMs"], [], "config", issues);
  if (!record(value.agentTypes)) issues.push("config.agentTypes must be an object");
  else {
    exactKeys(value.agentTypes, [...ROLE_NAMES], [], "config.agentTypes", issues);
    for (const role of ROLE_NAMES) if (typeof value.agentTypes[role] !== "string" || value.agentTypes[role] === "") issues.push(`config.agentTypes.${role} must be a non-empty string`);
  }
  if (typeof value.isolated !== "boolean") issues.push("config.isolated must be a boolean");
  if (!record(value.roles)) issues.push("config.roles must be an object");
  else {
    exactKeys(value.roles, [...ROLE_NAMES], [], "config.roles", issues);
    for (const role of ROLE_NAMES) {
      const roleValue = value.roles[role];
      if (!record(roleValue)) {
        issues.push(`config.roles.${role} must be an object`);
        continue;
      }
      exactKeys(roleValue, ["targets", "maxTransientRetries", "retryDelayMs", "policy"], ["maxTurns"], `config.roles.${role}`, issues);
      if (!record(roleValue.targets)) issues.push(`config.roles.${role}.targets must be an object`);
      else {
        exactKeys(roleValue.targets, ["primary"], ["fallbacks"], `config.roles.${role}.targets`, issues);
        if (typeof roleValue.targets.primary !== "string" || roleValue.targets.primary === "") issues.push(`config.roles.${role}.targets.primary must be non-empty`);
        if (roleValue.targets.fallbacks !== undefined && (!strings(roleValue.targets.fallbacks) || roleValue.targets.fallbacks.some((target) => target === ""))) issues.push(`config.roles.${role}.targets.fallbacks must contain non-empty strings`);
      }
      if (!integer(roleValue.maxTransientRetries)) issues.push(`config.roles.${role}.maxTransientRetries must be a non-negative integer`);
      if (!integer(roleValue.retryDelayMs)) issues.push(`config.roles.${role}.retryDelayMs must be a non-negative integer`);
      if (roleValue.maxTurns !== undefined && (!integer(roleValue.maxTurns) || roleValue.maxTurns === 0)) issues.push(`config.roles.${role}.maxTurns must be a positive integer when present`);
      if (!(["conservative", "permissive", "quality_floor", "equivalent"] as unknown[]).includes(roleValue.policy)) issues.push(`config.roles.${role}.policy is invalid`);
    }
  }
  for (const key of ["maxRepairRounds", "maxArchitectRemediationRounds", "maxArchitectEscalations", "maxLeadEscalations", "defaultRetryAfterMs"]) {
    if (!integer(value[key])) issues.push(`config.${key} must be a non-negative integer`);
  }
  return issues.length === 0;
}

function validatePacket(value: unknown, phase: string, path: string, issues: string[]): void {
  if (!record(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const spec = PHASE_PACKET_KEYS[phase];
  if (!spec) {
    issues.push(`${path} has unknown phase ${phase}`);
    return;
  }
  exactKeys(value, spec.required, spec.optional, path, issues);
  for (const key of ["targets", "approvedTargets"]) if (value[key] !== undefined) validateTargetArray(value[key], `${path}.${key}`, issues);
  if (value.humanRequirements !== undefined && !strings(value.humanRequirements)) issues.push(`${path}.humanRequirements must be an array of strings`);
  if (value.requirementCatalog !== undefined) validateRequirementCatalog(value.requirementCatalog, value, `${path}.requirementCatalog`, issues);
  if (value.humanDependencies !== undefined) validateDependencyArray(value.humanDependencies, `${path}.humanDependencies`, issues);
  if (value.planAssessment !== undefined) validatePlanAssessment(value.planAssessment, `${path}.planAssessment`, issues);
  if (value.clarificationQuestions !== undefined && !strings(value.clarificationQuestions)) issues.push(`${path}.clarificationQuestions must be an array of strings`);
  if (value.affectedTargetIds !== undefined && !strings(value.affectedTargetIds)) issues.push(`${path}.affectedTargetIds must be an array of strings`);
  if (value.integrationOnly !== undefined && typeof value.integrationOnly !== "boolean") issues.push(`${path}.integrationOnly must be boolean`);
  for (const key of spec.required) {
    const field = value[key];
    if (key === "verdict" || key === "status" || key === "goal" || key === "approvedArchitecture" || key === "proposedSolution" || key === "repositoryFindings" || key === "currentArchitecture" || key === "dependencies" || key === "summary" || key === "workPackageId" || key === "testResults" || key === "systemVerification" || key === "factualAssessment" || key === "result" || key === "endingHead" || key === "pushed" || key === "guidance") {
      if (typeof field !== "string") issues.push(`${path}.${key} must be a string`);
    } else if (key === "architecturalEscalationRequired" || key === "architecturalIssue") {
      if (typeof field !== "boolean") issues.push(`${path}.${key} must be a boolean`);
    } else if (!strings(field)) {
      issues.push(`${path}.${key} must be an array of strings`);
    }
  }
  const enumValues: Record<string, string[]> = {
    verdict: phase.includes("review") ? ["PASS", "NEEDS_FIX", "ARCHITECTURAL_ESCALATION"] : phase.includes("architect") ? (phase.includes("final") ? ["ACCEPT", "NEEDS_REMEDIATION"] : ["APPROVE", "CORRECT", "CLARIFY"]) : ["continue", "stop"],
    status: ["completed", "partially_completed", "failed"],
  };
  for (const [key, allowed] of Object.entries(enumValues)) if (key in value && !allowed.includes(String(value[key]))) issues.push(`${path}.${key} has an invalid value`);
}

function validateOutcome(value: unknown, phase: string, path: string, issues: string[]): void {
  if (!record(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  exactKeys(value, ["packet", "agentId"], ["target"], path, issues);
  if (typeof value.agentId !== "string" || value.agentId === "") issues.push(`${path}.agentId must be a non-empty string`);
  if (value.target !== undefined && typeof value.target !== "string") issues.push(`${path}.target must be a string`);
  validatePacket(value.packet, phase, `${path}.packet`, issues);
}

function validateResults(value: unknown, issues: string[]): void {
  if (!record(value)) {
    issues.push("results must be an object");
    return;
  }
  exactKeys(value, ["engineers", "reviewers"], ["proposal", "initialArchitect", "integration", "finalArchitect", "finalRecheck", "finalReport", "escalationArchitect", "leadEscalation", "remediation"], "results", issues);
  if (!Array.isArray(value.engineers)) issues.push("results.engineers must be an array");
  else for (const [index, item] of value.engineers.entries()) {
    if (!record(item) || !integer(item.round)) issues.push(`results.engineers[${index}] has an invalid round`);
    else {
      if (item.targetId !== undefined && typeof item.targetId !== "string") issues.push(`results.engineers[${index}].targetId must be a string`);
      validateOutcome(item.outcome, "execution.engineer", `results.engineers[${index}].outcome`, issues);
    }
  }
  if (!Array.isArray(value.reviewers)) issues.push("results.reviewers must be an array");
  else for (const [index, item] of value.reviewers.entries()) {
    if (!record(item) || !integer(item.round)) issues.push(`results.reviewers[${index}] has an invalid round`);
    else {
      if (item.targetId !== undefined && typeof item.targetId !== "string") issues.push(`results.reviewers[${index}].targetId must be a string`);
      validateOutcome(item.outcome, "review.reviewer", `results.reviewers[${index}].outcome`, issues);
    }
  }
  const single: Array<[string, string]> = [["proposal", "discovery.lead"], ["initialArchitect", "initial.architect"], ["integration", "integration.lead"], ["finalArchitect", "final.architect"], ["finalRecheck", "final_recheck.architect"], ["finalReport", "final_synthesis.lead"], ["escalationArchitect", "escalation.architect"], ["leadEscalation", "escalation.lead"]];
  for (const [key, phase] of single) if (value[key] !== undefined) validateOutcome(value[key], phase, `results.${key}`, issues);
  if (value.remediation !== undefined) {
    if (!record(value.remediation)) issues.push("results.remediation must be an object");
    else {
      exactKeys(value.remediation, [], ["engineer", "reviewer"], "results.remediation", issues);
      if (value.remediation.engineer !== undefined) validateOutcome(value.remediation.engineer, "remediation.engineer", "results.remediation.engineer", issues);
      if (value.remediation.reviewer !== undefined) validateOutcome(value.remediation.reviewer, "remediation.reviewer", "results.remediation.reviewer", issues);
    }
  }
}

function validateAttempt(value: unknown, index: number, issues: string[]): void {
  const path = `attempts[${index}]`;
  if (!record(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  exactKeys(value, ["attemptId", "role", "phase", "round", "target", "provenance", "recoveryRisk", "preparedAt"], ["spawnRequestedAt", "spawnedAt", "settledAt", "agentId", "packetKind", "packetValidated", "configRevision", "targetId"], path, issues);
  if (typeof value.attemptId !== "string" || value.attemptId === "") issues.push(`${path}.attemptId must be non-empty`);
  if (!ROLE_NAMES.includes(value.role as RoleName)) issues.push(`${path}.role is invalid`);
  if (typeof value.phase !== "string" || PHASE_ROLES[value.phase] === undefined) issues.push(`${path}.phase is invalid`);
  else if (PHASE_ROLES[value.phase] !== value.role) issues.push(`${path}.role does not match phase`);
  if (!integer(value.round) || typeof value.target !== "string" || value.target === "") issues.push(`${path} has invalid round or target`);
  const provenance: AttemptProvenance[] = ["not_started", "prepared", "spawn_requested", "spawned", "settled_validated_packet", "settled_without_valid_packet"];
  if (!provenance.includes(value.provenance as AttemptProvenance)) issues.push(`${path}.provenance is invalid`);
  if (!["none", "uncertain_outcome", "workspace_may_have_changed", "validated_packet", "invalid_packet"].includes(String(value.recoveryRisk))) issues.push(`${path}.recoveryRisk is invalid`);
  for (const key of ["preparedAt", "spawnRequestedAt", "spawnedAt", "settledAt"]) if (value[key] !== undefined && !finite(value[key])) issues.push(`${path}.${key} must be finite`);
  if (value.agentId !== undefined && (typeof value.agentId !== "string" || value.agentId === "")) issues.push(`${path}.agentId must be non-empty when present`);
  if (value.packetValidated !== undefined && typeof value.packetValidated !== "boolean") issues.push(`${path}.packetValidated must be boolean`);
  if (value.configRevision !== undefined && typeof value.configRevision !== "string") issues.push(`${path}.configRevision must be a string`);
  if (value.targetId !== undefined && (typeof value.targetId !== "string" || value.targetId === "")) issues.push(`${path}.targetId must be a non-empty string`);
}

function validateCheckpoint(value: unknown, state: Record<string, unknown>, issues: string[]): void {
  if (!record(value)) {
    issues.push("checkpoint is required for version 2");
    return;
  }
  exactKeys(value, ["id", "runId", "revision", "state", "phase", "repairRound", "remediationRounds", "architectEscalations", "leadEscalations"], ["attemptId", "agentId", "targetId"], "checkpoint", issues);
  if (typeof value.id !== "string" || value.id === "") issues.push("checkpoint.id must be non-empty");
  if (value.runId !== state.runId) issues.push("checkpoint.runId must equal runId");
  if (value.revision !== state.stateRevision) issues.push("checkpoint.revision must equal stateRevision");
  if (!integer(value.revision) || value.revision === 0) issues.push("checkpoint.revision must be a positive integer");
  if (!FACTORY_STATES.includes(value.state as FactoryState) || value.state !== state.state) issues.push("checkpoint.state must equal state");
  if (typeof value.phase !== "string" || (PHASE_ROLES[value.phase] === undefined && value.phase !== `terminal:${String(state.state)}`)) issues.push("checkpoint.phase must be a known phase");
  for (const key of ["repairRound", "remediationRounds", "architectEscalations", "leadEscalations"]) if (!integer(value[key]) || value[key] !== state[key]) issues.push(`checkpoint.${key} must equal persisted progress`);
  if (value.attemptId !== undefined && typeof value.attemptId !== "string") issues.push("checkpoint.attemptId must be a string");
  if (value.agentId !== undefined && typeof value.agentId !== "string") issues.push("checkpoint.agentId must be a string");
  if (value.targetId !== undefined && typeof value.targetId !== "string") issues.push("checkpoint.targetId must be a string");
  if (state.version === 3 && record(state.targetPlan) && typeof state.targetPlan.currentTargetId === "string" && ["execution.engineer", "review.reviewer"].includes(String(value.phase)) && value.targetId !== state.targetPlan.currentTargetId) issues.push("checkpoint.targetId must match active target");
}

function validateMetrics(value: unknown, issues: string[]): void {
  if (!record(value)) {
    issues.push("metrics must be an object");
    return;
  }
  if (!record(value.roles)) issues.push("metrics.roles must be an object");
  else {
    exactKeys(value.roles, [...ROLE_NAMES], [], "metrics.roles", issues);
    for (const role of ROLE_NAMES) {
      const metric = value.roles[role];
      if (!record(metric)) {
        issues.push(`metrics.roles.${role} must be an object`);
        continue;
      }
      exactKeys(metric, ["role", "attempts", "retries", "fallbacks", "targetsAttempted"], ["agentId", "targetUsed", "status", "startedAt", "completedAt", "durationMs", "modelName", "modelId", "logicalTokens", "cacheRead", "input", "output", "cost", "toolUses", "compactionCount", "error"], `metrics.roles.${role}`, issues);
      if (metric.role !== role) issues.push(`metrics.roles.${role}.role must match its key`);
      for (const key of ["attempts", "retries", "fallbacks"]) if (!integer(metric[key])) issues.push(`metrics.roles.${role}.${key} must be a non-negative integer`);
      if (!strings(metric.targetsAttempted)) issues.push(`metrics.roles.${role}.targetsAttempted must be a string array`);
    }
  }
  for (const key of ["totalAttempts", "totalRetries", "totalFallbacks", "capacityWaits"]) if (!integer(value[key])) issues.push(`metrics.${key} must be a non-negative integer`);
  if (value.calls !== undefined) {
    if (!Array.isArray(value.calls)) issues.push("metrics.calls must be an array");
    else for (const [index, call] of value.calls.entries()) {
      if (!record(call)) { issues.push(`metrics.calls[${index}] must be an object`); continue; }
      exactKeys(call, ["role", "phase", "agentId", "ok"], ["target", "modelName", "modelId", "startedAt", "completedAt", "durationMs", "input", "output", "cacheRead", "cacheWrite", "logicalTokens", "cost", "toolUses", "compactionCount"], `metrics.calls[${index}]`, issues);
      if (!ROLE_NAMES.includes(call.role as RoleName) || typeof call.phase !== "string" || typeof call.agentId !== "string" || typeof call.ok !== "boolean") issues.push(`metrics.calls[${index}] has invalid identity or result`);
    }
  }
  if (!finite(value.runStartedAt)) issues.push("metrics.runStartedAt must be finite");
  for (const key of ["runEndedAt", "runDurationMs"]) if (value[key] !== undefined && !finite(value[key])) issues.push(`metrics.${key} must be finite`);
}

function validateStateConsistency(state: Record<string, unknown>, issues: string[], strictV2: boolean): void {
  const current = state.state as FactoryState;
  const inFlight = state.inFlight;
  const waiting = state.waiting;
  if (TERMINAL_STATES.includes(current)) {
    if (inFlight !== undefined) issues.push("terminal states cannot have inFlight");
    if (waiting !== undefined || state.parked === true) issues.push("terminal states cannot be parked or waiting");
  }
  if (current === "WAITING_CAPACITY") {
    if (!record(waiting)) issues.push("WAITING_CAPACITY requires waiting state");
    else {
      exactKeys(waiting, ["phase", "role", "resumeState", "attemptedTargets", "reasons", "nextRetryAt"], ["retryAfterMs"], "waiting", issues);
      if (!FACTORY_STATES.includes(waiting.resumeState as FactoryState) || waiting.resumeState === "WAITING_CAPACITY" || TERMINAL_STATES.includes(waiting.resumeState as FactoryState)) issues.push("waiting.resumeState must be a non-terminal non-park state");
      if (typeof waiting.phase !== "string" || PHASE_ROLES[waiting.phase] !== waiting.role) issues.push("waiting phase and role must agree");
      if (!strings(waiting.attemptedTargets) || !strings(waiting.reasons) || !finite(waiting.nextRetryAt)) issues.push("waiting state has invalid retry data");
    }
    if (inFlight !== undefined) issues.push("WAITING_CAPACITY cannot have inFlight");
    if (state.parked !== true) issues.push("WAITING_CAPACITY must be parked");
  } else if (waiting !== undefined) issues.push("waiting is only valid in WAITING_CAPACITY");
  if (inFlight !== undefined) {
    if (record(inFlight)) exactKeys(inFlight, ["role", "phase", "agentId", "target", "spawnedAt"], [], "inFlight", issues);
    if (!record(inFlight) || !ROLE_NAMES.includes(inFlight.role as RoleName) || typeof inFlight.phase !== "string" || PHASE_ROLES[inFlight.phase] !== inFlight.role || typeof inFlight.agentId !== "string" || typeof inFlight.target !== "string" || !finite(inFlight.spawnedAt)) issues.push("inFlight has invalid role, phase, agent, target, or timestamp");
    else {
      const allowed: Record<FactoryState, string[]> = {
        DISCOVERY: ["discovery.lead"], INITIAL_ARCHITECT: ["initial.architect"], EXECUTION: ["execution.engineer", "escalation.lead"], REVIEW: ["review.reviewer"], ARCHITECT_ESCALATION: ["escalation.architect"], INTEGRATION: ["integration.lead"], FINAL_ARCHITECT: ["final.architect"], REMEDIATION: ["remediation.engineer", "remediation.reviewer"], FINAL_ARCHITECT_RECHECK: ["final_recheck.architect"], FINAL_SYNTHESIS: ["final_synthesis.lead"], WAITING_CAPACITY: [], DONE: [], STOPPED: [], FAILED: [],
      };
      if (!allowed[current]?.includes(inFlight.phase)) issues.push("inFlight phase does not match the persisted state");
    }
  }
  for (const key of ["repairRound", "remediationRounds", "architectEscalations", "leadEscalations"]) if (!integer(state[key])) issues.push(`${key} must be a non-negative integer`);
  if (strictV2 && record(state.results)) {
    const results = state.results;
    const required: Partial<Record<FactoryState, string>> = { INITIAL_ARCHITECT: "proposal", REVIEW: "engineers", INTEGRATION: "reviewers", FINAL_ARCHITECT: "integration", REMEDIATION: "finalArchitect", FINAL_ARCHITECT_RECHECK: "remediation", FINAL_SYNTHESIS: "finalArchitect", DONE: "finalReport" };
    for (const [phase, resultKey] of Object.entries(required)) {
      if (current === phase && ((resultKey === "engineers" || resultKey === "reviewers") ? (!Array.isArray(results[resultKey]) || results[resultKey].length === 0) : results[resultKey] === undefined)) issues.push(`${current} is missing required persisted result ${resultKey}`);
    }
  }
  if (state.repairExhausted !== true && state.repairExhausted !== false) issues.push("repairExhausted must be boolean");
  if (state.parked !== true && state.parked !== false) issues.push("parked must be boolean");
}

export interface FactoryStateValidation {
  ok: boolean;
  issues: string[];
  legacy: boolean;
}

/** Structural and semantic validation for a JSON-decoded persisted run. */
export function validatePersistedFactoryRunState(value: unknown, intendedProjectDir?: string): FactoryStateValidation {
  const issues: string[] = [];
  if (!record(value)) return { ok: false, issues: ["Factory run state must be an object"], legacy: false };
  const state = value;
  const legacy = state.version === LEGACY_FACTORY_STATE_VERSION;
  exactKeys(state, ["version", "runId", "createdAt", "updatedAt", "task", "cwd", "config", "state", "repairRound", "repairExhausted", "effectiveArchitecture", "remediationRounds", "architectEscalations", "leadEscalations", "results", "metrics", "errors", "parked"], ["inFlight", "waiting", "stoppedReason", "stateRevision", "checkpoint", "attempts", "presetReplacement", "targetPlan"], "state", issues);
  const supportedVersions: readonly number[] = [LEGACY_FACTORY_STATE_VERSION, RECOVERY_FACTORY_STATE_VERSION, FACTORY_STATE_VERSION];
  if (!supportedVersions.includes(state.version as number)) issues.push("unsupported Factory state version");
  if (state.version !== 3 && state.targetPlan !== undefined) issues.push("historical runs cannot contain a targetPlan");
  if (state.version === 3 && state.targetPlan !== undefined) validateTargetPlan(state.targetPlan, state, issues);
  if (state.version === 3 && record(state.results) && state.results.initialArchitect !== undefined && state.targetPlan === undefined && !["INITIAL_ARCHITECT", "STOPPED", "FAILED"].includes(String(state.state))) issues.push("approved version 3 run requires a targetPlan");
  issues.push(...validateRunId(state.runId));
  for (const key of ["createdAt", "updatedAt"]) if (!finite(state[key])) issues.push(`${key} must be finite`);
  if (typeof state.task !== "string" || state.task === "") issues.push("task must be a non-empty string");
  if (typeof state.cwd !== "string" || !isAbsolute(state.cwd)) issues.push("cwd must be an absolute path");
  if (intendedProjectDir !== undefined) issues.push(...canonicalWorkspacePath(String(state.cwd), intendedProjectDir));
  if (!FACTORY_STATES.includes(state.state as FactoryState)) issues.push("state is invalid");
  if (!validateConfig(state.config, issues)) { /* issues already recorded */ }
  validateResults(state.results, issues);
  if (state.version === 3 && state.targetPlan !== undefined) validateTargetApprovalConsistency(state, issues);
  validateMetrics(state.metrics, issues);
  if (!Array.isArray(state.errors)) issues.push("errors must be an array");
  else for (const [index, error] of state.errors.entries()) if (!record(error) || typeof error.phase !== "string" || typeof error.message !== "string" || !finite(error.at)) issues.push(`errors[${index}] is invalid`);
  validateStateConsistency(state, issues, state.version !== LEGACY_FACTORY_STATE_VERSION);
  if (state.presetReplacement !== undefined) {
    if (!record(state.presetReplacement)) {
      issues.push("presetReplacement must be an object");
    } else {
      exactKeys(state.presetReplacement, ["preset", "snapshot", "appliedAt", "revision"], [], "presetReplacement", issues);
      if (typeof state.presetReplacement.preset !== "string" || state.presetReplacement.preset === "") issues.push("presetReplacement.preset must be a non-empty string");
      if (!finite(state.presetReplacement.appliedAt)) issues.push("presetReplacement.appliedAt must be finite");
      if (!integer(state.presetReplacement.revision) || state.presetReplacement.revision === 0) issues.push("presetReplacement.revision must be a positive integer");
      validateConfig(state.presetReplacement.snapshot, issues);
    }
  }
  if (legacy) {
    if (state.stateRevision !== undefined || state.checkpoint !== undefined || state.attempts !== undefined || state.presetReplacement !== undefined) issues.push("legacy state cannot contain recovery fields");
  } else {
    if (!integer(state.stateRevision) || state.stateRevision === 0) issues.push("stateRevision must be a positive integer");
    validateCheckpoint(state.checkpoint, state, issues);
    if (!Array.isArray(state.attempts)) issues.push("attempts is required for version 2");
    else {
      const ids = new Set<string>();
      for (const [index, attempt] of state.attempts.entries()) {
        validateAttempt(attempt, index, issues);
        if (record(attempt) && typeof attempt.attemptId === "string" && !ids.add(attempt.attemptId)) issues.push(`attempts[${index}].attemptId is duplicated`);
        if (record(attempt)) {
          if (attempt.provenance === "spawned" && typeof attempt.agentId !== "string") issues.push(`attempts[${index}] spawned provenance requires agentId`);
          if (attempt.provenance === "settled_validated_packet" && attempt.packetValidated !== true) issues.push(`attempts[${index}] validated provenance requires packetValidated=true`);
          if (attempt.provenance === "settled_without_valid_packet" && attempt.packetValidated === true) issues.push(`attempts[${index}] invalid provenance cannot be packetValidated=true`);
        }
      }
    }
  }
  const metrics = record(state.metrics) ? state.metrics : undefined;
  const roles = metrics && record(metrics.roles) ? metrics.roles : undefined;
  if (state.version !== LEGACY_FACTORY_STATE_VERSION && roles && metrics && integer(metrics.totalAttempts)) {
    const attempts = ROLE_NAMES.reduce((sum, role) => {
      const metric = record(roles[role]) ? roles[role] : undefined;
      return sum + (metric && integer(metric.attempts) ? metric.attempts : 0);
    }, 0);
    if (attempts !== metrics.totalAttempts) issues.push("metrics.totalAttempts must equal the sum of role attempts");
  }
  return { ok: issues.length === 0, issues, legacy };
}

export class FactoryStateValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Factory run state: ${issues.join("; ")}`);
    this.name = "FactoryStateValidationError";
    this.issues = issues;
  }
}

export function assertValidFactoryRunState(value: unknown, intendedProjectDir?: string): asserts value is FactoryRunState {
  const result = validatePersistedFactoryRunState(value, intendedProjectDir);
  if (!result.ok) throw new FactoryStateValidationError(result.issues);
}

export function parseFactoryRunState(value: unknown, intendedProjectDir?: string): FactoryRunState {
  assertValidFactoryRunState(value, intendedProjectDir);
  return value;
}

export function isValidFactoryRunState(value: unknown, intendedProjectDir?: string): value is FactoryRunState {
  return validatePersistedFactoryRunState(value, intendedProjectDir).ok;
}

function phaseForState(state: FactoryState): string {
  if (TERMINAL_STATES.includes(state)) return `terminal:${state}`;
  const phases: Partial<Record<FactoryState, string>> = {
    DISCOVERY: "discovery.lead",
    INITIAL_ARCHITECT: "initial.architect",
    EXECUTION: "execution.engineer",
    REVIEW: "review.reviewer",
    ARCHITECT_ESCALATION: "escalation.architect",
    INTEGRATION: "integration.lead",
    FINAL_ARCHITECT: "final.architect",
    REMEDIATION: "remediation.engineer",
    FINAL_ARCHITECT_RECHECK: "final_recheck.architect",
    FINAL_SYNTHESIS: "final_synthesis.lead",
  };
  return phases[state] ?? state;
}

function targetForPhase(state: FactoryRunState, phase: string): string | undefined {
  if (state.version !== 3 || !state.targetPlan) return undefined;
  if (phase === "execution.engineer" || phase === "review.reviewer") return state.targetPlan.currentTargetId;
  if (phase === "remediation.engineer") return state.results.finalArchitect?.packet.affectedTargetIds?.[0] ?? "integration";
  return undefined;
}

function latestAttempt(state: FactoryRunState, phase: string): FactoryAttempt | undefined {
  const targetId = targetForPhase(state, phase);
  if (state.version === 3 && state.targetPlan && !targetId && (phase === "execution.engineer" || phase === "review.reviewer")) return undefined;
  return [...(state.attempts ?? [])].reverse().find((attempt) => attempt.phase === phase && (targetId === undefined || attempt.targetId === targetId));
}

/** The latest attempt recorded for a phase. */
export function latestAttemptForPhase(state: FactoryRunState, phase: string): FactoryAttempt | undefined {
  return latestAttempt(state, phase);
}

/** Whether a settled Engineer packet is present alongside its provenance. */
export function hasPersistedAttemptPacket(state: FactoryRunState, attempt: FactoryAttempt): boolean {
  if (attempt.phase === "execution.engineer") {
    return state.results.engineers.some((item) => item.outcome.agentId === attempt.agentId
      && (attempt.targetId === undefined || item.targetId === attempt.targetId));
  }
  if (attempt.phase === "remediation.engineer") return state.results.remediation?.engineer?.agentId === attempt.agentId;
  return true;
}

/** The latest attempt for a phase when its spawn outcome is unresolved
 * (`prepared` / `spawn_requested` with no settlement). A child may have been
 * dispatched whose outcome is unknown — the phase must never be replayed
 * merely because `inFlight` is absent.
 */
export function unresolvedAttemptForPhase(state: FactoryRunState, phase: string): FactoryAttempt | undefined {
  const attempt = latestAttempt(state, phase);
  if (attempt !== undefined && (attempt.provenance === "prepared" || attempt.provenance === "spawn_requested")) return attempt;
  return undefined;
}

/** The unresolved attempt for the phase the run would drive next, if any. */
export function unresolvedSpawnAttempt(state: FactoryRunState): FactoryAttempt | undefined {
  const phase = state.inFlight?.phase ?? state.waiting?.phase ?? phaseForState(state.state);
  return unresolvedAttemptForPhase(state, phase);
}

/** Construct a collision-resistant checkpoint from persisted state only. */
export function createFactoryCheckpoint(state: FactoryRunState, revision = state.stateRevision ?? 0): FactoryCheckpoint {
  const phase = state.inFlight?.phase ?? state.waiting?.phase ?? phaseForState(state.state);
  const attempt = latestAttempt(state, phase);
  const attemptId = state.inFlight?.agentId === undefined ? attempt?.attemptId : attempt?.attemptId;
  const agentId = state.inFlight?.agentId;
  const targetId = targetForPhase(state, phase);
  const parts = [state.runId, state.state, phase, ...(targetId ? [`target=${targetId}`] : []), `repair=${state.repairRound}`, `remediation=${state.remediationRounds}`, `architect=${state.architectEscalations}`, `lead=${state.leadEscalations}`, `attempt=${attemptId ?? "none"}`, `agent=${agentId ?? "none"}`, `revision=${revision}`];
  return {
    id: parts.join("|"),
    runId: state.runId,
    revision,
    state: state.state,
    phase,
    repairRound: state.repairRound,
    remediationRounds: state.remediationRounds,
    architectEscalations: state.architectEscalations,
    leadEscalations: state.leadEscalations,
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
  };
}

export type RecoveryDecision = "automatic" | "approval_required" | "blocked";

export interface RecoveryPlan {
  decision: RecoveryDecision;
  reason: string;
  phase: string;
  checkpoint: FactoryCheckpoint;
  /** The latest durable provenance; absent means the phase is definitely not started. */
  provenance: AttemptProvenance | "not_started";
  recoveryRisk: FactoryAttempt["recoveryRisk"] | "none";
  legacy: boolean;
}

function engineerPhase(phase: string): boolean {
  return phase === "execution.engineer" || phase === "remediation.engineer";
}

/**
 * Pure, fail-closed recovery planning. It performs no I/O, mutation, timers,
 * subscriptions, controller work, model calls, or agent spawns.
 */
export function planFactoryRecovery(state: FactoryRunState): RecoveryPlan {
  const validation = validatePersistedFactoryRunState(state);
  const checkpoint = createFactoryCheckpoint(state);
  const phase = checkpoint.phase;
  const legacy = state.version === LEGACY_FACTORY_STATE_VERSION || state.attempts === undefined;
  if (!validation.ok) return { decision: "blocked", reason: `Corrupt persisted state: ${validation.issues.join("; ")}`, phase, checkpoint, provenance: "not_started", recoveryRisk: "uncertain_outcome", legacy };
  if (TERMINAL_STATES.includes(state.state)) return { decision: "blocked", reason: `Run is terminal (${state.state})`, phase, checkpoint, provenance: "not_started", recoveryRisk: "none", legacy };
  const attempt = latestAttempt(state, phase);
  const provenance = attempt?.provenance ?? "not_started";
  const recoveryRisk = attempt?.recoveryRisk ?? "none";
  if (provenance === "settled_without_valid_packet") return { decision: "blocked", reason: "The latest attempt settled without a valid packet; replay is not safe", phase, checkpoint, provenance, recoveryRisk, legacy };
  if (provenance === "settled_validated_packet" && attempt && engineerPhase(phase) && !hasPersistedAttemptPacket(state, attempt)) {
    return { decision: "approval_required", reason: "Validated Engineer provenance has no matching persisted packet; explicit approval is required before replay", phase, checkpoint, provenance, recoveryRisk: "workspace_may_have_changed", legacy };
  }
  // WAITING_CAPACITY is reached only through definitive pre-spawn rejections
  // (quota or "no eligible target") that preserved the retry deadline, so
  // automatic capacity recovery is safe.
  if (state.state === "WAITING_CAPACITY") {
    return { decision: "automatic", reason: "Parked waiting for capacity; automatic recovery at the preserved retry deadline", phase, checkpoint, provenance, recoveryRisk, legacy };
  }
  if (provenance === "settled_validated_packet") return { decision: "automatic", reason: "A validated packet is durably settled at this checkpoint", phase, checkpoint, provenance, recoveryRisk, legacy };
  if (state.version === 3 && state.targetPlan && state.state === "EXECUTION" && !state.targetPlan.currentTargetId && !state.inFlight && !state.parked)
    return { decision: "automatic", reason: "Accepted target checkpoint; next target not dispatched", phase, checkpoint, provenance: "not_started", recoveryRisk: "none", legacy };
  if (legacy && engineerPhase(phase)) return { decision: "approval_required", reason: "Legacy Engineer state has ambiguous attempt provenance; explicit approval is required", phase, checkpoint, provenance, recoveryRisk: "workspace_may_have_changed", legacy };
  if (attempt === undefined && engineerPhase(phase)) return { decision: "approval_required", reason: "Engineer attempt provenance is absent; workspace safety is unknown", phase, checkpoint, provenance, recoveryRisk: "workspace_may_have_changed", legacy };
  if (provenance === "not_started") return { decision: "automatic", reason: "The current phase is durably known not to have started", phase, checkpoint, provenance, recoveryRisk, legacy };
  return { decision: "approval_required", reason: `Attempt provenance ${provenance} does not establish a safe replay`, phase, checkpoint, provenance, recoveryRisk: recoveryRisk === "none" ? "uncertain_outcome" : recoveryRisk, legacy };
}

export const planRecovery = planFactoryRecovery;
export const validateFactoryRunState = validatePersistedFactoryRunState;
