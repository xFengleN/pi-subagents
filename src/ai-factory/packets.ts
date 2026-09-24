/**
 * ai-factory/packets.ts — Structured handoff packets.
 *
 * Reuses the repository's existing workflow/schema machinery: each packet type
 * is a plain JSON Schema, compiled with `compileJsonSchema` and handed to a
 * role child as its `StructuredOutput` tool schema, so the model produces a
 * validated packet rather than prose the controller has to parse. The
 * controller still has a lenient text fallback for agents that never call the
 * tool.
 *
 * A packet that cannot be extracted at all is surfaced as a phase failure —
 * never guessed.
 */

import { type CompiledSchema, compileJsonSchema } from "../workflow/json-schema.js";
import { createRequirementCatalog } from "./targets.js";
import type {
  ArchitectFinalResult,
  ArchitectInitialResult,
  ArchitectPlanAssessment,
  EngineerPacket,
  FactoryDependency,
  FactoryTarget,
  FinalReportPacket,
  LeadEscalationPacket,
  LeadIntegrationPacket,
  LeadProposalPacket,
  Packet,
  ReviewerPacket,
} from "./types.js";

export type PacketKind =
  | "proposal"
  | "architect_initial"
  | "engineer"
  | "reviewer"
  | "integration"
  | "architect_final"
  | "final_report"
  | "lead_escalation";

const strArr = { type: "array", items: { type: "string" } } as const;
const targetArr = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "description", "dependsOn", "acceptanceCriteria"],
    properties: {
      id: { type: "string" },
      description: { type: "string" },
      dependsOn: strArr,
      acceptanceCriteria: strArr,
      requiresArchitectAcceptance: { type: "boolean" },
    },
  },
} as const;
const dependencyArr = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["targetId", "dependsOn"],
    properties: { targetId: { type: "string" }, dependsOn: { type: "string" } },
  },
} as const;
const planAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "missionRequirements", "missionDependencies", "requirementCoverage", "preservedConstraintIds", "uncoveredRequirements"],
  properties: {
    verdict: { type: "string", enum: ["complete", "incomplete"] },
    missionRequirements: strArr,
    missionDependencies: dependencyArr,
    requirementCoverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "targetIds"],
        properties: { requirementId: { type: "string" }, targetIds: strArr },
      },
    },
    preservedConstraintIds: strArr,
    uncoveredRequirements: strArr,
  },
} as const;

/** JSON Schema for each packet type. These become the child's
 * `StructuredOutput` tool schema, so required fields are enforced by the
 * validator (with in-run retries) rather than by prose. */
const PACKET_SCHEMAS: Record<PacketKind, Record<string, unknown>> = {
  proposal: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "proposedSolution", "workPackages", "acceptanceCriteria"],
    properties: {
      goal: { type: "string" },
      repositoryFindings: { type: "string" },
      currentArchitecture: { type: "string" },
      assumptions: strArr,
      proposedSolution: { type: "string" },
      constraints: strArr,
      workPackages: strArr,
      targets: targetArr,
      humanRequirements: strArr,
      humanDependencies: dependencyArr,
      dependencies: { type: "string" },
      risks: strArr,
      acceptanceCriteria: strArr,
      architecturalQuestions: strArr,
    },
  },
  architect_initial: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "approvedArchitecture"],
    properties: {
      verdict: { type: "string", enum: ["APPROVE", "CORRECT", "CLARIFY"] },
      approvedArchitecture: { type: "string" },
      constraints: strArr,
      correctedWorkPackages: strArr,
      approvedTargets: targetArr,
      planAssessment: planAssessmentSchema,
      clarificationQuestions: strArr,
      importantRisks: strArr,
    },
  },
  engineer: {
    type: "object",
    additionalProperties: false,
    required: ["status", "workPackageId", "summary"],
    properties: {
      status: { type: "string", enum: ["completed", "partially_completed", "failed"] },
      workPackageId: { type: "string" },
      summary: { type: "string" },
      changedFiles: strArr,
      importantDecisions: strArr,
      testsRun: strArr,
      testResults: { type: "string" },
      deviations: strArr,
      knownLimitations: strArr,
      unresolvedQuestions: strArr,
      architecturalEscalationRequired: { type: "boolean" },
    },
  },
  reviewer: {
    type: "object",
    additionalProperties: false,
    required: ["verdict"],
    properties: {
      verdict: { type: "string", enum: ["PASS", "NEEDS_FIX", "ARCHITECTURAL_ESCALATION"] },
      blockingFindings: strArr,
      nonBlockingFindings: strArr,
      requiredRepairs: strArr,
      testConcerns: strArr,
      architecturalIssue: { type: "boolean" },
    },
  },
  integration: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "approvedArchitecture", "systemVerification", "factualAssessment"],
    properties: {
      goal: { type: "string" },
      approvedArchitecture: { type: "string" },
      completedWorkPackages: strArr,
      importantDecisions: strArr,
      deviations: strArr,
      systemVerification: { type: "string" },
      reviewerFindingsResolved: strArr,
      reviewerFindingsAcceptedRisk: strArr,
      reviewerFindingsUnresolved: strArr,
      selectedFiles: strArr,
      factualAssessment: { type: "string" },
    },
  },
  architect_final: {
    type: "object",
    additionalProperties: false,
    required: ["verdict"],
    properties: {
      verdict: { type: "string", enum: ["ACCEPT", "NEEDS_REMEDIATION"] },
      affectedTargetIds: strArr,
      integrationOnly: { type: "boolean" },
      blockingIssues: strArr,
      requiredChanges: strArr,
      doNotChange: strArr,
      requiredEvidence: strArr,
    },
  },
  final_report: {
    type: "object",
    additionalProperties: false,
    required: ["result", "summary"],
    properties: {
      result: { type: "string" },
      summary: { type: "string" },
      delivered: strArr,
      architecture: strArr,
      reviewerFindings: strArr,
      validation: strArr,
      commits: strArr,
      endingHead: { type: "string" },
      pushed: { type: "string" },
      humanVerification: strArr,
      warnings: strArr,
    },
  },
  lead_escalation: {
    type: "object",
    additionalProperties: false,
    required: ["verdict"],
    properties: {
      verdict: { type: "string", enum: ["continue", "stop"] },
      guidance: { type: "string" },
    },
  },
};

