import type { ArchitectPlanAssessment, FactoryMissionRequirement, FactoryTarget, FactoryTargetOutcome, FactoryTargetPlan, LeadProposalPacket } from "./types.js";

export const TARGET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REQUIREMENT_ID = /^REQ-\d{3,}$/;

/** Assign immutable-in-run IDs to the Lead's original requirements and constraints. */
export function createRequirementCatalog(humanRequirements: string[], constraints: string[]): FactoryMissionRequirement[] {
  const catalog: FactoryMissionRequirement[] = [];
  const seen = new Set<string>();
  for (const [source, entries] of [["human_requirement", humanRequirements], ["human_constraint", constraints]] as const) {
    for (const text of entries) {
      const key = `${source}:${text.trim().toLowerCase().replace(/\s+/g, " ")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      catalog.push({ id: `REQ-${String(catalog.length + 1).padStart(3, "0")}`, text, source });
    }
  }
  return catalog;
}

/** Fail closed on incomplete or ambiguous executable plans, before any Engineer runs. */
export function validateTargets(targets: FactoryTarget[]): string[] {
  const issues: string[] = [];
  if (targets.length === 0) return ["approved plan must contain at least one target"];
  const ids = new Set<string>();
  for (const target of targets) {
    if (!TARGET_ID.test(target.id)) issues.push(`invalid target ID: ${target.id}`);
    if (ids.has(target.id)) issues.push(`duplicate target ID: ${target.id}`);
    ids.add(target.id);
    if (!target.description.trim()) issues.push(`target ${target.id} has no description`);
    if (target.acceptanceCriteria.length === 0 || target.acceptanceCriteria.some((item) => !item.trim())) issues.push(`target ${target.id} has no usable acceptance criteria`);
    if (new Set(target.dependsOn).size !== target.dependsOn.length) issues.push(`target ${target.id} has duplicate dependencies`);
  }
  for (const target of targets) {
    for (const dependency of target.dependsOn) {
      if (!ids.has(dependency)) issues.push(`target ${target.id} depends on missing target ${dependency}`);
      if (dependency === target.id) issues.push(`target ${target.id} depends on itself`);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(targets.map((target) => [target.id, target]));
  const visit = (id: string): void => {
    if (visiting.has(id)) { issues.push(`dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return issues;
}

// Topologically order affected dependents even when declaration order is not topological.
export function dependentsInOrder(plan: FactoryTargetPlan, id: string): FactoryTarget[] {
  const affected = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const target of plan.targets) {
      if (affected.has(target.id) || !target.dependsOn.some((dep) => affected.has(dep))) continue;
      affected.add(target.id);
      changed = true;
    }
  }
  const remaining = plan.targets.filter((target) => affected.has(target.id) && target.id !== id);
  const ordered: FactoryTarget[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((target) => target.dependsOn.every((dep) => !remaining.some((item) => item.id === dep)));
    if (index < 0) throw new Error("Approved target graph contains a cycle");
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

/** Validate the Architect's explicit target approval against Lead/user constraints. */
export function validateArchitectTargetApproval(
  proposal: LeadProposalPacket,
  approvedTargets: FactoryTarget[],
  assessment: ArchitectPlanAssessment,
  approvedConstraints: string[],
): string[] {
  const issues = validateTargets(approvedTargets);
  const approvedIds = new Set(approvedTargets.map((target) => target.id));
  const proposedIds = proposal.targets?.map((target) => target.id);
  if (proposedIds && proposedIds.length > 0) {
    const proposedIdSet = new Set(proposedIds);
    for (const id of approvedIds) {
      if (!proposedIdSet.has(id)) issues.push(`Architect added unproposed implementation target ${id}; approval may refine but not extend the Lead target inventory. If this is a genuinely missing deliverable, return CLARIFY with its requirement IDs and request an owner-authorized revised plan.`);
    }
    for (const id of proposedIdSet) {
      if (!approvedIds.has(id)) issues.push(`Architect omitted proposed implementation target ${id}; approval may not silently drop a deliverable. Return CLARIFY if no safe refinement can cover it.`);
    }
  }
  if (proposal.requirementCatalog === undefined) {
    const constraints = new Set(approvedConstraints.map((constraint) => constraint.trim().toLowerCase()));
    for (const constraint of proposal.constraints) {
      if (!constraints.has(constraint.trim().toLowerCase())) issues.push(`Architect approval omitted a Lead/user constraint: ${constraint}`);
    }
  }
  if (assessment.verdict !== "complete") issues.push("Architect did not confirm complete mission coverage");
  if (assessment.uncoveredRequirements.length > 0) issues.push(`Architect identified uncovered requirements: ${assessment.uncoveredRequirements.join("; ")}`);
  if (assessment.missionRequirements.length === 0 || assessment.missionRequirements.some((requirement) => !requirement.trim())) {
    issues.push("Architect approval must enumerate non-empty mission requirements");
  }

  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
  const requirements = new Set(assessment.missionRequirements.map(normalize));
  if (requirements.size !== assessment.missionRequirements.length) issues.push("Architect mission requirements contain duplicates");
  const coverage = new Map<string, string[]>();
  if (proposal.requirementCatalog !== undefined) {
    const expectedCatalog = createRequirementCatalog(proposal.humanRequirements ?? [], proposal.constraints);
    if (JSON.stringify(proposal.requirementCatalog) !== JSON.stringify(expectedCatalog)) issues.push("Lead requirement identities do not match the original requirement inventory");
    if (expectedCatalog.length === 0) issues.push("Multi-target approval has no original mission requirement identities");
    const knownRequirements = new Set(expectedCatalog.map((requirement) => requirement.id));
    for (const item of assessment.requirementCoverage) {
      if (!("requirementId" in item)) {
        issues.push(`Coverage mapping for ${item.requirement} must use a stable Lead requirement identity`);
        continue;
      }
      const id = item.requirementId;
      if (!REQUIREMENT_ID.test(id)) issues.push(`Architect mapped an invalid requirement identity: ${id}`);
      if (coverage.has(id)) issues.push(`Architect mapped requirement identity more than once: ${id}`);
      coverage.set(id, item.targetIds);
      if (!knownRequirements.has(id)) issues.push(`Coverage mapping references an unknown requirement identity: ${id}`);
      if (item.targetIds.length === 0 || new Set(item.targetIds).size !== item.targetIds.length) issues.push(`Requirement identity needs unique target coverage: ${id}`);
      for (const targetId of item.targetIds) if (!approvedIds.has(targetId)) issues.push(`Requirement ${id} maps to unknown target ${targetId}`);
    }
    for (const requirement of expectedCatalog) {
      if (!coverage.has(requirement.id)) issues.push(`Mandatory requirement identity has no target coverage: ${requirement.id}`);
    }
    const mandatoryConstraints = new Set(expectedCatalog.filter((item) => item.source === "human_constraint").map((item) => item.id));
    const preservedConstraints = assessment.preservedConstraintIds ?? [];
    if (assessment.preservedConstraintIds === undefined) issues.push("Architect approval has no explicit preserved-constraint identity assessment");
    const preserved = new Set<string>();
    for (const id of preservedConstraints) {
      if (preserved.has(id)) issues.push(`Architect repeated preserved constraint identity: ${id}`);
      preserved.add(id);
      if (!mandatoryConstraints.has(id)) issues.push(`Architect preserved an unknown or non-constraint identity: ${id}`);
    }
    for (const id of mandatoryConstraints) {
      if (!preserved.has(id)) issues.push(`Architect omitted explicit human constraint identity: ${id}`);
    }
  } else {
    // Historical persisted packets used requirement prose as identity. Keep
    // their exact validation semantics; new packets always receive a catalog.
    const requiredFromLead = [
      ...(proposal.humanRequirements ?? []),
      ...proposal.constraints,
      ...proposal.acceptanceCriteria,
      ...(proposal.targets ?? []).flatMap((target) => target.acceptanceCriteria),
    ];
    for (const requirement of requiredFromLead) {
      if (!requirements.has(normalize(requirement))) issues.push(`Architect omitted a Lead/user requirement: ${requirement}`);
    }
    for (const criterion of [
      ...(proposal.acceptanceCriteria ?? []),
      ...(proposal.targets ?? []).flatMap((target) => target.acceptanceCriteria),
    ]) {
      if (!approvedTargets.some((target) => target.acceptanceCriteria.some((item) => normalize(item) === normalize(criterion)))) {
        issues.push(`Architect approval removed a proposed criterion: ${criterion}`);
      }
    }
    for (const item of assessment.requirementCoverage) {
      if (!("requirement" in item)) {
        issues.push(`Historical coverage mapping has no requirement text: ${item.requirementId}`);
        continue;
      }
      const key = normalize(item.requirement);
      if (coverage.has(key)) issues.push(`Architect mapped requirement more than once: ${item.requirement}`);
      coverage.set(key, item.targetIds);
      if (!requirements.has(key)) issues.push(`Coverage mapping references an unlisted requirement: ${item.requirement}`);
      if (item.targetIds.length === 0 || new Set(item.targetIds).size !== item.targetIds.length) issues.push(`Requirement needs unique target coverage: ${item.requirement}`);
      for (const id of item.targetIds) if (!approvedIds.has(id)) issues.push(`Requirement ${item.requirement} maps to unknown target ${id}`);
    }
    for (const requirement of assessment.missionRequirements) {
      if (!coverage.has(normalize(requirement))) issues.push(`Mission requirement has no target coverage: ${requirement}`);
    }
  }

  const dependencyKey = (targetId: string, dependsOn: string): string => `${targetId}\u0000${dependsOn}`;
  const assessedDependencies = new Set<string>();
  for (const dependency of assessment.missionDependencies) {
    const key = dependencyKey(dependency.targetId, dependency.dependsOn);
    if (assessedDependencies.has(key)) issues.push(`Architect mission dependencies contain a duplicate edge: ${dependency.dependsOn} → ${dependency.targetId}`);
    assessedDependencies.add(key);
    const target = approvedTargets.find((candidate) => candidate.id === dependency.targetId);
    if (!approvedIds.has(dependency.targetId) || !approvedIds.has(dependency.dependsOn)) {
      issues.push(`Architect identified a human dependency with an unknown target: ${dependency.dependsOn} → ${dependency.targetId}`);
    } else if (!target?.dependsOn.includes(dependency.dependsOn)) {
      issues.push(`Architect approval does not preserve identified human dependency: ${dependency.dependsOn} → ${dependency.targetId}`);
    }
  }
  for (const dependency of proposal.humanDependencies ?? []) {
    if (!assessedDependencies.has(dependencyKey(dependency.targetId, dependency.dependsOn))) {
      issues.push(`Architect omitted explicit human dependency: ${dependency.dependsOn} → ${dependency.targetId}`);
    }
  }
  return issues;
}

export function createTargetPlan(targets: FactoryTarget[]): FactoryTargetPlan {
  const issues = validateTargets(targets);
  if (issues.length > 0) throw new Error(`Invalid approved target plan: ${issues.join("; ")}`);
  const outcomes: Record<string, FactoryTargetOutcome> = {};
  for (const target of targets) outcomes[target.id] = { status: "pending" };
  return { targets, outcomes, revision: 1, rationale: ["Initial Architect approval"] };
}

/** Transitive blocking is deterministic; an unrelated eligible target can still run. */
export function blockFailedDependencies(plan: FactoryTargetPlan): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const target of plan.targets) {
      const outcome = plan.outcomes[target.id];
      if (outcome.status !== "pending") continue;
      const blockedBy = target.dependsOn.filter((id) => ["failed", "blocked"].includes(plan.outcomes[id]?.status ?? ""));
      if (blockedBy.length === 0) continue;
      plan.outcomes[target.id] = { status: "blocked", blockedBy, reason: `Prerequisite ${blockedBy.join(", ")} did not pass` };
      changed = true;
    }
  }
}

/** Stable plan order breaks ties between independently eligible targets. */
export function nextEligibleTarget(plan: FactoryTargetPlan): FactoryTarget | undefined {
  return plan.targets.find((target) => plan.outcomes[target.id]?.status === "pending"
    && target.dependsOn.every((id) => plan.outcomes[id]?.status === "passed"));
}
