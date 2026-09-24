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
import { configRevision, replacementConfig, targetsForRole } from "./config.js";
import { FactoryLeaseError } from "./lease.js";
import { appendCallMetric, emptyFactoryMetrics, recordSettleMetrics } from "./metrics.js";
import { type PacketKind, packetSchema, parsePacketTyped } from "./packets.js";
import {
  architectEscalationPrompt,
  engineerPrompt,
  finalArchitectPrompt,
  finalReportPrompt,
  initialArchitectPrompt,
  leadEscalationPrompt,
  leadIntegrationPrompt,
  leadProposalPrompt,
  reviewerPrompt,
  roleDescription,
} from "./prompts.js";
import { createFactoryCheckpoint, hasPersistedAttemptPacket, latestAttemptForPhase, unresolvedAttemptForPhase } from "./recovery-model.js";
import { assertTransition, assessRecoveryEligibility, isTerminal } from "./state.js";
import type { FactoryStore } from "./store.js";
import { blockFailedDependencies, createTargetPlan, dependentsInOrder, nextEligibleTarget, TARGET_ID, validateArchitectTargetApproval, validateTargets } from "./targets.js";
import { type AgentSettleInfo, classifyError, type FactoryTransport, type SpawnRequest } from "./transport.js";
import {
  type ArchitectInitialResult,
  FACTORY_STATE_VERSION,
  type FactoryAttempt,
  type FactoryConfig,
  type FactoryRecoveryEligibility,
  type FactoryResumeResult,
  type FactoryRunState,
  type FactoryTarget,
  type LeadEscalationPacket,
  type LeadIntegrationPacket,
  type ReviewerOutcome,
  type ReviewerPacket,
  ROLE_NAMES,
  type RoleName,
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
  attemptId?: string;
  /** Provider-provided retry-after, parsed from an error message when present. */
  retryAfterMs?: number;
}

const FIRST_WORK_PACKAGE = "wp-1";