const compiled = new Map<PacketKind, CompiledSchema>();
for (const [kind, schema] of Object.entries(PACKET_SCHEMAS)) {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(`ai-factory: cannot compile ${kind} packet schema: ${result.message}`);
  compiled.set(kind as PacketKind, result.compiled);
}

/** The compiled schema for a packet kind — what a role child's
 * `StructuredOutput` tool should enforce. */
export function packetSchema(kind: PacketKind): CompiledSchema {
  const schema = compiled.get(kind);
  if (!schema) throw new Error(`Unknown packet kind: ${kind}`);
  return schema;
}

const strList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const str = (v: unknown, d = ""): string => typeof v === "string" ? v : d;
const bool = (v: unknown, d = false): boolean => typeof v === "boolean" ? v : d;
const dependencies = (value: unknown): FactoryDependency[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: FactoryDependency[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const dependency = item as Record<string, unknown>;
    if (typeof dependency.targetId !== "string" || typeof dependency.dependsOn !== "string") return undefined;
    result.push({ targetId: dependency.targetId, dependsOn: dependency.dependsOn });
  }
  return result;
};

const normalizePlanAssessment = (value: unknown): ArchitectPlanAssessment | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const assessment = value as Record<string, unknown>;
  const missionDependencies = dependencies(assessment.missionDependencies);
  if ((assessment.verdict !== "complete" && assessment.verdict !== "incomplete")
    || !Array.isArray(assessment.missionRequirements) || !assessment.missionRequirements.every((item) => typeof item === "string")
    || missionDependencies === undefined
    || !Array.isArray(assessment.uncoveredRequirements) || !assessment.uncoveredRequirements.every((item) => typeof item === "string")
    || (assessment.preservedConstraintIds !== undefined && (!Array.isArray(assessment.preservedConstraintIds) || !assessment.preservedConstraintIds.every((item) => typeof item === "string")))
    || !Array.isArray(assessment.requirementCoverage)) return undefined;
  const requirementCoverage: ArchitectPlanAssessment["requirementCoverage"] = [];
  for (const item of assessment.requirementCoverage) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const coverage = item as Record<string, unknown>;
    if (!Array.isArray(coverage.targetIds) || !coverage.targetIds.every((targetId) => typeof targetId === "string")) return undefined;
    if (typeof coverage.requirementId === "string" && Object.keys(coverage).length === 2) {
      requirementCoverage.push({ requirementId: coverage.requirementId, targetIds: coverage.targetIds as string[] });
    } else if (typeof coverage.requirement === "string" && Object.keys(coverage).length === 2) {
      requirementCoverage.push({ requirement: coverage.requirement, targetIds: coverage.targetIds as string[] });
    } else return undefined;
  }
  return {
    verdict: assessment.verdict,
    missionRequirements: assessment.missionRequirements as string[],
    missionDependencies,
    requirementCoverage,
    ...(assessment.preservedConstraintIds === undefined ? {} : { preservedConstraintIds: assessment.preservedConstraintIds as string[] }),
    uncoveredRequirements: assessment.uncoveredRequirements as string[],
  };
};

