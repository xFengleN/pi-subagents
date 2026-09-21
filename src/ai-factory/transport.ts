/**
 * ai-factory/transport.ts — The Factory's seam to pi-subagents.
 *
 * The Factory drives pi-subagents ONLY through its documented cross-extension
 * surface: the `subagents:rpc:spawn` / `subagents:rpc:consume` channels and the
 * `subagents:started` / `subagents:completed` / `subagents:failed` lifecycle
 * events on `pi.events`, plus the `Symbol.for("pi-subagents:manager")` registry
 * for post-settle details (the settled record's `structuredJson`, effective
 * model, and lifetime usage). It never reaches into pi-subagents internals.
 *
 * The controller depends on the {@link FactoryTransport} interface, so tests
 * drive the whole state machine against a fake transport with no pi at all.
 */

import { isAbsolute } from "node:path";
import { nanoid } from "nanoid";
import type { ReportedUsage } from "../usage.js";
import type { CompiledSchema } from "../workflow/json-schema.js";
import type { RoleName } from "./types.js";

/** Minimal event bus — the subset of `pi.events` the transport uses. */
export interface EventBus {
  on(event: string, handler: (data: any) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** What the spawn RPC needs from pi-subagents to name a model string. */
export interface SpawnRequest {
  role: RoleName;
  /** Stable sub-phase label, e.g. "execution.engineer". */
  phase: string;
  /** pi-subagents agent type to spawn. */
  agentType: string;
  prompt: string;
  description: string;
  /** Model identifier "provider/model", resolved at the RPC boundary. */
  model?: string;
  maxTurns?: number;
  /** Fresh context, never parent-inherited (Factory default). */
  isolated: boolean;
  /** Packet schema → the child gets a StructuredOutput tool. */
  schema?: CompiledSchema;
  /** The canonical persisted workspace the child must run in (Task 3). */
  cwd: string;
}

export type SpawnOutcome = { ok: true; agentId: string } | { ok: false; error: string };

/** Provider-neutral failure classification (see classifyError). */
export type FailureClass = "transient" | "quota" | "hard";

/**
 * Classify a spawn/failure message into a recovery decision, provider-neutral.
 *
 *   transient — retry the same target with bounded backoff, then fall back.
 *   quota     — the target is unavailable for capacity reasons: move to the
 *               next configured eligible fallback.
 *   hard      — do not silently hop across models; surface through Factory state.
 */
export function classifyError(message: string): FailureClass {
  const e = message.toLowerCase();
  if (/quota|capacity|exhausted|subscription|insufficient.*credit|billing/i.test(e)) return "quota";
  // Transient availability failures: the target is otherwise valid but the
  // provider/transport is unreachable right now (connectivity, overload,
  // rate-limit). Bounded same-target retry, then fallback. Deliberately does
  // NOT match configuration/auth failures (model-not-found, invalid provider,
  // 401/403) — those stay `hard` and are surfaced without model-hopping.
  if (
    /timeout|timed ?out|econnreset|econnrefused|econnaborted|econnclose|enetunreach|ehostunreach|network (error|unreachable|is unreachable)|connect(ion)? (error|refused|reset|closed|dropped|timed ?out)|reset by peer|socket hang ?up|premature close|other side closed|fetch failed|transport (error|failure|closed)|provider transport|overloaded|502|503|504|bad gateway|service unavailable|429|too many requests|rate ?limit/i.test(e)
  ) return "transient";
  return "hard";
}

/**
 * Everything the controller needs to know about a settled child. Fields a
 * provider/runner does not expose are `undefined` ("unknown").
 */
export interface AgentSettleInfo {
  agentId: string;
  ok: boolean;
  status: string;
  /** Prose result. */
  result?: string;
  /** The validated structured packet JSON, when the child used StructuredOutput. */
  structuredJson?: string;
  error?: string;
  usage?: ReportedUsage;
  tokens?: { input: number; output: number; total: number };
  toolUses?: number;
  durationMs?: number;
  modelName?: string;
  modelId?: string;
  compactionCount?: number;
  completedAt?: number;
}

export interface FactoryTransport {
  /** Whether pi-subagents is present and bound to a session. */
  isAvailable(): boolean;
  /** Spawn a role child (direct RPC — never the model-mediated Agent tool). */
  spawn(req: SpawnRequest): Promise<SpawnOutcome>;
  /** Stop a running child. */
  stop(agentId: string): void;
  /** Mark a settled child's result consumed (suppresses duplicate notification). */
  consume(agentId: string): void;
  /** Probe an agent's current status via the manager registry. Returns
   * undefined when the agent is unknown/absent. */
  agentStatus(agentId: string): string | undefined;
  onStarted(cb: (agentId: string) => void): () => void;
  onCompleted(cb: (info: AgentSettleInfo) => void): () => void;
  onFailed(cb: (info: AgentSettleInfo) => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Bus implementation                                                         */
/* -------------------------------------------------------------------------- */

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** The documented manager-registry surface (docs/rpc.md). */
interface ManagerRegistry {
  getRecord(id: string): RecordLike | undefined;
}

/** The subset of AgentRecord the transport reads post-settle. */
interface RecordLike {
  id: string;
  status: string;
  result?: string;
  error?: string;
  structuredJson?: string;
  toolUses: number;
  startedAt?: number;
  completedAt?: number;
  compactionCount?: number;
  lifetimeUsage?: { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number };
  invocation?: { modelName?: string; modelId?: string };
}

type RpcReply = { success: true; data?: any } | { success: false; error: string };

const RPC_SPAWN_TIMEOUT_MS = 60_000;

/** One request/reply RPC round over the synchronous in-process bus. */
function rpcCall(events: EventBus, channel: string, request: Record<string, unknown>, timeoutMs: number): Promise<RpcReply> {
  const requestId = nanoid(12);
  return new Promise<RpcReply>((resolve) => {
    let settled = false;
    const settle = (reply: RpcReply): void => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(reply);
    };
    const unsub = events.on(`${channel}:reply:${requestId}`, (reply: any) => settle(reply as RpcReply));
    const timer = setTimeout(() => settle({ success: false, error: `RPC ${channel} timed out after ${timeoutMs}ms` }), timeoutMs);
    events.emit(channel, { ...request, requestId });
  });
}

interface BusTransportDeps {
  events: EventBus;
  /** Resolve the manager registry, or undefined when pi-subagents is absent. */
  getRegistry: () => ManagerRegistry | undefined;
}

/**
 * The pi-subagents bus implementation of {@link FactoryTransport}.
 *
 * Keyed bookkeeping: an RPC-spawned agent's first event is `subagents:started`
 * (no `subagents:created`), so the controller keys off the id spawn returned.
 * Completed results are consumed synchronously inside the handler to suppress
 * pi-subagents' completion notification (docs/rpc.md, the notification race).
 */
export class BusFactoryTransport implements FactoryTransport {
  private ready = false;
  private readonly events: EventBus;
  private readonly getRegistry: () => ManagerRegistry | undefined;
  private readonly started = new Set<(id: string) => void>();
  private readonly completed = new Set<(info: AgentSettleInfo) => void>();
  private readonly failed = new Set<(info: AgentSettleInfo) => void>();
  private readonly unsubs: Array<() => void> = [];

  constructor(deps: BusTransportDeps) {
    this.events = deps.events;
    this.getRegistry = deps.getRegistry;
    this.unsubs.push(
      this.events.on("subagents:started", (raw: any) => {
        const id = raw?.id;
        if (typeof id === "string") for (const cb of this.started) cb(id);
      }),
      this.events.on("subagents:completed", (raw: any) => {
        const info = this.settleInfo(raw);
        if (info) for (const cb of this.completed) cb(info);
      }),
      this.events.on("subagents:failed", (raw: any) => {
        const info = this.settleInfo(raw);
        if (info) for (const cb of this.failed) cb(info);
      }),
    );
  }

  /** Mark pi-subagents as present+bound (called on subagents:ready / ping). */
  markReady(): void {
    this.ready = true;
  }

  isAvailable(): boolean {
    return this.ready;
  }

  dispose(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.started.clear();
    this.completed.clear();
    this.failed.clear();
  }

  /** Explicit probe: ping pi-subagents over the bus. */
  async ping(timeoutMs = 1_000): Promise<boolean> {
    const reply = await rpcCall(this.events, "subagents:rpc:ping", {}, timeoutMs);
    if (reply.success) this.ready = true;
    return reply.success;
  }

  async spawn(req: SpawnRequest): Promise<SpawnOutcome> {
    if (!this.ready) return { ok: false, error: "pi-subagents is not available (no bound session)" };
    // Bind the child to the canonical persisted workspace directory, never an
    // incidental session directory. pi-subagents rejects a non-absolute or
    // non-existent cwd, so a broken workspace rejects the spawn before any
    // child executes.
    if (req.cwd === undefined || req.cwd === "" || !isAbsolute(req.cwd)) {
      return { ok: false, error: `refusing to spawn without a canonical workspace (cwd=${req.cwd})` };
    }
    const options: Record<string, unknown> = {
      description: req.description,
      isolated: req.isolated,
      cwd: req.cwd,
    };
    if (req.model !== undefined) options.model = req.model;
    if (req.maxTurns !== undefined) options.maxTurns = req.maxTurns;
    if (req.schema !== undefined) options.structuredOutput = req.schema;
    const reply = await rpcCall(this.events, "subagents:rpc:spawn", {
      type: req.agentType,
      prompt: req.prompt,
      options,
    }, RPC_SPAWN_TIMEOUT_MS);
    if (reply.success) return { ok: true, agentId: String(reply.data?.id) };
    return { ok: false, error: reply.error };
  }

  stop(agentId: string): void {
    void rpcCall(this.events, "subagents:rpc:stop", { agentId }, 5_000);
  }

  consume(agentId: string): void {
    void rpcCall(this.events, "subagents:rpc:consume", { agentId }, 5_000);
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
    return this.getRegistry()?.getRecord(agentId)?.status;
  }

  /** Merge the lifecycle-event payload with the settled record from the registry. */
  private settleInfo(raw: any): AgentSettleInfo | undefined {
    if (!raw || typeof raw.id !== "string") return undefined;
    const info: AgentSettleInfo = {
      agentId: raw.id,
      ok: raw.status !== "error" && raw.status !== "stopped" && raw.status !== "aborted",
      status: String(raw.status ?? ""),
    };
    if (typeof raw.result === "string") info.result = raw.result;
    if (typeof raw.error === "string") info.error = raw.error;
    if (raw.usage && typeof raw.usage === "object") info.usage = raw.usage as ReportedUsage;
    if (raw.tokens && typeof raw.tokens === "object") {
      info.tokens = {
        input: Number(raw.tokens.input ?? 0),
        output: Number(raw.tokens.output ?? 0),
        total: Number(raw.tokens.total ?? 0),
      };
    }
    if (typeof raw.toolUses === "number") info.toolUses = raw.toolUses;
    if (typeof raw.durationMs === "number") info.durationMs = raw.durationMs;

    // Post-settle record: structured packet, effective model, compaction count.
    const record = this.getRegistry()?.getRecord(raw.id);
    if (record) {
      if (typeof record.structuredJson === "string") info.structuredJson = record.structuredJson;
      if (record.invocation?.modelName !== undefined) info.modelName = record.invocation.modelName;
      if (record.invocation?.modelId !== undefined) info.modelId = record.invocation.modelId;
      if (typeof record.compactionCount === "number") info.compactionCount = record.compactionCount;
      if (typeof record.completedAt === "number") info.completedAt = record.completedAt;
      if (info.status === "" && typeof record.status === "string") info.status = record.status;
      if (info.result === undefined && typeof record.result === "string") info.result = record.result;
      if (info.error === undefined && typeof record.error === "string") info.error = record.error;
    }
    return info;
  }
}

/** Convenience: resolve the manager registry from the global symbol. */
export function globalManagerRegistry(): ManagerRegistry | undefined {
  return (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as ManagerRegistry | undefined;
}