export class FactoryController {
  private readonly transport: FactoryTransport;
  private readonly clock: Clock;
  private readonly store: FactoryStore;
  private config: FactoryConfig;
  private readonly runId: string;
  private readonly cwd: string;
  /** Task 2 fencing token binding every commit to exclusive ownership. */
  private leaseToken: string | undefined;
  /** True once a fenced commit was rejected: the controller no longer owns the
   * run and must stop driving and mutating (inert). */
  private ownershipLost = false;
  /** Why lease release was refused on dispose, when it was. */
  private releaseBlockedReason: string | undefined;
  /** True once dispose() ran: the controller must not act further. */
  private disposed = false;
  /** True after an explicit approval consumed an interrupted Engineer phase:
   * the next Engineer spawn carries a resume instruction. Consumed once. */
  private resumeApproved = false;
  /** Settlements that arrived while a spawn RPC was pending (Task 3): keyed by
   * child agent id, drained exactly once when the spawn resolves. */
  private readonly earlySettlements = new Map<string, { info: AgentSettleInfo; ok: boolean }>();
  private state: FactoryRunState;
  private pending: PendingSpawn | undefined;
  private driving = false;
  private wakeCancel: (() => void) | undefined;
  private readonly terminalResolvers = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];

  private constructor(deps: FactoryControllerDeps, state: FactoryRunState, leaseToken?: string) {
    this.transport = deps.transport;
    this.clock = deps.clock;
    this.store = deps.store;
    this.leaseToken = leaseToken;
    // Prefer the run's own persisted config so a restart resumes with the same
    // role/model targets it started with, even if the project config changed.
    // A validated preset replacement (if one was applied) is the effective
    // configuration for FUTURE children; the original `state.config` stays as
    // audit history.
    this.config = state.presetReplacement?.snapshot ?? state.config ?? deps.config;
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
    // Exclusive ownership first: a lease-backed store throws FactoryLeaseError
    // when another live owner holds the run, so no state is created or written
    // by a losing contender.
    const leaseToken = deps.store.acquireLease(runId);
    const now = deps.clock.now();
    const state: FactoryRunState = {
      version: FACTORY_STATE_VERSION,
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
      stateRevision: 0,
      attempts: [],
    };
    const controller = new FactoryController(deps, state, leaseToken);
    controller.commit();
    return controller;
  }

  /**
   * Restore a run from its persisted state; returns undefined if absent.
   *
   * On a lease-backed store the lease must be acquired first: a run owned by a
   * live process elsewhere is never restored into a driving controller, so the
   * existing in-process `controllers` map remains a cache, never the ownership
   * authority.
   *
   * `resume: false` loads the controller without driving it — used by
   * `/factory-stop`, where resuming first would (briefly) spawn a role agent
   * before the stop lands. Default behavior resumes.
   */
  static restore(deps: FactoryControllerDeps, runId: string, opts: { resume?: boolean } = {}): FactoryController | undefined {
    const state = deps.store.load(runId);
    if (!state) return undefined;
    const leaseToken = deps.store.tryAcquireLease(runId);
    if (deps.store.isLeaseBacked() && leaseToken === undefined) {
      // Another live owner holds the run or reclamation was conservatively
      // refused. Never construct a controller that could drive it.
      return undefined;
    }
    const controller = new FactoryController(deps, state, leaseToken);
    if (opts.resume !== false) controller.onRestore();
    return controller;
  }

  getRunId(): string {
    return this.runId;
  }

  /** Whether this controller still holds a valid lease and may drive. */
  hasOwnership(): boolean {
    return this.leaseToken !== undefined && !this.ownershipLost;
  }

  /** Why lease release was refused on dispose, when it was refused. */
  getReleaseBlockedReason(): string | undefined {
    return this.releaseBlockedReason;
  }

  getState(): FactoryRunState {
    return this.state;
  }

  /** A copy of the current persisted state snapshot. */
  getSnapshot(): FactoryRunState {
    return structuredClone(this.state);
  }

  /** Read-only recovery eligibility assessment for the current run state. */
  getRecoveryEligibility(): FactoryRecoveryEligibility {
    return assessRecoveryEligibility(this.state);
  }

  /**
   * Explicitly resume a persisted run at a clean checkpoint or WAITING_CAPACITY.
   *
   * Rejects terminal runs (DONE / STOPPED / FAILED), duplicate resume attempts
   * while already driving or with an active child, and runs that require user
   * approval (e.g. interrupted Engineer phases with partial workspace changes).
   *
   * Does not implement automatic replay of interrupted Engineer phases or
   * partially modified workspaces — those require explicit user approval first.
   */
  resume(): FactoryResumeResult {
    // 0. A disposed controller cannot act.
    if (this.disposed) {
      return { kind: "duplicate" };
    }
    // 1. Reject if the drive loop is currently executing.
    if (this.driving) {
      return { kind: "duplicate" };
    }

    // 2. Read-only liveness probe: if a child is still live, it owns the run.
    //    No mutation — onRestore() is NOT called here.
    if (this.state.inFlight !== undefined) {
      const status = this.transport.agentStatus(this.state.inFlight.agentId);
      if (status === "running" || status === "queued") {
        return { kind: "duplicate" };
      }
    }

    // 3. Eligibility check (read-only, no mutation).
    const eligibility = this.getRecoveryEligibility();
    if (!eligibility.eligible) {
      return { kind: "terminal", reason: eligibility.reason };
    }

    // 4. Approval check (read-only, no mutation).
    if (eligibility.requiresApproval) {
      return { kind: "approvalRequired", reason: eligibility.reason };
    }

    // 5. Eligible, no approval needed — run onRestore() to reconcile state.
    //    For a lost agent (absent/terminal child), this clears inFlight and
    //    re-spawns. For WAITING_CAPACITY, it schedules the wake.
    this.onRestore();
    return { kind: "ok", state: this.state.state };
  }

  /**
   * Resume a run that requires explicit approval, using a checkpoint-bound token.
   *
   * The `checkpointId` must match the run's current checkpoint (from
   * `getRecoveryEligibility().checkpointId`). If the run has advanced since the
   * token was issued, the approval is stale and rejected.
   *
   * This does NOT assert the workspace is clean — it only authorizes replay of
   * the specific interrupted phase identified by the checkpoint. The caller is
   * responsible for inspecting the workspace before approving.
   */
  resumeWithApproval(checkpointId: string): FactoryResumeResult {
    // 0. A disposed controller cannot act.
    if (this.disposed) return { kind: "duplicate" };
    // 1. Reject if driving.
    if (this.driving) return { kind: "duplicate" };

    // 2. Liveness probe: live child owns the run.
    if (this.state.inFlight !== undefined) {
      const status = this.transport.agentStatus(this.state.inFlight.agentId);
      if (status === "running" || status === "queued") {
        return { kind: "duplicate" };
      }
    }

    // 3. Eligibility check.
    const eligibility = this.getRecoveryEligibility();
    if (!eligibility.eligible) {
      return { kind: "terminal", reason: eligibility.reason };
    }

    // 4. Validate the checkpoint token.
    if (checkpointId !== eligibility.checkpointId) {
      return { kind: "staleApproval", reason: `Checkpoint changed: expected "${eligibility.checkpointId}", got "${checkpointId}"` };
    }

    // 5. Consume the approval. The interrupted in-flight child (lost on
    //    process death / session switch) is relinquished so the phase is
    //    re-attempted exactly ONCE with a fresh attempt; the guards that would
    //    block the replay (unresolved provenance, failed Engineer) are bypassed
    //    once via `resumeApproved`. The next commit advances the checkpoint, so
    //    a second or stale approval can never authorize another attempt.
    this.resumeApproved = true;
    if (this.state.inFlight !== undefined) {
      this.state.inFlight = undefined;
      this.state.parked = false;
      this.pending = undefined;
      this.commit();
    }
    this.onRestore();
    return { kind: "ok", state: this.state.state };
  }

  /**
   * Replace the effective configuration for FUTURE children with a validated
   * preset. The original run config is preserved as history (state.config); the
   * replacement snapshot and revision are persisted so a later restore resumes
   * with the same effective config. Only role targets, fallbacks, retry
   * settings, and turn limits change; workflow budgets, isolation policy, and
   * agent types are preserved, and no live child's model is changed.
   */
  applyPresetReplacement(name: string, presetConfig: FactoryConfig): void {
    this.config = replacementConfig(this.config, presetConfig);
    this.state.presetReplacement = {
      preset: name,
      snapshot: this.config,
      appliedAt: this.clock.now(),
      revision: this.state.stateRevision ?? 0,
    };
    this.commit();
  }

  dispose(): void {
    this.disposed = true;
    this.earlySettlements.clear();
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.cancelWake();
    this.releaseOwnership();
  }

  /**
   * Release the run lease only when ownership has been safely relinquished.
   *
   * A lease is never released while an unresolved spawn may still create a
   * child (an in-flight agent) or while the drive loop is mid-turn — another
   * owner must not take over a run whose child could still touch the workspace.
   * Such leases are reclaimed only after this process dies (same-host
   * reclamation) or taken over by a later in-process restore. Full late-spawn
   * cleanup is Task 3 scope (docs/ownership.md).
   */
  private releaseOwnership(): void {
    if (this.leaseToken === undefined) return;
    if (this.ownershipLost) {
      this.releaseBlockedReason = "ownership was lost (fenced out)";
      return;
    }
    if (this.driving) {
      this.releaseBlockedReason = "the drive loop is mid-turn";
      return;
    }
    // B2: a lease is never released while a child may still modify the
    // workspace. An in-flight agent OR any registry-tracked outstanding
    // spawn/child activity retains ownership — a best-effort stop request is
    // not proof that a child terminated.
    if (this.state.inFlight !== undefined) {
      this.releaseBlockedReason = "an in-flight agent is still live";
      return;
    }
    if (this.store.hasOutstandingActivity(this.runId, this.leaseToken)) {
      this.releaseBlockedReason = "outstanding child or unresolved spawn activity";
      return;
    }
    this.releaseBlockedReason = undefined;
    this.store.releaseLease(this.runId, this.leaseToken);
    this.leaseToken = undefined;
  }

  /** Start (or resume) driving the run. */
  start(): void {
    void this.drive();
  }

  /** Wake the run — called by the (fake or real) clock when a wait is due. */
  wake(): void {
    if (this.disposed || isTerminal(this.state.state)) return;
    if (this.wakeCancel) {
      this.wakeCancel();
      this.wakeCancel = undefined;
    }
    void this.drive();
  }

  /** Stop the run now (user-initiated). Stops any in-flight child best-effort. */
  stop(reason: string): void {
    if (this.disposed || this.ownershipLost || isTerminal(this.state.state)) return;
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
    if (this.disposed || this.ownershipLost) return;
    if (!this.state.inFlight || this.state.inFlight.agentId !== agentId) return;
    const rm = this.state.metrics.roles[this.state.inFlight.role];
    rm.status = "running";
    rm.startedAt = this.clock.now();
    this.commit();
  }

  /**
   * Child settlement dispatch (Task 3). Always accounts for the settle in the
   * ownership registry (termination is independently confirmed even when
   * inFlight was cleared, e.g. after stop()). A settlement for the current
   * in-flight child is processed; one that arrives while a spawn RPC is still
   * pending (inFlight not yet persisted) is buffered so it is not lost;
   * anything else is ignored. Disposed or non-owning controllers only account
   * the registry — they never advance on settle events.
   */
  private onSettled(info: AgentSettleInfo, ok: boolean): void {
    this.store.endChild(this.runId, this.leaseToken, info.agentId);
    if (this.disposed || this.ownershipLost) return;
    if (this.state.inFlight !== undefined && this.state.inFlight.agentId === info.agentId) {
      this.processSettled(info, ok);
      return;
    }
    if (this.pending !== undefined && this.state.inFlight === undefined) {
      // A child may have settled before its spawn RPC returned. Buffer it;
      // performSpawn imports it exactly once once the spawn resolves.
      this.earlySettlements.set(info.agentId, { info, ok });
    }
  }

  /** Process a settlement for the current in-flight child exactly once. */
  private processSettled(info: AgentSettleInfo, ok: boolean): void {
    // Registry accounting idempotent with the onSettled call: the direct path
    // already decremented; the buffered path decrements here (childSpawned ran
    // between the buffer write and the drain).
    this.store.endChild(this.runId, this.leaseToken, info.agentId);
    const { role, phase, target } = this.state.inFlight!;
    this.state.inFlight = undefined;
    const attempt = this.state.attempts?.find((candidate) => candidate.agentId === info.agentId);
    if (attempt) {
      attempt.settledAt = this.clock.now();
      attempt.provenance = "settled_without_valid_packet";
      attempt.recoveryRisk = role === "engineer" ? "workspace_may_have_changed" : "uncertain_outcome";
      attempt.packetValidated = false;
    }

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
    // Append-only per-call telemetry, so /factory-metrics can total honestly
    // instead of only seeing the last settle per role.
    appendCallMetric(this.state.metrics, {
      role,
      phase,
      agentId: info.agentId,
      target,
      ok,
      status: info.status,
      usage: info.usage,
      tokens: info.tokens,
      toolUses: info.toolUses,
      durationMs: info.durationMs,
      modelName: info.modelName,
      modelId: info.modelId,
      compactionCount: info.compactionCount,
      completedAt: info.completedAt,
    });
    this.commit();

    if (!ok) {
      this.commit();
      const message = info.error ?? `agent ${info.status}`;
      this.handlePhaseFailure(phase, role, message, classifyError(message), { childStarted: true });
      return;
    }

    const kind = this.kindForPhase(phase);
    const packet = parsePacketTyped(kind, info.structuredJson, info.result);
    if (!packet) {
      this.commit();
      // Completed but no usable packet: one same-target retry to absorb a
      // single model glitch, then surface as a hard failure. Engineer phases
      // never take that retry — the child started and may have changed files.
      this.handlePhaseFailure(phase, role, "agent completed but produced no usable packet", "hard", { noPacketRetry: true, childStarted: true });
      return;
    }

    // Store the packet before marking the attempt validated. If packet storage
    // itself terminally rejects the result, its commit retains the fail-closed
    // settled_without_valid_packet provenance instead of claiming a missing packet.
    this.storePacket(phase, role, packet, info);
    if (attempt && !isTerminal(this.state.state)) {
      attempt.provenance = "settled_validated_packet";
      attempt.recoveryRisk = "validated_packet";
      attempt.packetValidated = true;
    }
    // Packet and validated provenance become durable in one atomic snapshot.
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
    if (this.disposed || this.ownershipLost) return undefined;
    // A failed Engineer attempt with possible workspace impact never auto-
    // replays: the run stays in the phase awaiting explicit approval. An
    // explicitly approved resume bypasses this once (resumeApproved is
    // consumed by the next performSpawn).
    if (engineerSpawnBlocked(s) && !this.resumeApproved) return undefined;
    if (isTerminal(s.state) || s.inFlight) return undefined;
    if (s.parked) return this.parkedAction();

    switch (s.state) {
      case "DISCOVERY":
        return s.results.proposal ? { kind: "transition", to: "INITIAL_ARCHITECT" } : { kind: "spawn", phase: "discovery.lead" };
      case "INITIAL_ARCHITECT":
        if (!s.results.initialArchitect) return { kind: "spawn", phase: "initial.architect" };
        if (s.results.initialArchitect.packet.verdict === "CLARIFY" || (s.version === 3 && !s.targetPlan)) {
          return { kind: "transition", to: "STOPPED", note: s.stoppedReason ?? "Approved executable target plan unavailable; clarification required" };
        }
        return { kind: "transition", to: "EXECUTION" };
      case "EXECUTION": {
        if (s.targetPlan) {
          const plan = s.targetPlan;
          blockFailedDependencies(plan);
          if (!plan.currentTargetId) {
            const next = nextEligibleTarget(plan);
            if (!next) {
              if (plan.targets.every((target) => plan.outcomes[target.id].status === "passed")) return { kind: "transition", to: "INTEGRATION" };
              return { kind: "transition", to: "STOPPED", note: "Execution ended with failed, blocked or unresolved targets; mission not accepted" };
            }
            plan.currentTargetId = next.id;
            plan.outcomes[next.id] = { status: "active" };
            s.repairRound = 0;
            s.repairExhausted = false;
            s.results.leadEscalation = undefined;
            s.results.escalationArchitect = undefined;
          }
        }
        if (s.repairExhausted) {
          if (s.leadEscalations < this.config.maxLeadEscalations) return { kind: "spawn", phase: "escalation.lead" };
          return this.failTargetOrStop("repair loop exhausted after the Lead escalation budget");
        }
        const lastEngineer = lastExecutionEngineer(s);
        if (!lastEngineer || lastEngineer.round !== s.repairRound) return { kind: "spawn", phase: "execution.engineer" };
        return { kind: "transition", to: "REVIEW" };
      }
      case "REVIEW": {
        const reviewer = lastReviewer(s);
        if (!reviewer || reviewer.round !== s.repairRound || (s.targetPlan?.revalidationIds?.includes(s.targetPlan.currentTargetId ?? "") && reviewer.outcome.agentId === s.targetPlan.outcomes[s.targetPlan.currentTargetId!].reviewerAgentId)) return { kind: "spawn", phase: "review.reviewer" };
        if (s.targetPlan?.revalidationIds?.includes(s.targetPlan.currentTargetId ?? "") && reviewer.outcome.packet.verdict === "PASS") {
          const plan = s.targetPlan;
          const id = plan.currentTargetId!;
          plan.outcomes[id] = { ...plan.outcomes[id], status: "passed", reviewerAgentId: reviewer.outcome.agentId, reason: "Revalidated after scoped remediation" };
          plan.revalidationIds!.shift();
          if (plan.revalidationIds!.length === 0) {
            plan.revalidationIds = undefined;
            plan.currentTargetId = undefined;
            if (!plan.targets.every((target) => plan.outcomes[target.id].status === "passed")) {
              return { kind: "transition", to: "STOPPED", note: "Revalidation completed with failed or blocked targets; mission not accepted" };
            }
            return { kind: "transition", to: "FINAL_ARCHITECT_RECHECK", note: "All affected dependents revalidated" };
          }
          plan.currentTargetId = plan.revalidationIds![0];
          plan.outcomes[plan.currentTargetId].status = "active";
          s.repairRound = 0;
          return { kind: "transition", to: "REVIEW", note: `Revalidating dependent ${plan.currentTargetId}` };
        }
        if (s.targetPlan && reviewer.outcome.packet.verdict === "PASS") {
          const engineer = lastExecutionEngineer(s);
          const id = s.targetPlan.currentTargetId!;
          if (engineer?.outcome.packet.status !== "completed") {
            s.targetPlan.outcomes[id] = { status: "failed", reason: `Engineer reported ${engineer?.outcome.packet.status ?? "no result"}`, engineerAgentId: engineer?.outcome.agentId, reviewerAgentId: reviewer.outcome.agentId };
            s.targetPlan.currentTargetId = undefined;
            return { kind: "transition", to: "EXECUTION", note: `Target ${id} did not complete` };
          }
          const target = s.targetPlan.targets.find((item) => item.id === id)!;
          s.targetPlan.outcomes[id] = { status: "passed", engineerAgentId: engineer.outcome.agentId, reviewerAgentId: reviewer.outcome.agentId };
          if (target.requiresArchitectAcceptance || engineer.outcome.packet.architecturalEscalationRequired) {
            if (s.architectEscalations >= this.config.maxArchitectEscalations) return this.failTargetOrStop(`Architect assessment allowance exhausted for ${id}`);
            s.targetPlan.awaitingArchitectAcceptance = true;
            return { kind: "transition", to: "ARCHITECT_ESCALATION", note: `Target ${id} requires Architect assessment` };
          }
          s.targetPlan.currentTargetId = undefined;
          blockFailedDependencies(s.targetPlan);
          return { kind: "transition", to: s.targetPlan.targets.every((item) => s.targetPlan!.outcomes[item.id].status === "passed") ? "INTEGRATION" : "EXECUTION", note: `Reviewer PASS for ${id}` };
        }
        return this.reviewTransition(reviewer.outcome.packet);
      }
      case "ARCHITECT_ESCALATION":
        return s.results.escalationArchitect ? { kind: "transition", to: "EXECUTION" } : { kind: "spawn", phase: "escalation.architect" };
      case "INTEGRATION":
        return s.results.integration ? { kind: "transition", to: "FINAL_ARCHITECT" } : { kind: "spawn", phase: "integration.lead" };
      case "FINAL_ARCHITECT": {
        if (s.targetPlan && !s.targetPlan.targets.every((target) => s.targetPlan!.outcomes[target.id].status === "passed")) return { kind: "transition", to: "STOPPED", note: "Mission cannot be accepted with unfinished targets" };
        if (!s.results.finalArchitect) return { kind: "spawn", phase: "final.architect" };
        // ACCEPT never goes straight to DONE: every accepted run must pass
        // through exactly one bounded final Lead synthesis first.
        if (s.results.finalArchitect.packet.verdict === "ACCEPT") return { kind: "transition", to: "FINAL_SYNTHESIS" };
        if (s.remediationRounds < this.config.maxArchitectRemediationRounds) {
          if (s.targetPlan && s.targetPlan.targets.length > 1) {
            const verdict = s.results.finalArchitect.packet;
            const ids = verdict.affectedTargetIds ?? [];
            if ((!verdict.integrationOnly && (ids.length !== 1 || !s.targetPlan.outcomes[ids[0]] || s.targetPlan.outcomes[ids[0]].status !== "passed"))
              || (verdict.integrationOnly && ids.length > 0)) return { kind: "transition", to: "STOPPED", note: "Final Architect rejection has no safe, unique target or integration correction scope" };
            if (ids.length === 1) {
              if ([s.targetPlan.targets.find((target) => target.id === ids[0])!, ...dependentsInOrder(s.targetPlan, ids[0])].some((target) => target.requiresArchitectAcceptance)) return { kind: "transition", to: "STOPPED", note: "Scoped correction affects a target requiring renewed Architect acceptance; cannot safely revalidate automatically" };
            }
          }
          s.remediationRounds++;
          return { kind: "transition", to: "REMEDIATION" };
        }
        return { kind: "transition", to: "STOPPED", note: "remediation budget exhausted" };
      }
      case "REMEDIATION": {
        const rem = s.results.remediation;
        if (!rem?.engineer) return { kind: "spawn", phase: "remediation.engineer" };
        if (!rem?.reviewer) return { kind: "spawn", phase: "remediation.reviewer" };
        if (rem.engineer.packet.status !== "completed" || rem.reviewer.packet.verdict !== "PASS") {
          return this.failRemediation("Remediation was not completed and Reviewer-approved");
        }
        if (s.targetPlan && s.targetPlan.targets.length > 1 && !s.results.finalRecheck) {
          const id = s.results.finalArchitect?.packet.affectedTargetIds?.[0];
          if (id) {
            const plan = s.targetPlan;
            const descendants = dependentsInOrder(plan, id);
            const dependents = descendants.filter((target) => plan.outcomes[target.id].status === "passed").map((target) => target.id);
            if ([plan.targets.find((target) => target.id === id)!, ...descendants].some((target) => target.requiresArchitectAcceptance)) return this.failRemediation("Scoped correction affects a target requiring renewed Architect acceptance; cannot safely revalidate automatically");
            if (rem.engineer.packet.workPackageId !== id) return this.failRemediation(`Remediation packet did not match target ${id}`);
            plan.outcomes[id] = { status: "passed", engineerAgentId: rem.engineer.agentId, reviewerAgentId: rem.reviewer.agentId, reason: "Scoped remediation Reviewer PASS" };
            if (dependents.length > 0) {
              plan.revalidationIds = dependents;
              plan.currentTargetId = dependents[0];
              plan.outcomes[dependents[0]].status = "active";
              s.repairRound = 0;
              return { kind: "transition", to: "REVIEW", note: `Revalidate ${dependents.join(", ")} after ${id} remediation` };
            }
            plan.currentTargetId = undefined;
          } else if (rem.engineer.packet.workPackageId !== "integration") return this.failRemediation("Integration-only remediation packet had an unexpected scope");
        }
        return { kind: "transition", to: "FINAL_ARCHITECT_RECHECK" };
      }
      case "FINAL_ARCHITECT_RECHECK": {
        if (s.targetPlan && (s.targetPlan.revalidationIds?.length || !s.targetPlan.targets.every((target) => s.targetPlan!.outcomes[target.id].status === "passed"))) return { kind: "transition", to: "STOPPED", note: "Corrected targets still require validation before final recheck" };
        if (!s.results.finalRecheck) return { kind: "spawn", phase: "final_recheck.architect" };
        return s.results.finalRecheck.packet.verdict === "ACCEPT"
          ? { kind: "transition", to: "FINAL_SYNTHESIS" }
          : {
              kind: "transition",
              to: "STOPPED",
              note: `Final Architect recheck returned NEEDS_REMEDIATION after the remediation allowance reached ${s.remediationRounds}/${this.config.maxArchitectRemediationRounds}.`,
            };
      }
      case "FINAL_SYNTHESIS":
        if (s.targetPlan && (s.targetPlan.revalidationIds?.length || !s.targetPlan.targets.every((target) => s.targetPlan!.outcomes[target.id].status === "passed"))) return { kind: "transition", to: "STOPPED", note: "Final synthesis cannot accept unfinished targets" };
        // The accepted state gets one bounded Lead synthesis, then DONE. The
        // presence of the persisted packet is the deterministic completion
        // signal; the synthesis can never send the run back into remediation.
        return s.results.finalReport ? { kind: "transition", to: "DONE" } : { kind: "spawn", phase: "final_synthesis.lead" };
      case "WAITING_CAPACITY":
        return this.parkedAction();
      default:
        return undefined;
    }
  }

  /** Mark a single exhausted target without discarding independent work. */
  private failTargetOrStop(reason: string): { kind: "transition"; to: FactoryRunState["state"]; note: string } {
    const plan = this.state.targetPlan;
    const id = plan?.currentTargetId;
    if (!plan || !id) return { kind: "transition", to: "STOPPED", note: reason };
    const engineer = lastExecutionEngineer(this.state);
    const reviewer = lastReviewer(this.state);
    plan.outcomes[id] = {
      status: "failed", reason,
      ...(engineer ? { engineerAgentId: engineer.outcome.agentId } : {}),
      ...(reviewer ? { reviewerAgentId: reviewer.outcome.agentId } : {}),
    };
    const revalidationQueue = plan.revalidationIds;
    if (revalidationQueue?.length) {
      const descendants = new Set(dependentsInOrder(plan, id).map((target) => target.id));
      const blocked = new Set(revalidationQueue.filter((targetId) => descendants.has(targetId)));
      for (const dependent of blocked) {
        plan.outcomes[dependent] = { status: "blocked", blockedBy: [id], reason: `Revalidation cannot complete after prerequisite ${id} failed` };
      }
      const remaining = revalidationQueue.filter((targetId) => targetId !== id && !blocked.has(targetId));
      plan.revalidationIds = remaining.length > 0 ? remaining : undefined;
      plan.currentTargetId = remaining[0];
      if (plan.currentTargetId) {
        plan.outcomes[plan.currentTargetId].status = "active";
        this.state.repairRound = 0;
        blockFailedDependencies(plan);
        return { kind: "transition", to: "REVIEW", note: `Target ${id} failed revalidation; continuing independent targets` };
      }
      blockFailedDependencies(plan);
      return { kind: "transition", to: "STOPPED", note: `Target ${id} failed revalidation: ${reason}` };
    }
    plan.currentTargetId = undefined;
    blockFailedDependencies(plan);
    return { kind: "transition", to: "EXECUTION", note: `Target ${id} failed: ${reason}` };
  }

  /** Invalidate stale target PASS evidence when scoped remediation fails. */
  private failRemediation(reason: string): Action {
    const plan = this.state.targetPlan;
    const id = this.state.results.finalArchitect?.packet.affectedTargetIds?.[0]
      ?? plan?.currentTargetId
      ?? (plan?.targets.length === 1 ? plan.targets[0].id : undefined);
    if (plan && id && plan.outcomes[id]) {
      plan.outcomes[id] = { status: "failed", reason: `Scoped remediation failed: ${reason}` };
      for (const dependent of dependentsInOrder(plan, id)) {
        if (plan.outcomes[dependent.id].status === "passed") {
          plan.outcomes[dependent.id] = { status: "blocked", blockedBy: [id], reason: `Upstream target ${id} remediation failed` };
        }
      }
      plan.currentTargetId = undefined;
      plan.revalidationIds = undefined;
    }
    return { kind: "transition", to: "STOPPED", note: reason };
  }

  /** Decide the review verdict's consequence — the bounded target-local repair loop. */
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
          return this.failTargetOrStop("architectural escalation budget exhausted");
        }
        s.repairExhausted = true;
        return { kind: "transition", to: "EXECUTION", note: "repair loop exhausted — escalate to Lead" };
      }
      case "ARCHITECTURAL_ESCALATION":
        if (s.architectEscalations < this.config.maxArchitectEscalations) {
          return { kind: "transition", to: "ARCHITECT_ESCALATION" };
        }
        return this.failTargetOrStop("architectural escalation budget exhausted");
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

  private phaseSpec(phase: string, resumeNote?: string): PhaseSpec {
    const s = this.state;
    switch (phase) {
      case "discovery.lead":
        return { role: "lead", kind: "proposal", prompt: leadProposalPrompt(s.task) };
      case "initial.architect":
        return { role: "architect", kind: "architect_initial", prompt: initialArchitectPrompt(s.task, s.results.proposal!.packet) };
      case "execution.engineer":
        return this.engineerSpec("execution", resumeNote);
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
            ...(s.targetPlan ? { targetSummary: s.targetPlan.targets.map((target) => `${target.id}: ${s.targetPlan!.outcomes[target.id].status}`) } : {}),
          }),
        };
      case "final.architect":
        return {
          role: "architect",
          kind: "architect_final",
          prompt: finalArchitectPrompt({
            task: s.task,
            // Sweep again at the checkpoint so the guarantee holds even for a
            // legacy/restored integration packet. Idempotent.
            integration: enforceReviewerFindingDispositions(s.results.integration!.packet, s.results.reviewers),
            targets: s.targetPlan?.targets,
            targetOutcomes: s.targetPlan?.targets.map((target) => `${target.id}: ${s.targetPlan!.outcomes[target.id].status}; reviewer ${s.targetPlan!.outcomes[target.id].reviewerAgentId ?? "none"}`),
          }),
        };
      case "final_recheck.architect": {
        const rem = s.results.remediation;
        return {
          role: "architect",
          kind: "architect_final",
          prompt: finalArchitectPrompt({
            task: s.task,
            integration: enforceReviewerFindingDispositions(s.results.integration!.packet, s.results.reviewers),
            targets: s.targetPlan?.targets,
            targetOutcomes: s.targetPlan?.targets.map((target) => `${target.id}: ${s.targetPlan!.outcomes[target.id].status}; reviewer ${s.targetPlan!.outcomes[target.id].reviewerAgentId ?? "none"}`),
            // Surface the actual remediation so the recheck assesses the fixed
            // system, not the pre-fix packet it already rejected.
            ...(rem?.engineer && rem.reviewer
              ? { remediation: { engineer: rem.engineer.packet, reviewer: rem.reviewer.packet } }
              : {}),
          }),
        };
      }
      case "final_synthesis.lead": {
        // The accepted packet is whichever Architect gate accepted the run. The
        // synthesis is told the post-remediation state when one exists, so its
        // report describes the ACTUAL accepted state, not the pre-fix packet.
        const accepted = s.results.finalRecheck ?? s.results.finalArchitect;
        const rem = s.results.remediation;
        return {
          role: "lead",
          kind: "final_report",
          prompt: finalReportPrompt({
            runId: this.runId,
            task: s.task,
            architecture: s.effectiveArchitecture,
            integration: enforceReviewerFindingDispositions(s.results.integration!.packet, s.results.reviewers),
            finalAcceptance: accepted!.packet,
            engineers: s.results.engineers.map((e) => e.outcome.packet),
            reviewers: s.results.reviewers.map((r) => r.outcome.packet),
            ...(rem?.engineer && rem.reviewer
              ? { remediation: { engineer: rem.engineer.packet, reviewer: rem.reviewer.packet } }
              : {}),
            runStartedAt: s.createdAt,
            // The run has not gone terminal yet (DONE follows this synthesis),
            // so use the accepted-state clock time as the window end.
            runEndedAt: s.metrics.runEndedAt ?? this.clock.now(),
            repairRounds: s.repairRound,
            remediationRounds: s.remediationRounds,
            roleTargets: ROLE_NAMES.map((role) => `${role}: ${s.metrics.roles[role].targetUsed ?? this.config.roles[role]?.targets?.primary ?? "unknown"}`),
          }),
        };
      }
      case "remediation.engineer":
        return this.engineerSpec("remediation", resumeNote);
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
            targetPlan: s.targetPlan?.targets,
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

  private engineerSpec(kind: "execution" | "remediation", resumeNote?: string): PhaseSpec {
    const s = this.state;
    const target = s.targetPlan?.targets.find((item) => item.id === s.targetPlan?.currentTargetId);
    const remediatedId = kind === "remediation" && s.targetPlan && s.targetPlan.targets.length > 1
      ? s.results.finalArchitect?.packet.affectedTargetIds?.[0] ?? "integration" : undefined;
    const scopedTarget = remediatedId ? s.targetPlan?.targets.find((item) => item.id === remediatedId) : target;
    const wpId = remediatedId ?? target?.id ?? s.results.proposal?.packet.workPackages[0] ?? FIRST_WORK_PACKAGE;
    const repair = s.repairRound > 0 ? lastReviewer(s)?.outcome.packet : undefined;
    const leadEsc = s.results.leadEscalation;
    const remediation = s.results.finalArchitect?.packet;
    return {
      role: "engineer",
      kind: "engineer",
      prompt: engineerPrompt({
        workPackageId: wpId,
        target: scopedTarget,
        dependencies: scopedTarget?.dependsOn,
        architecture: s.effectiveArchitecture,
        task: s.task,
        acceptanceCriteria: s.results.proposal?.packet.acceptanceCriteria ?? [],
        constraints: [...new Set([
          ...(s.results.proposal?.packet.constraints ?? []),
          ...(s.results.initialArchitect?.packet.constraints ?? []),
          ...(s.results.escalationArchitect?.packet.constraints ?? []),
        ])],
        repairFindings: kind === "execution" ? repair : undefined,
        remediationChanges: kind === "remediation" ? remediation : undefined,
        remediationScope: kind === "remediation" ? remediatedId : undefined,
        priorDecisions: leadEsc && leadEsc.packet.verdict === "continue"
          ? `Lead guidance: ${leadEsc.packet.guidance}`
          : undefined,
        resumeNote,
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
        revalidation: s.targetPlan?.revalidationIds?.includes(s.targetPlan.currentTargetId ?? "") ? s.results.finalArchitect?.packet.affectedTargetIds?.[0] : undefined,
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
    // An approved resume is consumed once on the next spawn: the guards below
    // are bypassed and the Engineer is told to inspect the existing workspace
    // and finish only the missing work, never to blindly repeat the previous
    // implementation.
    const resumeApproved = this.resumeApproved;
    this.resumeApproved = false;
    const resumeNote = resumeApproved
      ? `An earlier attempt at this work package was interrupted. Inspect the existing files, keep the original goal (${s.task}) and the approved architecture, and finish ONLY the missing work — do not blindly repeat or revert the previous implementation. The saved completion evidence and reviewer findings above are preserved.`
      : undefined;
    const spec = this.phaseSpec(phase, resumeNote);
    // B1: never replay a phase whose latest attempt has unresolved spawn
    // provenance (prepared / spawn_requested) — a child may have been
    // dispatched whose outcome is unknown. Park instead of re-spawning;
    // eligibility then requires explicit approval. An approved resume is the
    // explicit authorization and bypasses this once.
    if (unresolvedAttemptForPhase(s, phase) !== undefined && !resumeApproved) {
      s.parked = true;
      this.commit();
      return "handled";
    }
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
      // The child must run in the canonical persisted workspace, never an
      // incidental session directory. The transport refuses a broken cwd.
      cwd: this.cwd,
    };

    const rm = s.metrics.roles[spec.role];
    rm.attempts++;
    s.metrics.totalAttempts++;
    pending.attemptedTargets.push(target);
    if (!rm.targetsAttempted.includes(target)) rm.targetsAttempted.push(target);
    rm.targetUsed = target;

    // Persist preparation and the spawn request before crossing the transport
    // boundary. A restart can therefore distinguish "never started" from an
    // invocation whose outcome is uncertain.
    const attemptId = `${this.runId}:${phase}:${s.metrics.totalAttempts}`;
    const attempt: FactoryAttempt = {
      attemptId,
      role: spec.role,
      phase,
      round: s.repairRound,
      target,
      ...(s.targetPlan && (phase === "execution.engineer" || phase === "review.reviewer") && s.targetPlan.currentTargetId ? { targetId: s.targetPlan.currentTargetId } : {}),
      ...(s.targetPlan && phase === "remediation.engineer" ? { targetId: s.results.finalArchitect?.packet.affectedTargetIds?.[0] ?? "integration" } : {}),
      provenance: "prepared",
      recoveryRisk: spec.role === "engineer" ? "workspace_may_have_changed" : "uncertain_outcome",
      preparedAt: this.clock.now(),
      packetKind: spec.kind,
      configRevision: configRevision(this.config),
    };
    s.attempts = [...(s.attempts ?? []), attempt];
    pending.attemptId = attemptId;
    this.commit();
    attempt.provenance = "spawn_requested";
    attempt.spawnRequestedAt = this.clock.now();
    this.commit();

    // Register the outstanding spawn in the process-local ownership registry
    // BEFORE the RPC crosses the transport, so a same-process takeover during
    // the await is refused. A false result means ownership is inconsistent.
    if (!this.store.beginSpawn(this.runId, this.leaseToken)) {
      this.ownershipLost = true;
      this.pending = undefined;
      return "handled";
    }

    const outcome = await this.transport.spawn(request);

    // Disposal or ownership loss while the RPC was in flight: the outcome is
    // never imported as owned work. A child that did start is stopped
    // best-effort and stays tracked as outstanding until its settlement is
    // independently confirmed (a stop request is not proof of termination).
    if (this.disposed || this.ownershipLost) {
      this.earlySettlements.clear();
      attempt.settledAt = this.clock.now();
      attempt.provenance = "settled_without_valid_packet";
      if (outcome.ok) {
        this.store.childSpawned(this.runId, this.leaseToken, outcome.agentId);
        this.transport.stop(outcome.agentId);
        attempt.agentId = outcome.agentId;
      } else {
        this.store.spawnFailed(this.runId, this.leaseToken);
      }
      attempt.recoveryRisk = spec.role === "engineer" ? "workspace_may_have_changed" : "uncertain_outcome";
      s.metrics.roles[spec.role].error = "spawn resolved after disposal or ownership loss; outcome not imported as owned work";
      return "handled";
    }

    if (outcome.ok) {
      this.store.childSpawned(this.runId, this.leaseToken, outcome.agentId);
      attempt.provenance = "spawned";
      attempt.agentId = outcome.agentId;
      attempt.spawnedAt = this.clock.now();
      s.inFlight = { role: spec.role, phase, agentId: outcome.agentId, target, spawnedAt: this.clock.now() };
      rm.agentId = outcome.agentId;
      rm.startedAt = this.clock.now();
      rm.status = "running";
      this.commit();
      // A settlement may have arrived before the spawn reply (inFlight was not
      // yet persisted). Import it exactly once, then keep driving.
      const early = this.earlySettlements.get(outcome.agentId);
      this.earlySettlements.clear();
      if (early !== undefined) {
        this.processSettled(early.info, early.ok);
        return "handled";
      }
      return "wait";
    }

    // Spawn RPC rejected. A definitive rejection (quota/hard) means no child
    // could start; a transient failure (timeout/network) may have dispatched
    // one, so it retains workspace risk for Engineer phases.
    const klass = classifyError(outcome.error);
    this.store.spawnFailed(this.runId, this.leaseToken);
    this.earlySettlements.clear();
    attempt.provenance = "settled_without_valid_packet";
    attempt.recoveryRisk = spec.role === "engineer"
      ? (klass === "transient" ? "workspace_may_have_changed" : "none")
      : "uncertain_outcome";
    attempt.settledAt = this.clock.now();
    this.commit();
    this.handlePhaseFailure(phase, spec.role, outcome.error, klass);
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
    s.parked = true;
    this.pending = undefined;
    this.applyTransition("WAITING_CAPACITY");
    this.scheduleWake(nextRetryAt);
  }

  /** Handle a failed spawn or a settled-but-unusable phase. */
  private handlePhaseFailure(
    phase: string,
    role: RoleName,
    message: string,
    klass: "transient" | "quota" | "hard",
    opts: { noPacketRetry?: boolean; childStarted?: boolean } = {},
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

    // Engineer phases never auto-replay after a failure that may have touched
    // the workspace: a child that started (settled, aborted, or stopped), an
    // invalid or missing packet, or an uncertain spawn outcome (a transient
    // RPC failure that may have dispatched a child). The run stays in the
    // phase with the failed attempt recorded and requires explicit approval;
    // it is never converted into a generic auto-recoverable parked or
    // WAITING_CAPACITY state. Definite pre-spawn quota rejections (recoveryRisk
    // "none") still take the normal fallback/capacity path below.
    if (role === "engineer" && (opts.childStarted || klass === "transient")) {
      s.parked = false;
      this.pending = undefined;
      return;
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
        s.effectiveArchitecture = arch.approvedArchitecture
          || (arch.verdict === "CORRECT" ? arch.correctedWorkPackages.join("\n") : s.results.proposal?.packet.proposedSolution ?? "");
        if (s.version === 3) {
          if (arch.verdict === "CLARIFY") {
            s.stoppedReason = `Clarification required: ${(arch.clarificationQuestions ?? []).join("; ") || "Architect could not approve the target plan"}`;
            break;
          }
          const proposal = s.results.proposal!.packet;
          const fallback: FactoryTarget[] = proposal.workPackages.length === 1
            ? [{ id: TARGET_ID.test(proposal.workPackages[0]) ? proposal.workPackages[0] : "WP0", description: proposal.workPackages[0], dependsOn: [], acceptanceCriteria: proposal.acceptanceCriteria }]
            : [];
          const proposedCount = Math.max(proposal.targets?.length ?? 0, proposal.workPackages.length);
          const requiresExplicitPlan = proposedCount > 1 || (arch.approvedTargets?.length ?? 0) > 1;
          const targets = arch.approvedTargets ?? (requiresExplicitPlan ? [] : proposal.targets ?? fallback);
          const errors = validateTargets(targets);
          if (requiresExplicitPlan && !arch.approvedTargets) errors.push("Multi-target Architect approval must include the complete approvedTargets plan");
          if (requiresExplicitPlan && !proposal.requirementCatalog?.length) errors.push("Multi-target Lead proposal has no stable original requirement identities");
          if (requiresExplicitPlan && !arch.planAssessment) errors.push("Multi-target Architect approval must include a complete mission-coverage assessment");
          if (arch.planAssessment) errors.push(...validateArchitectTargetApproval(proposal, targets, arch.planAssessment, arch.constraints));
          if ((arch.clarificationQuestions?.length ?? 0) > 0) errors.push("Architect approval contains unresolved clarification questions");
          if (errors.length > 0) s.stoppedReason = `Invalid Architect target approval: ${[...new Set(errors)].join("; ")}`;
          else s.targetPlan = createTargetPlan(targets);
        }
        break;
      }
      case "execution.engineer":
        if (s.targetPlan && (packet as { workPackageId: string }).workPackageId !== s.targetPlan.currentTargetId) {
          this.failRun(`Engineer packet target ID does not match dispatched target ${s.targetPlan.currentTargetId}`);
          return;
        }
        s.results.engineers.push({ ...(s.targetPlan ? { targetId: s.targetPlan.currentTargetId } : {}), round: s.repairRound, outcome });
        break;
      case "review.reviewer":
        s.results.reviewers.push({ ...(s.targetPlan ? { targetId: s.targetPlan.currentTargetId } : {}), round: s.repairRound, outcome });
        break;
      case "integration.lead": {
        // Deterministic fidelity guard: the Lead may summarize, but it may not
        // erase. Every Reviewer finding that the acceptance packet does not
        // explicitly disposition is preserved under `reviewerFindingsUnresolved`.
        const integration = enforceReviewerFindingDispositions(
          packet as LeadIntegrationPacket,
          s.results.reviewers,
        );
        s.results.integration = {
          packet: integration,
          agentId: info.agentId,
          ...(info.modelName !== undefined ? { target: info.modelName } : {}),
        };
        break;
      }
      case "final.architect":
        s.results.finalArchitect = outcome;
        break;
      case "final_recheck.architect":
        s.results.finalRecheck = outcome;
        break;
      case "final_synthesis.lead":
        // Preserved separately from integration/finalArchitect/finalRecheck so
        // the rejected integration packet and both Architect gates remain as
        // audit history for the run.
        s.results.finalReport = outcome;
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
        s.results.escalationArchitect = outcome;
        if (arch.verdict === "CLARIFY") {
          s.stoppedReason = `Architect requires clarification: ${(arch.clarificationQuestions ?? []).join("; ")}`;
          this.applyTransition("STOPPED");
          return;
        }
        if (s.targetPlan && arch.approvedTargets) {
          const issues = validateTargets(arch.approvedTargets);
          const old = s.targetPlan;
          if (arch.approvedTargets.length !== old.targets.length || arch.approvedTargets.some((target, index) => {
            const previous = old.targets[index];
            return target.id !== previous.id || (old.outcomes[target.id].status === "passed" && JSON.stringify(target) !== JSON.stringify(previous));
          })) issues.push("plan revision cannot change identities or previously passed contracts");
          if (issues.length > 0) {
            s.stoppedReason = `Unsafe Architect plan revision: ${issues.join("; ")}`;
            this.applyTransition("STOPPED");
            return;
          }
          old.targets = arch.approvedTargets;
          old.revision++;
          old.rationale.push(`Architect reassessment: ${arch.approvedArchitecture}`);
        } else if (s.targetPlan && s.targetPlan.targets.length > 1 && arch.verdict === "CORRECT") {
          s.stoppedReason = "Architect correction lacks a safe structured target revision";
          this.applyTransition("STOPPED");
          return;
        }
        s.effectiveArchitecture = arch.approvedArchitecture
          || (arch.verdict === "CORRECT" ? arch.correctedWorkPackages.join("\n") : s.effectiveArchitecture);
        if (s.targetPlan?.awaitingArchitectAcceptance) {
          const id = s.targetPlan.currentTargetId!;
          s.targetPlan.outcomes[id].architectAgentId = info.agentId;
          s.targetPlan.awaitingArchitectAcceptance = false;
          s.targetPlan.currentTargetId = undefined;
        } else {
          s.repairRound = s.targetPlan && s.targetPlan.targets.length > 1 ? s.repairRound + 1 : 0;
        }
        s.repairExhausted = false;
        break;
      }
      case "escalation.lead": {
        const esc = packet as LeadEscalationPacket;
        s.leadEscalations++;
        s.results.leadEscalation = outcome;
        if (esc.verdict === "stop") {
          const action = this.failTargetOrStop("Lead decided to stop after the repair loop was exhausted.");
          this.applyTransition(action.to, action.note);
          return;
        }
        s.repairExhausted = false;
        s.repairRound = s.targetPlan ? s.repairRound + 1 : 0;
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
    if (this.driving || this.disposed || this.ownershipLost || isTerminal(this.state.state)) return;
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

  private applyTransition(to: FactoryRunState["state"], note?: string): void {
    const from = this.state.state;
    assertTransition(from, to);
    if (to === "ARCHITECT_ESCALATION") this.state.results.escalationArchitect = undefined;
    if (to === "STOPPED" && note?.trim()) this.state.stoppedReason = note.trim();
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

  /** Persist the current state as the next durable recovery checkpoint. */
  private commit(): void {
    if (this.disposed) return;
    this.state.updatedAt = this.clock.now();
    if (this.state.version !== 1) {
      this.state.stateRevision = (this.state.stateRevision ?? 0) + 1;
      this.state.checkpoint = createFactoryCheckpoint(this.state, this.state.stateRevision);
    }
    // Every owner-controlled mutation is fenced: a stale controller that lost
    // the lease is rejected here by the store. It fails closed (inert) rather
    // than throwing into the event bus and must not drive further.
    try {
      this.store.save(this.state, this.leaseToken);
    } catch (err) {
      if (err instanceof FactoryLeaseError) {
        this.ownershipLost = true;
        this.earlySettlements.clear();
        this.pending = undefined;
        return;
      }
      throw err;
    }
  }

  /**
   * Recover after a process restart. Completed phases stay completed (their
   * packets are in the store); only a phase that was mid-flight or parked is
   * resumed. A mid-flight agent cannot have survived the process death (agents
   * are in-process), so it is treated as a failed attempt and retried
   * deterministically — never re-running a completed phase.
   *
   * Caveat: pi-subagents agents are session-scoped, not controller-scoped.
   * On a Pi session switch the transport disposes all controllers (unsubscribing
   * event callbacks but never aborting children), while the spawned child keeps
   * running. A restored controller may therefore find a persisted inFlight agent
   * that is still live. We probe the manager registry to distinguish this case.
   */
  private onRestore(): void {
    const s = this.state;
    if (this.disposed || isTerminal(s.state)) return;

    if (s.inFlight) {
      // Probe the manager registry for liveness. If the child is still running
      // or queued, it survived a session switch — adopt it without re-spawning.
      const status = this.transport.agentStatus(s.inFlight.agentId);
      if (status === "running" || status === "queued") {
        // Liveness verified via registry; event delivery via the constructor-time
        // subscription (onCompleted/onFailed → onSettled, which matches on
        // state.inFlight.agentId). No replacement spawn: the original child still
        // owns the workspace. Track the adopted child as outstanding so a
        // same-process takeover cannot race it.
        this.store.adoptChild(this.runId, this.leaseToken, s.inFlight.agentId);
        return;
      }
      // Status is undefined (unknown/absent) or terminal — treat as lost agent.
      // Before clearing inFlight and re-spawning, check whether the phase
      // requires user approval (e.g. an interrupted Engineer may have left
      // partial workspace changes).  Fail closed: if approval is required,
      // park the run without mutating inFlight so it remains inspectable.
      const eligibility = assessRecoveryEligibility(s);
      if (eligibility.requiresApproval) {
        s.parked = true;
        this.commit();
        return;
      }
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
  return [...s.results.engineers].reverse().find((item) => !s.targetPlan || item.targetId === s.targetPlan.currentTargetId);
}

/**
 * Whether the current Engineer phase must never auto-replay (Task 3): its
 * latest attempt settled without a valid packet AND either a child started
 * (agentId recorded) or the outcome was uncertain (workspace risk). Only an
 * explicit approval may authorize a replay; the run stays in the phase.
 */
function engineerSpawnBlocked(s: FactoryRunState): boolean {
  const phase = s.state === "EXECUTION"
    ? "execution.engineer"
    : s.state === "REMEDIATION"
      ? "remediation.engineer"
      : undefined;
  if (phase === undefined) return false;
  const attempt = latestAttemptForPhase(s, phase);
  if (attempt === undefined) return false;
  if (attempt.provenance === "settled_validated_packet") return !hasPersistedAttemptPacket(s, attempt);
  if (attempt.provenance !== "settled_without_valid_packet") return false;
  return attempt.agentId !== undefined || attempt.recoveryRisk === "workspace_may_have_changed";
}

function lastReviewer(s: FactoryRunState) {
  return [...s.results.reviewers].reverse().find((item) => !s.targetPlan || item.targetId === s.targetPlan.currentTargetId);
}

/** Every finding any Reviewer raised, across every round, in a stable order. */
function reviewerFindings(reviewers: ReviewerOutcome[]): string[] {
  const findings: string[] = [];
  for (const reviewer of reviewers) {
    const packet = reviewer.outcome.packet;
    findings.push(
      ...packet.blockingFindings,
      ...packet.nonBlockingFindings,
      ...packet.requiredRepairs,
      ...packet.testConcerns,
    );
  }
  return findings;
}

const normalizeFinding = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Guarantee every Reviewer finding survives into the Lead's acceptance packet
 * with an explicit disposition. The packet's three buckets ARE the dispositions
 * (resolved / accepted risk / unresolved); a finding the Lead placed in none of
 * them is preserved verbatim under `reviewerFindingsUnresolved`, so a
 * non-blocking finding can never be summarized away before the Final Architect
 * sees it.
 */
function enforceReviewerFindingDispositions(
  packet: LeadIntegrationPacket,
  reviewers: ReviewerOutcome[],
): LeadIntegrationPacket {
  const placed = [
    ...packet.reviewerFindingsResolved,
    ...packet.reviewerFindingsAcceptedRisk,
    ...packet.reviewerFindingsUnresolved,
  ].map(normalizeFinding).join("\n");

  const missing: string[] = [];
  for (const finding of reviewerFindings(reviewers)) {
    const normalized = normalizeFinding(finding);
    if (normalized !== "" && !placed.includes(normalized)) missing.push(finding);
  }
  if (missing.length === 0) return packet;
  return { ...packet, reviewerFindingsUnresolved: [...packet.reviewerFindingsUnresolved, ...missing] };
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