const targets = (value: unknown): FactoryTarget[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: FactoryTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const target = item as Record<string, unknown>;
    if (typeof target.id !== "string" || typeof target.description !== "string"
      || !Array.isArray(target.dependsOn) || !Array.isArray(target.acceptanceCriteria)
      || !target.dependsOn.every((entry) => typeof entry === "string")
      || !target.acceptanceCriteria.every((entry) => typeof entry === "string")
      || (target.requiresArchitectAcceptance !== undefined && typeof target.requiresArchitectAcceptance !== "boolean")) return undefined;
    result.push({
      id: target.id, description: target.description,
      dependsOn: target.dependsOn as string[], acceptanceCriteria: target.acceptanceCriteria as string[],
      ...(target.requiresArchitectAcceptance === undefined ? {} : { requiresArchitectAcceptance: target.requiresArchitectAcceptance as boolean }),
    });
  }
  return result;
};

/**
 * Normalize a parsed object into a typed packet, filling optional fields with
 * safe defaults. Does NOT invent values for required fields — those come from
 * the schema validator (structured path) or the extraction check below.
 */
function normalize(kind: PacketKind, raw: Record<string, unknown>): Packet | undefined {
  switch (kind) {
    case "proposal": {
      if (typeof raw.goal !== "string" || typeof raw.proposedSolution !== "string"
        || !Array.isArray(raw.workPackages) || !Array.isArray(raw.acceptanceCriteria)
        || (raw.humanRequirements !== undefined && (!Array.isArray(raw.humanRequirements) || !raw.humanRequirements.every((item) => typeof item === "string")))) return undefined;
      const proposedTargets = raw.targets === undefined ? undefined : targets(raw.targets);
      if (raw.targets !== undefined && proposedTargets === undefined) return undefined;
      const humanDependencies = raw.humanDependencies === undefined ? undefined : dependencies(raw.humanDependencies);
      if (raw.humanDependencies !== undefined && humanDependencies === undefined) return undefined;
      const humanRequirements = strList(raw.humanRequirements);
      const constraints = strList(raw.constraints);
      const p: LeadProposalPacket = {
        goal: raw.goal, repositoryFindings: str(raw.repositoryFindings), currentArchitecture: str(raw.currentArchitecture),
        assumptions: strList(raw.assumptions), proposedSolution: raw.proposedSolution, constraints,
        workPackages: raw.workPackages.map(String),
        ...(proposedTargets === undefined ? {} : { targets: proposedTargets }),
        ...(raw.humanRequirements === undefined ? {} : { humanRequirements }),
        requirementCatalog: createRequirementCatalog(humanRequirements, constraints),
        ...(humanDependencies === undefined ? {} : { humanDependencies }),
        dependencies: str(raw.dependencies), risks: strList(raw.risks),
        acceptanceCriteria: raw.acceptanceCriteria.map(String), architecturalQuestions: strList(raw.architecturalQuestions),
      };
      return p;
    }
    case "architect_initial": {
      const verdict = raw.verdict;
      if (verdict !== "APPROVE" && verdict !== "CORRECT" && verdict !== "CLARIFY") return undefined;
      const approvedTargets = raw.approvedTargets === undefined ? undefined : targets(raw.approvedTargets);
      if (raw.approvedTargets !== undefined && approvedTargets === undefined) return undefined;
      const assessment = raw.planAssessment === undefined ? undefined : normalizePlanAssessment(raw.planAssessment);
      if (raw.planAssessment !== undefined && assessment === undefined) return undefined;
      return {
        verdict, approvedArchitecture: str(raw.approvedArchitecture), constraints: strList(raw.constraints),
        correctedWorkPackages: strList(raw.correctedWorkPackages), importantRisks: strList(raw.importantRisks),
        ...(approvedTargets === undefined ? {} : { approvedTargets }),
        ...(assessment === undefined ? {} : { planAssessment: assessment }),
        ...(raw.clarificationQuestions === undefined ? {} : { clarificationQuestions: strList(raw.clarificationQuestions) }),
      } satisfies ArchitectInitialResult;
    }
    case "engineer": {
      const status = raw.status;
      if (status !== "completed" && status !== "partially_completed" && status !== "failed") return undefined;
      return {
        status, workPackageId: str(raw.workPackageId), summary: str(raw.summary), changedFiles: strList(raw.changedFiles),
        importantDecisions: strList(raw.importantDecisions), testsRun: strList(raw.testsRun), testResults: str(raw.testResults),
        deviations: strList(raw.deviations), knownLimitations: strList(raw.knownLimitations),
        unresolvedQuestions: strList(raw.unresolvedQuestions), architecturalEscalationRequired: bool(raw.architecturalEscalationRequired),
      } satisfies EngineerPacket;
    }
    case "reviewer": {
      const verdict = raw.verdict;
      if (verdict !== "PASS" && verdict !== "NEEDS_FIX" && verdict !== "ARCHITECTURAL_ESCALATION") return undefined;
      return {
        verdict, blockingFindings: strList(raw.blockingFindings), nonBlockingFindings: strList(raw.nonBlockingFindings),
        requiredRepairs: strList(raw.requiredRepairs), testConcerns: strList(raw.testConcerns), architecturalIssue: bool(raw.architecturalIssue),
      } satisfies ReviewerPacket;
    }
    case "integration": {
      if (typeof raw.goal !== "string" || typeof raw.approvedArchitecture !== "string"
        || typeof raw.systemVerification !== "string" || typeof raw.factualAssessment !== "string") return undefined;
      const p: LeadIntegrationPacket = {
        goal: raw.goal, approvedArchitecture: raw.approvedArchitecture, completedWorkPackages: strList(raw.completedWorkPackages),
        importantDecisions: strList(raw.importantDecisions), deviations: strList(raw.deviations),
        systemVerification: raw.systemVerification, reviewerFindingsResolved: strList(raw.reviewerFindingsResolved),
        reviewerFindingsAcceptedRisk: strList(raw.reviewerFindingsAcceptedRisk), reviewerFindingsUnresolved: strList(raw.reviewerFindingsUnresolved),
        selectedFiles: strList(raw.selectedFiles), factualAssessment: raw.factualAssessment,
      };
      return p;
    }
    case "architect_final": {
      const verdict = raw.verdict;
      if (verdict !== "ACCEPT" && verdict !== "NEEDS_REMEDIATION") return undefined;
      return {
        verdict, blockingIssues: strList(raw.blockingIssues), requiredChanges: strList(raw.requiredChanges),
        doNotChange: strList(raw.doNotChange), requiredEvidence: strList(raw.requiredEvidence),
        ...(raw.affectedTargetIds === undefined ? {} : { affectedTargetIds: strList(raw.affectedTargetIds) }),
        ...(raw.integrationOnly === undefined ? {} : { integrationOnly: bool(raw.integrationOnly) }),
      } satisfies ArchitectFinalResult;
    }
    case "final_report": {
      if (typeof raw.result !== "string" || typeof raw.summary !== "string") return undefined;
      return {
        result: raw.result,
        summary: raw.summary,
        delivered: strList(raw.delivered),
        architecture: strList(raw.architecture),
        reviewerFindings: strList(raw.reviewerFindings),
        validation: strList(raw.validation),
        commits: strList(raw.commits),
        endingHead: str(raw.endingHead, "unknown"),
        pushed: str(raw.pushed, "unknown"),
        humanVerification: strList(raw.humanVerification),
        warnings: strList(raw.warnings),
      } satisfies FinalReportPacket;
    }
    case "lead_escalation": {
      const verdict = raw.verdict;
      if (verdict !== "continue" && verdict !== "stop") return undefined;
      return { verdict, guidance: str(raw.guidance) } satisfies LeadEscalationPacket;
    }
  }
}

