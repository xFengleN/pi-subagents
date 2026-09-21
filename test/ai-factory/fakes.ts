/**
 * ai-factory test fakes — fake transport, fake clock, temp store.
 *
 * The Factory controller is pi-free by construction, so the whole state machine
 * is driven here against a scriptable transport with no pi session and no model
 * calls. Tests must not burn real paid quota; they never touch a provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/ai-factory/clock.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import type {
  AgentSettleInfo,
  FactoryTransport,
  SpawnOutcome,
  SpawnRequest,
} from "../../src/ai-factory/transport.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";

/** Let queued microtasks and the controller's async drive() settle. */
export const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; cb: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(cb: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, cb });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Advance the clock, firing any timers now due (in schedule order). */
  advance(ms: number): void {
    this.time += ms;
    const due = [...this.timers.entries()]
      .filter(([, t]) => t.at <= this.time)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      t.cb();
    }
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  setTime(t: number): void {
    this.time = t;
  }
}

export class FakeTransport implements FactoryTransport {
  available = true;
  spawned: SpawnRequest[] = [];
  consumed: string[] = [];
  stopped: string[] = [];
  /** Per-spawn outcome handler. Default: succeed with an incrementing id. */
  spawnHandler: (req: SpawnRequest) => SpawnOutcome | Promise<SpawnOutcome>;
  lastAgentId: string | undefined;
  /** When set, a spawn whose cwd does not match is rejected before any child
   * exists (Task 3 workspace binding). */
  expectedCwd: string | undefined;
  /** Settable map for agent-status probing (used by live-child-adoption tests). */
  agentStatuses = new Map<string, string>();

  private nextId = 1;
  private started = new Set<(id: string) => void>();
  private completed = new Set<(info: AgentSettleInfo) => void>();
  private failed = new Set<(info: AgentSettleInfo) => void>();

  constructor(spawnHandler?: (req: SpawnRequest) => SpawnOutcome | Promise<SpawnOutcome>) {
    this.spawnHandler = spawnHandler ?? ((_req) => ({ ok: true, agentId: `agent-${this.nextId++}` }));
  }

  isAvailable(): boolean {
    return this.available;
  }

  async spawn(req: SpawnRequest): Promise<SpawnOutcome> {
    this.spawned.push(req);
    if (this.expectedCwd !== undefined && req.cwd !== this.expectedCwd) {
      return { ok: false, error: `workspace mismatch: expected ${this.expectedCwd}, got ${req.cwd}` };
    }
    const outcome = await this.spawnHandler(req);
    if (outcome.ok) this.lastAgentId = outcome.agentId;
    return outcome;
  }

  stop(agentId: string): void {
    this.stopped.push(agentId);
  }

  consume(agentId: string): void {
    this.consumed.push(agentId);
  }

  onStarted(cb: (id: string) => void): () => void {
    this.started.add(cb);
    return () => this.started.delete(cb);
  }

  onCompleted(cb: (info: AgentSettleInfo) => void): () => void {
    this.completed.add(cb);
    return () => this.completed.delete(cb);
  }

  onFailed(cb: (info: AgentSettleInfo) => void): () => void {
    this.failed.add(cb);
    return () => this.failed.delete(cb);
  }

  agentStatus(agentId: string): string | undefined {
    return this.agentStatuses.get(agentId);
  }

  fireStarted(id: string): void {
    for (const cb of [...this.started]) cb(id);
  }

  fireCompleted(info: AgentSettleInfo): void {
    for (const cb of [...this.completed]) cb(info);
  }

  fireFailed(info: AgentSettleInfo): void {
    for (const cb of [...this.failed]) cb(info);
  }

  /** Complete the most recently spawned agent with a structured packet. */
  completeLastPacket(packet: unknown, extra: Partial<AgentSettleInfo> = {}): string {
    const agentId = this.lastAgentId;
    if (agentId === undefined) throw new Error("no agent has been spawned");
    this.fireCompleted({
      agentId,
      ok: true,
      status: "completed",
      structuredJson: JSON.stringify(packet),
      ...extra,
    });
    return agentId;
  }

  /** Fail the most recently spawned agent. */
  failLast(error: string): string {
    const agentId = this.lastAgentId;
    if (agentId === undefined) throw new Error("no agent has been spawned");
    this.fireFailed({ agentId, ok: false, status: "error", error });
    return agentId;
  }
}

export interface TempStore {
  store: FactoryStore;
  dir: string;
  cleanup: () => void;
}

