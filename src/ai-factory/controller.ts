/**
 * ai-factory/controller.ts — The deterministic Factory controller.
 *
 * This is the whole point of the project: orchestration decisions are made
 * here, in code, with ZERO model calls. The controller never asks a model
 * anything. Semantic work happens inside role agents it spawns over the
 * transport; every state transition, counter check, retry/fallback choice,
 * capacity wait and restart decision below is pure deterministic logic.
 *
 * The controller is transport-agnostic (see transport.ts) so tests drive the
 * entire state machine against a fake transport with no pi session at all.
 */

import type { Clock } from "./clock.js";
import { targetsForRole } from "./config.js";
import { emptyFactoryMetrics, recordSettleMetrics } from "./metrics.js";
import { type PacketKind, packetSchema, parsePacketTyped } from "./packets.js";
import {
  architectEscalationPrompt,
  engineerPrompt,
  finalArchitectPrompt,
  initialArchitectPrompt,
  leadEscalationPrompt,
  leadIntegrationPrompt,
  leadProposalPrompt,
  reviewerPrompt,
  roleDescription,
} from "./prompts.js";
import { assertTransition, isTerminal } from "./state.js";
import type { FactoryStore } from "./store.js";
import { type AgentSettleInfo, classifyError, type FactoryTransport, type SpawnRequest } from "./transport.js";
import type {
  ArchitectInitialResult,
  FactoryConfig,
  FactoryRunState,
  LeadEscalationPacket,
  ReviewerPacket,
  RoleName,
} from "./types.js";

export interface FactoryControllerDeps {
  transport: FactoryTransport;
  clock: Clock;
  store: FactoryStore;
  config: FactoryConfig;
}

/** One spawn phase: which role, which packet schema, and the exact prompt. */
interface PhaseSpec {
  role: RoleName;
  kind: PacketKind;
  prompt: string;
}

type Action =
  | { kind: "spawn"; phase: string }
  | { kind: "retrySpawn" }
  | { kind: "transition"; to: FactoryRunState["state"]; note?: string }
  | { kind: "scheduleWake"; at: number };

/** In-memory retry/fallback bookkeeping for the current spawn attempt. */
interface PendingSpawn {
  role: RoleName;
  phase: string;
  targetIndex: number;
  retriesOnTarget: number;
  noPacketRetries: number;
  nextRetryAt?: number;
  attemptedTargets: string[];
  reasons: string[];
  /** Provider-provided retry-after, parsed from an error message when present. */
  retryAfterMs?: number;
}

const FIRST_WORK_PACKAGE = "wp-1";