/** Extract a JSON object from a model's prose reply, tolerating fences. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // Fenced or wrapped in prose: take the first balanced {...} block.
  const start = trimmed.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/**
 * Parse a packet from either a validated structured payload or prose.
 *
 * - `structuredJson`: what the child's `StructuredOutput` tool captured
 *   (authoritative — already validated against the schema).
 * - `result`: the child's prose reply, used as a lenient fallback when the
 *   tool was never called.
 *
 * Returns the normalized packet, or undefined when nothing usable was produced.
 */
export function parsePacket(kind: PacketKind, structuredJson: string | undefined, result: string | undefined): Packet | undefined {
  if (structuredJson !== undefined) {
    try {
      const parsed = JSON.parse(structuredJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const packet = normalize(kind, parsed as Record<string, unknown>);
        if (packet) return packet;
      }
    } catch { /* fall through to prose */ }
  }
  if (result !== undefined) {
    const parsed = extractJson(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const packet = normalize(kind, parsed as Record<string, unknown>);
      if (packet) return packet;
    }
  }
  return undefined;
}

/** Parse a packet into its typed shape for the controller. */
export function parsePacketTyped<K extends PacketKind, T extends Packet>(
  kind: K,
  structuredJson: string | undefined,
  result: string | undefined,
): T | undefined {
  return parsePacket(kind, structuredJson, result) as T | undefined;
}