export function tempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "factory-store-"));
  return { store: new FactoryStore(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A FactoryStore that records the sequence of distinct run states it is asked
 * to persist. Because the controller commits after every transition, this is a
 * faithful, non-invasive transition trace for the section-29 demonstrations.
 */
export class RecordingStore extends FactoryStore {
  readonly transitions: FactoryRunState["state"][] = [];

  override save(state: FactoryRunState): void {
    if (this.transitions[this.transitions.length - 1] !== state.state) this.transitions.push(state.state);
    super.save(state);
  }

  reset(): void {
    this.transitions.length = 0;
  }
}

/** Convenient packets for tests. */
export const packets = {
  proposal: {
    goal: "Implement the widget",
    repositoryFindings: "src/ exists, package.json present",
    currentArchitecture: "single module",
    assumptions: ["repo is green"],
    proposedSolution: "add a widgets/ package",
    constraints: ["no new deps"],
    workPackages: ["wp-1"],
    dependencies: "none",
    risks: [],
    acceptanceCriteria: ["tests pass"],
    architecturalQuestions: [],
  },
  approve: { verdict: "APPROVE", approvedArchitecture: "widgets package", constraints: [], correctedWorkPackages: [], importantRisks: [] },
  correct: { verdict: "CORRECT", approvedArchitecture: "corrected architecture: two modules", constraints: [], correctedWorkPackages: ["wp-1"], importantRisks: [] },
  engineer: {
    status: "completed",
    workPackageId: "wp-1",
    summary: "implemented widgets",
    changedFiles: ["src/widgets.ts"],
    importantDecisions: [],
    testsRun: ["npm test"],
    testResults: "pass",
    deviations: [],
    knownLimitations: [],
    unresolvedQuestions: [],
    architecturalEscalationRequired: false,
  },
  reviewerPass: { verdict: "PASS", blockingFindings: [], nonBlockingFindings: [], requiredRepairs: [], testConcerns: [], architecturalIssue: false },
  /** PASS with an advisory finding the Lead could wrongly summarize away. */
  reviewerPassWithNote: {
    verdict: "PASS",
    blockingFindings: [],
    nonBlockingFindings: ["rename the helper for clarity"],
    requiredRepairs: [],
    testConcerns: [],
    architecturalIssue: false,
  },
  reviewerNeedsFix: {
    verdict: "NEEDS_FIX",
    blockingFindings: ["missing error handling"],
    nonBlockingFindings: [],
    requiredRepairs: ["add error handling"],
    testConcerns: ["add a failing-input test"],
    architecturalIssue: false,
  },
  reviewerArchitectural: {
    verdict: "NEEDS_FIX",
    blockingFindings: ["data model is wrong"],
    nonBlockingFindings: [],
    requiredRepairs: ["re-model"],
    testConcerns: [],
    architecturalIssue: true,
  },
  integration: {
    goal: "Implement the widget",
    approvedArchitecture: "widgets package",
    completedWorkPackages: ["wp-1"],
    importantDecisions: [],
    deviations: [],
    systemVerification: "npm test green",
    reviewerFindingsResolved: [],
    reviewerFindingsAcceptedRisk: [],
    reviewerFindingsUnresolved: [],
    selectedFiles: ["src/widgets.ts"],
    factualAssessment: "complete",
  },
  /** The observed defect shape: the Lead insists there were no findings. */
  integrationIgnoringNote: {
    goal: "Implement the widget",
    approvedArchitecture: "widgets package",
    completedWorkPackages: ["wp-1"],
    importantDecisions: [],
    deviations: [],
    systemVerification: "npm test green",
    reviewerFindingsResolved: [],
    reviewerFindingsAcceptedRisk: ["None. Reviewer reported no non-blocking risks and I identified none."],
    reviewerFindingsUnresolved: [],
    selectedFiles: ["src/widgets.ts"],
    factualAssessment: "complete",
  },
  /** The Lead correctly dispositions the advisory finding. */
  integrationWithDisposition: {
    goal: "Implement the widget",
    approvedArchitecture: "widgets package",
    completedWorkPackages: ["wp-1"],
    importantDecisions: [],
    deviations: [],
    systemVerification: "npm test green",
    reviewerFindingsResolved: [],
    reviewerFindingsAcceptedRisk: ["rename the helper for clarity"],
    reviewerFindingsUnresolved: [],
    selectedFiles: ["src/widgets.ts"],
    factualAssessment: "complete",
  },
  accept: { verdict: "ACCEPT", blockingIssues: [], requiredChanges: [], doNotChange: [], requiredEvidence: [] },
  remediate: { verdict: "NEEDS_REMEDIATION", blockingIssues: ["rename module"], requiredChanges: ["rename widgets→gadgets"], doNotChange: ["keep API"], requiredEvidence: ["tests"] },
  finalReport: {
    result: "ACCEPT",
    summary: "Implemented and validated the widget.",
    delivered: ["widgets package added"],
    architecture: ["single module"],
    reviewerFindings: ["rename the helper for clarity — resolved"],
    validation: ["npm test: pass"],
    commits: ["abc1234 add widgets"],
    endingHead: "abc1234",
    pushed: "no",
    humanVerification: ["run the app end to end"],
    warnings: ["manual smoke test still pending"],
  },
  /** Post-remediation final report: distinguishable from `finalReport`. */
  finalReportRemediated: {
    result: "ACCEPT (after remediation)",
    summary: "Accepted after renaming the module.",
    delivered: ["widgets package renamed to gadgets"],
    architecture: ["single module"],
    reviewerFindings: ["missing error handling — resolved in remediation"],
    validation: ["npm test: pass"],
    commits: ["def5678 rename widgets to gadgets"],
    endingHead: "def5678",
    pushed: "no",
    humanVerification: ["confirm the rename in the UI"],
    warnings: [],
  },
} as const;