export class FactoryController {
  private readonly transport: FactoryTransport;
  private readonly clock: Clock;
  private readonly store: FactoryStore;
  private readonly config: FactoryConfig;
  private readonly runId: string;
  private readonly cwd: string;
  private state: FactoryRunState;
  private pending: PendingSpawn | undefined;
  private driving = false;
  private wakeCancel: (() => void) | undefined;
  private readonly terminalResolvers = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];

  private constructor(deps: FactoryControllerDeps, state: FactoryRunState) {
    this.transport = deps.transport;
    this.clock = deps.clock;
    this.store = deps.store;
    // Prefer the run's own persisted config so a restart resumes with the same
    // role/model targets it started with, even if the project config changed.
    this.config = state.config ?? deps.config;
    this.runId = state.runId;
    this.cwd = state.cwd;
    this.state = state;
    this.unsubs.push(
      this.transport.onStarted((id) => this.onStarted(id)),
      this.transport.onCompleted((info) => this.onSettled(info, true)),
      this.transport.onFailed((info) => this.onSettled(info, false)),
    );
  }

  /** Create a brand-new run and persist its initial state. */
  static create(deps: FactoryControllerDeps, runId: string, task: string, cwd: string): FactoryController {
    const now = deps.clock.now();
    const state: FactoryRunState = {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      task,
      cwd,
      config: deps.config,
      state: "DISCOVERY",
      repairRound: 0,
      repairExhausted: false,
      effectiveArchitecture: "",
      remediationRounds: 0,
      architectEscalations: 0,
      leadEscalations: 0,
      results: { engineers: [], reviewers: [] },
      metrics: emptyFactoryMetrics(now),
      errors: [],
      parked: false,
    };
    const controller = new FactoryController(deps, state);
    controller.commit();
    return controller;
  }

  /** Restore a run from its persisted state; returns undefined if absent. */
  static restore(deps: FactoryControllerDeps, runId: string): FactoryController | undefined {
    const state = deps.store.load(runId);
    if (!state) return undefined;
    const controller = new FactoryController(deps, state);
    controller.onRestore();
    return controller;
  }

  getRunId(): string {
    return this.runId;
  }

  getState(): FactoryRunState {
    return this.state;
  }

  /** A copy of the current persisted state snapshot. */
  getSnapshot(): FactoryRunState {
    return structuredClone(this.state);
  }

  dispose(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.cancelWake();
  }

  /** Start (or resume) driving the run. */
  start(): void {
    void this.drive();
  }

  /** Wake the run — called by the (fake or real) clock when a wait is due. */
  wake(): void {
    if (isTerminal(this.state.state)) return;
    if (this.wakeCancel) {
      this.wakeCancel();
      this.wakeCancel = undefined;
    }
    void this.drive();
  }

  /** Stop the run now (user-initiated). Stops any in-flight child best-effort. */
  stop(reason: string): void {
    if (isTerminal(this.state.state)) return;
    if (this.state.inFlight) this.transport.stop(this.state.inFlight.agentId);
    this.state.inFlight = undefined;
    this.state.parked = false;
    this.state.waiting = undefined;
    this.pending = undefined;
    this.state.stoppedReason = reason;
    this.applyTransition("STOPPED");
  }

  /** Resolve with the final state when the run reaches a terminal state. */
  waitForTerminal(signal?: AbortSignal): Promise<FactoryRunState> {
    if (isTerminal(this.state.state)) return Promise.resolve(this.getSnapshot());
    return new Promise((resolve, reject) => {
      const done = (): void => resolve(this.getSnapshot());
      this.terminalResolvers.add(done);
      if (signal !== undefined) {
        if (signal.aborted) {
          this.terminalResolvers.delete(done);
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          this.terminalResolvers.delete(done);
          reject(new Error("aborted"));
        }, { once: true });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Event handling                                                     */
  /* ------------------------------------------------------------------ */

  private onStarted(agentId: string): void {
    if (!this.state.inFlight || this.state.inFlight.agentId !== agentId) return;
    const rm = this.state.metrics.roles[this.state.inFlight.role];
    rm.status = "running";
    rm.startedAt = this.clock.now();
    this.commit();
  }

  private onSettled(info: AgentSettleInfo, ok: boolean): void {
    if (!this.state.inFlight || this.state.inFlight.agentId !== info.agentId) return;
    const { role, phase } = this.state.inFlight;
    this.state.inFlight = undefined;

    // Consume synchronously so pi-subagents does not deliver this completion as
    // another notification requiring a parent model turn (docs/rpc.md).
    this.transport.consume(info.agentId);

    const rm = this.state.metrics.roles[role];
    recordSettleMetrics(rm, {
      ok,
      status: info.status,
      usage: info.usage,
      tokens: info.tokens,
      toolUses: info.toolUses,
      durationMs: info.durationMs,
      modelName: info.modelName,
      modelId: info.modelId,
      compactionCount: info.compactionCount,
      error: info.error,
      completedAt: info.completedAt,
    });
    this.commit();

    if (!ok) {
      const message = info.error ?? `agent ${info.status}`;
      this.handlePhaseFailure(phase, role, message, classifyError(message));
      return;
    }

    const kind = this.kindForPhase(phase);
    const packet = parsePacketTyped(kind, info.structuredJson, info.result);
    if (!packet) {
      // Completed but no usable packet: one same-target retry to absorb a
      // single model glitch, then surface as a hard failure.
      this.handlePhaseFailure(phase, role, "agent completed but produced no usable packet", "hard", { noPacketRetry: true });
      return;
    }

    this.storePacket(phase, role, packet, info);
    this.commit();
    void this.drive();
  }

  /* ------------------------------------------------------------------ */
  /* Deterministic decisions                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The single deterministic decision function. Returns the next action, or
   * undefined when there is nothing to do (terminal, in-flight, or parked on a
   * timer). May update bounded counters (repairRound, repairExhausted) as part
   * of deciding — never calls a model.
   */
  private nextAction(): Action | undefined {
    const s = this.state;
    if (isTerminal(s.state) || s.inFlight) return undefined;
    if (s.parked) return this.parkedAction();

    switch (s.state) {
      case "DISCOVERY":
        return s.results.proposal ? { kind: "transition", to: "INITIAL_ARCHITECT" } : { kind: "spawn", phase: "discovery.lead" };
      case "INITIAL_ARCHITECT":
        return s.results.initialArchitect ? { kind: "transition", to: "EXECUTION" } : { kind: "spawn", phase: "initial.architect" };
      case "EXECUTION": {
        if (s.repairExhausted) {
          if (s.leadEscalations < this.config.maxLeadEscalations) return { kind: "spawn", phase: "escalation.lead" };
          return { kind: "transition", to: "STOPPED", note: "repair loop exhausted after the Lead escalation budget" };
        }
        const lastEngineer = lastExecutionEngineer(s);
        if (!lastEngineer || lastEngineer.round !== s.repairRound) return { kind: "spawn", phase: "execution.engineer" };
        return { kind: "transition", to: "REVIEW" };
      }
      case "REVIEW": {
        const reviewer = lastReviewer(s);
        if (!reviewer || reviewer.round !== s.repairRound) return { kind: "spawn", phase: "review.reviewer" };
        return this.reviewTransition(reviewer.outcome.packet);
      }
      case "ARCHITECT_ESCALATION":
        return s.results.escalationArchitect ? { kind: "transition", to: "EXECUTION" } : { kind: "spawn", phase: "escalation.architect" };
      case "INTEGRATION":
        return s.results.integration ? { kind: "transition", to: "FINAL_ARCHITECT" } : { kind: "spawn", phase: "integration.lead" };
      case "FINAL_ARCHITECT": {
        if (!s.results.finalArchitect) return { kind: "spawn", phase: "final.architect" };
        if (s.results.finalArchitect.packet.verdict === "ACCEPT") return { kind: "transition", to: "DONE" };
        if (s.remediationRounds < this.config.maxArchitectRemediationRounds) {
          s.remediationRounds++;
          return { kind: "transition", to: "REMEDIATION" };
        }
        return { kind: "transition", to: "STOPPED", note: "remediation budget exhausted" };
      }
      case "REMEDIATION": {
        const rem = s.results.remediation;
        if (!rem?.engineer) return { kind: "spawn", phase: "remediation.engineer" };
        if (!rem?.reviewer) return { kind: "spawn", phase: "remediation.reviewer" };
        return { kind: "transition", to: "FINAL_ARCHITECT_RECHECK" };
      }
      case "FINAL_ARCHITECT_RECHECK": {
        if (!s.results.finalRecheck) return { kind: "spawn", phase: "final_recheck.architect" };
        return { kind: "transition", to: s.results.finalRecheck.packet.verdict === "ACCEPT" ? "DONE" : "STOPPED" };
      }
      case "WAITING_CAPACITY":
        return this.parkedAction();
      default:
        return undefined;
    }
  }

  /** Decide the review verdict's consequence — the deterministic heart of the
   * bounded Engineer/Reviewer repair loop. */
  private reviewTransition(verdict: ReviewerPacket): Action | undefined {
    const s = this.state;
    switch (verdict.verdict) {
      case "PASS":
        return { kind: "transition", to: "INTEGRATION", note: "Reviewer PASS" };
      case "NEEDS_FIX": {
        if (s.repairRound < this.config.maxRepairRounds) {
          s.repairRound++;
          return { kind: "transition", to: "EXECUTION", note: `repair round ${s.repairRound}` };
        }
        if (verdict.architecturalIssue) {
          if (s.architectEscalations < this.config.maxArchitectEscalations) {
            return { kind: "transition", to: "ARCHITECT_ESCALATION", note: "architectural issue after repair budget" };
          }
          return { kind: "transition", to: "STOPPED", note: "architectural escalation budget exhausted" };
        }
        s.repairExhausted = true;
        return { kind: "transition", to: "EXECUTION", note: "repair loop exhausted — escalate to Lead" };
      }
      case "ARCHITECTURAL_ESCALATION":
        if (s.architectEscalations < this.config.maxArchitectEscalations) {
          return { kind: "transition", to: "ARCHITECT_ESCALATION" };
        }
        return { kind: "transition", to: "STOPPED", note: "architectural escalation budget exhausted" };
    }
  }

  /** Action while parked (WAITING_CAPACITY or a backoff retry). */
  private parkedAction(): Action | undefined {
    const s = this.state;
    if (s.state === "WAITING_CAPACITY") {
      const at = s.waiting?.nextRetryAt;
      if (at === undefined || this.clock.now() >= at) {
        return { kind: "transition", to: s.waiting?.resumeState ?? s.state, note: "capacity available" };
      }
      return { kind: "scheduleWake", at };
    }
    const at = this.pending?.nextRetryAt;
    if (at !== undefined && this.clock.now() < at) return { kind: "scheduleWake", at };
    s.parked = false;
    if (this.pending) this.pending.nextRetryAt = undefined;
    return { kind: "retrySpawn" };
  }

  /* ------------------------------------------------------------------ */
  /* Spawning                                                            */
  /* ------------------------------------------------------------------ */

  private phaseSpec(phase: string): PhaseSpec {
    const s = this.state;
    switch (phase) {
      case "discovery.lead":
        return { role: "lead", kind: "proposal", prompt: leadProposalPrompt(s.task) };
      case "initial.architect":
        return { role: "architect", kind: "architect_initial", prompt: initialArchitectPrompt(s.results.proposal!.packet) };
      case "execution.engineer":
        return this.engineerSpec("execution");
      case "review.reviewer":
        return this.reviewerSpec();
      case "integration.lead":
        return {
          role: "lead",
          kind: "integration",
          prompt: leadIntegrationPrompt({
            task: s.task,
            architecture: s.effectiveArchitecture,
            engineers: s.results.engineers.map((e) => e.outcome.packet),
            reviewers: s.results.reviewers.map((r) => r.outcome.packet),
          }),
        };
      case "final.architect":
        return {
          role: "architect",
          kind: "architect_final",
          prompt: finalArchitectPrompt({ task: s.task, integration: s.results.integration!.packet }),
        };
      case "final_recheck.architect": {
        const rem = s.results.remediation;
        return {
          role: "architect",
          kind: "architect_final",
          prompt: finalArchitectPrompt({
            task: s.task,
            integration: s.results.integration!.packet,
            // Surface the actual remediation so the recheck assesses the fixed
            // system, not the pre-fix packet it already rejected.
            ...(rem?.engineer && rem.reviewer
              ? { remediation: { engineer: rem.engineer.packet, reviewer: rem.reviewer.packet } }
              : {}),
          }),
        };
      }
      case "remediation.engineer":
        return this.engineerSpec("remediation");
      case "remediation.reviewer":
        return {
          role: "reviewer",
          kind: "reviewer",
          prompt: reviewerPrompt({
            workPackageId: s.results.remediation!.engineer!.packet.workPackageId,
            engineer: s.results.remediation!.engineer!.packet,
            task: s.task,
          }),
        };
      case "escalation.architect": {
        const lastEng = lastExecutionEngineer(s);
        const lastRev = lastReviewer(s);
        const reasons: string[] = [];
        if (lastEng?.outcome.packet.architecturalEscalationRequired) reasons.push("Engineer reported architecturalEscalationRequired.");
        if (lastRev?.outcome.packet.architecturalIssue) reasons.push("Reviewer flagged an architectural issue.");
        if (reasons.length === 0) reasons.push("Architectural escalation requested by the review loop.");
        return {
          role: "architect",
          kind: "architect_initial",
          prompt: architectEscalationPrompt({
            task: s.task,
            architecture: s.effectiveArchitecture,
            reason: reasons.join(" "),
            engineering: lastEng?.outcome.packet,
            review: lastRev?.outcome.packet,
          }),
        };
      }
      case "escalation.lead":
        return {
          role: "lead",
          kind: "lead_escalation",
          prompt: leadEscalationPrompt({
            task: s.task,
            reviewer: lastReviewer(s)!.outcome.packet,
            repairRound: s.repairRound,
            maxRepairRounds: this.config.maxRepairRounds,
          }),
        };
      default:
        throw new Error(`Unknown Factory phase: ${phase}`);
    }
  }

  private engineerSpec(kind: "execution" | "remediation"): PhaseSpec {
    const s = this.state;
    const wpId = s.results.proposal?.packet.workPackages[0] ?? FIRST_WORK_PACKAGE;
    const repair = s.repairRound > 0 ? lastReviewer(s)?.outcome.packet : undefined;
    const leadEsc = s.results.leadEscalation;
    const remediation = s.results.finalArchitect?.packet;
    return {
      role: "engineer",
      kind: "engineer",
      prompt: engineerPrompt({
        workPackageId: wpId,
        architecture: s.effectiveArchitecture,
        task: s.task,
        acceptanceCriteria: s.results.proposal?.packet.acceptanceCriteria ?? [],
        constraints: s.results.proposal?.packet.constraints ?? [],
        repairFindings: kind === "execution" ? repair : undefined,
        remediationChanges: kind === "remediation" ? remediation : undefined,
        priorDecisions: leadEsc && leadEsc.packet.verdict === "continue"
          ? `Lead guidance: ${leadEsc.packet.guidance}`
          : undefined,
      }),
    };
  }

  private reviewerSpec(): PhaseSpec {
    const s = this.state;
    const engineer = lastExecutionEngineer(s)!;
    return {
      role: "reviewer",
      kind: "reviewer",
      prompt: reviewerPrompt({
        workPackageId: engineer.outcome.packet.workPackageId,
        engineer: engineer.outcome.packet,
        task: s.task,
      }),
    };
  }

  private kindForPhase(phase: string): PacketKind {
    return this.phaseSpec(phase).kind;
  }

  /**
   * Spawn the role agent for a phase over the transport (direct RPC — never
   * the model-mediated Agent tool). Returns "wait" when an agent is now
   * running (the controller stops driving), or "handled" when the attempt
   * failed and a retry/fallback/wait/fail decision was already applied.
   */
  private async performSpawn(phase: string): Promise<"wait" | "handled"> {
    const s = this.state;
    const spec = this.phaseSpec(phase);
    const targets = targetsForRole(this.config, spec.role);
    if (this.pending === undefined || this.pending.phase !== phase || this.pending.role !== spec.role) {
      this.pending = { role: spec.role, phase, targetIndex: 0, retriesOnTarget: 0, noPacketRetries: 0, attemptedTargets: [], reasons: [] };
    }
    const pending = this.pending;
    const target = targets[pending.targetIndex];
    if (target === undefined) {
      this.enterWaitingCapacity(spec.role, phase, "no eligible model target remains");
      return "handled";
    }

    const request: SpawnRequest = {
      role: spec.role,
      phase,
      agentType: this.config.agentTypes[spec.role],
      prompt: spec.prompt,
      description: roleDescription(this.runId, spec.role, phase),
      model: target,
      maxTurns: this.config.roles[spec.role].maxTurns,
      isolated: this.config.isolated,
      schema: packetSchema(spec.kind),
    };

    const rm = s.metrics.roles[spec.role];
    rm.attempts++;
    s.metrics.totalAttempts++;
    pending.attemptedTargets.push(target);
    if (!rm.targetsAttempted.includes(target)) rm.targetsAttempted.push(target);
    rm.targetUsed = target;

    const outcome = await this.transport.spawn(request);
    if (outcome.ok) {
      s.inFlight = { role: spec.role, phase, agentId: outcome.agentId, target, spawnedAt: this.clock.now() };
      rm.agentId = outcome.agentId;
      rm.startedAt = this.clock.now();
      rm.status = "running";
      this.commit();
      return "wait";
    }
    this.handlePhaseFailure(phase, spec.role, outcome.error, classifyError(outcome.error));
    return "handled";
  }

  /** Advance to the next model target, or park in WAITING_CAPACITY. */
  private advanceTarget(role: RoleName, reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    const targets = targetsForRole(this.config, role);
    const rm = this.state.metrics.roles[role];
    pending.targetIndex++;
    if (pending.targetIndex >= targets.length) {
      this.enterWaitingCapacity(role, pending.phase, reason);
      return;
    }
    pending.retriesOnTarget = 0;
    pending.noPacketRetries = 0;
    rm.fallbacks++;
    this.state.metrics.totalFallbacks++;
    this.commit();
    void this.drive();
  }

  /** Schedule a same-target transient backoff retry. */
  private scheduleRetry(role: RoleName, at: number): void {
    const pending = this.pending;
    if (!pending) return;
    pending.nextRetryAt = at;
    this.state.parked = true;
    const rm = this.state.metrics.roles[role];
    rm.retries++;
    this.state.metrics.totalRetries++;
    this.commit();
    this.scheduleWake(at);
  }

  /** Park the run in WAITING_CAPACITY until a conservative retry time. */
  private enterWaitingCapacity(role: RoleName, phase: string, reason: string): void {
    const s = this.state;
    const retryAfterMs = this.pending?.retryAfterMs;
    const nextRetryAt = this.clock.now() + (retryAfterMs ?? this.config.defaultRetryAfterMs);
    s.waiting = {
      phase,
      role,
      resumeState: s.state,
      attemptedTargets: this.pending?.attemptedTargets ?? [],
      reasons: [...(this.pending?.reasons ?? []), reason],
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      nextRetryAt,
    };
    s.metrics.capacityWaits++;
    this.pending = undefined;
    this.applyTransition("WAITING_CAPACITY");
  }

  /** Handle a failed spawn or a settled-but-unusable phase. */
  private handlePhaseFailure(
    phase: string,
    role: RoleName,
    message: string,
    klass: "transient" | "quota" | "hard",
    opts: { noPacketRetry?: boolean } = {},
  ): void {
    const s = this.state;
    const pending = this.pending;
    const roleConfig = this.config.roles[role];
    s.metrics.roles[role].error = message;
    if (pending) {
      pending.reasons.push(message);
      const retryAfter = parseRetryAfter(message);
      if (retryAfter !== undefined) pending.retryAfterMs = retryAfter;
    }

    if (opts.noPacketRetry && pending && pending.noPacketRetries < 1) {
      pending.noPacketRetries++;
      this.scheduleRetry(role, this.clock.now() + roleConfig.retryDelayMs);
      return;
    }
    if (klass === "transient" && pending && pending.retriesOnTarget < roleConfig.maxTransientRetries) {
      pending.retriesOnTarget++;
      const delay = roleConfig.retryDelayMs * 2 ** (pending.retriesOnTarget - 1);
      this.scheduleRetry(role, this.clock.now() + delay);
      return;
    }
    if (klass === "transient" || klass === "quota") {
      this.advanceTarget(role, message);
      return;
    }
    // hard — surface through Factory state; do not silently hop models.
    this.failRun(`[${phase}] ${role} failed with a hard error: ${message}`);
  }

  /** Move the run to FAILED with a structured error. */
  private failRun(error: string): void {
    if (isTerminal(this.state.state)) return;
    this.state.errors.push({ phase: this.state.inFlight?.phase ?? this.state.state, message: error, at: this.clock.now() });
    this.state.stoppedReason = error;
    this.state.parked = false;
    this.state.waiting = undefined;
    this.pending = undefined;
    this.applyTransition("FAILED");
  }

  /* ------------------------------------------------------------------ */
  /* Result storage                                                      */
  /* ------------------------------------------------------------------ */

  /** Store a settled phase packet and apply its deterministic consequences. */
  private storePacket(
    phase: string,
    _role: RoleName,
    packet: unknown,
    info: AgentSettleInfo,
  ): void {
    const s = this.state;
    const outcome = {
      packet,
      agentId: info.agentId,
      ...(info.modelName !== undefined ? { target: info.modelName } : {}),
    } as never;

    switch (phase) {
      case "discovery.lead":
        s.results.proposal = outcome;
        break;
      case "initial.architect": {
        const arch = packet as ArchitectInitialResult;
        s.results.initialArchitect = outcome;
        // APPROVE → proposal stands; CORRECT → the corrected architecture wins.
        s.effectiveArchitecture = arch.approvedArchitecture
          || (arch.verdict === "CORRECT" ? arch.correctedWorkPackages.join("\n") : s.results.proposal?.packet.proposedSolution ?? "");
        break;
      }
      case "execution.engineer":
        s.results.engineers.push({ round: s.repairRound, outcome });
        break;
      case "review.reviewer":
        s.results.reviewers.push({ round: s.repairRound, outcome });
        break;
      case "integration.lead":
        s.results.integration = outcome;
        break;
      case "final.architect":
        s.results.finalArchitect = outcome;
        break;
      case "final_recheck.architect":
        s.results.finalRecheck = outcome;
        break;
      case "remediation.engineer":
        s.results.remediation = { ...(s.results.remediation ?? {}), engineer: outcome };
        break;
      case "remediation.reviewer":
        s.results.remediation = { ...(s.results.remediation ?? {}), reviewer: outcome };
        break;
      case "escalation.architect": {
        const arch = packet as ArchitectInitialResult;
        s.architectEscalations++;
        s.effectiveArchitecture = arch.approvedArchitecture
          || (arch.verdict === "CORRECT" ? arch.correctedWorkPackages.join("\n") : s.effectiveArchitecture);
        s.repairExhausted = false;
        s.repairRound = 0;
        s.results.escalationArchitect = outcome;
        break;
      }
      case "escalation.lead": {
        const esc = packet as LeadEscalationPacket;
        s.leadEscalations++;
        s.results.leadEscalation = outcome;
        if (esc.verdict === "stop") {
          s.stoppedReason = "Lead decided to stop after the repair loop was exhausted.";
          this.applyTransition("STOPPED");
          return;
        }
        s.repairExhausted = false;
        s.repairRound = 0;
        break;
      }
      default:
        throw new Error(`Unknown Factory phase: ${phase}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Driving, persistence, restore                                      */
  /* ------------------------------------------------------------------ */

  private async drive(): Promise<void> {
    if (this.driving || isTerminal(this.state.state)) return;
    this.driving = true;
    try {
      for (;;) {
        const action = this.nextAction();
        if (action === undefined) break;
        if (action.kind === "transition") {
          this.applyTransition(action.to, action.note);
          if (isTerminal(this.state.state)) break;
          continue;
        }
        if (action.kind === "spawn") {
          const result = await this.performSpawn(action.phase);
          if (result === "wait" || isTerminal(this.state.state) || this.state.parked) break;
          continue;
        }
        if (action.kind === "retrySpawn") {
          const phase = this.pending?.phase;
          if (phase === undefined) break;
          const result = await this.performSpawn(phase);
          if (result === "wait" || isTerminal(this.state.state) || this.state.parked) break;
          continue;
        }
        if (action.kind === "scheduleWake") {
          this.scheduleWake(action.at);
          break;
        }
      }
    } finally {
      this.driving = false;
    }
  }

  private applyTransition(to: FactoryRunState["state"], _note?: string): void {
    const from = this.state.state;
    assertTransition(from, to);
    if (from === "WAITING_CAPACITY") {
      this.state.waiting = undefined;
      this.state.parked = false;
      this.pending = undefined;
    }
    this.state.state = to;
    this.state.updatedAt = this.clock.now();
    if (isTerminal(to)) {
      this.state.metrics.runEndedAt = this.clock.now();
      this.state.metrics.runDurationMs = this.state.metrics.runEndedAt - this.state.metrics.runStartedAt;
      this.cancelWake();
      for (const r of this.terminalResolvers) r();
      this.terminalResolvers.clear();
    }
    this.commit();
  }

  private scheduleWake(at: number): void {
    if (this.wakeCancel) this.wakeCancel();
    const delay = Math.max(0, at - this.clock.now());
    this.wakeCancel = this.clock.setTimeout(() => {
      this.wakeCancel = undefined;
      this.wake();
    }, delay);
  }

  private cancelWake(): void {
    if (this.wakeCancel) {
      this.wakeCancel();
      this.wakeCancel = undefined;
    }
  }

  /** Persist the current state. */
  private commit(): void {
    this.state.updatedAt = this.clock.now();
    this.store.save(this.state);
  }

  /**
   * Recover after a process restart. Completed phases stay completed (their
   * packets are in the store); only a phase that was mid-flight or parked is
   * resumed. A mid-flight agent cannot have survived the process death (agents
   * are in-process), so it is treated as a failed attempt and retried
   * deterministically — never re-running a completed phase.
   */
  private onRestore(): void {
    const s = this.state;
    if (isTerminal(s.state)) return;

    if (s.inFlight) {
      const { role, phase } = s.inFlight;
      const rm = s.metrics.roles[role];
      rm.status = "failed";
      rm.error = "agent lost on process restart — re-attempting the phase";
      s.inFlight = undefined;
      this.pending = { role, phase, targetIndex: 0, retriesOnTarget: 0, noPacketRetries: 0, attemptedTargets: [], reasons: [] };
      this.commit();
      void this.drive();
      return;
    }

    if (s.state === "WAITING_CAPACITY" && s.waiting) {
      this.pending = { role: s.waiting.role, phase: s.waiting.phase, targetIndex: 0, retriesOnTarget: 0, noPacketRetries: 0, attemptedTargets: [], reasons: [] };
      // `parked` is already true; parkedAction() decides between wait and retry.
      this.scheduleWake(s.waiting.nextRetryAt);
      return;
    }

    // A run parked on an in-memory transient backoff (parked, but not
    // WAITING_CAPACITY) lost its retry bookkeeping with the process. Clear the
    // park so the state's own next action re-attempts the phase from a fresh
    // spawn — otherwise parkedAction() finds no pending and deadlocks.
    if (s.parked) {
      s.parked = false;
      this.pending = undefined;
    }

    void this.drive();
  }
}

/* ------------------------------------------------------------------ */

function lastExecutionEngineer(s: FactoryRunState) {
  const engineers = s.results.engineers;
  return engineers[engineers.length - 1];
}

function lastReviewer(s: FactoryRunState) {
  const reviewers = s.results.reviewers;
  return reviewers[reviewers.length - 1];
}

/**
 * Extract a provider retry-after (seconds) from an error message, when the
 * provider includes one. Provider-neutral: matches common spellings.
 */
function parseRetryAfter(message: string): number | undefined {
  const match = /retry[- ]?after(?:=|:)\s*(\d+)/i.exec(message);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
