/**
 * ai-factory/store.ts — Small atomic JSON persistence for Factory runs.
 *
 * The repository has no generic JSON store (persistence primitives are
 * purpose-built: schedules, memory, workflow journals). The spec allows a small
 * atomic JSON representation, so this follows the ScheduleStore pattern:
 * project-scoped `.pi/factory/<runId>.json`, written atomically via temp file +
 * rename, versioned. Factory state holds packets and references only — never
 * child transcripts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FactoryLeaseError, type LeaseStore } from "./lease.js";
import {
  assertValidFactoryRunState,
  assertValidRunId,
  createFactoryCheckpoint,
  parseFactoryRunState,
} from "./recovery-model.js";
import { FACTORY_STATE_VERSION, type FactoryRunState } from "./types.js";

export const FACTORY_DIR = ".pi/factory";

export { assertValidRunId, isValidRunId, validateRunId } from "./recovery-model.js";

/** Where Factory run state files live for a project. */
export function factoryDir(cwd: string): string {
  return join(cwd, FACTORY_DIR);
}

/**
 * Write JSON atomically: create the parent directory, write a temp file, then
 * rename over the target. Reused by the run store, the preset store and the
 * project config writer so every Factory file write is crash-safe.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export class FactoryStore {
  private readonly cwd: string;
  private readonly leaseStore: LeaseStore | undefined;

  constructor(cwd: string, opts: { leaseStore?: LeaseStore } = {}) {
    this.cwd = cwd;
    this.leaseStore = opts.leaseStore;
  }

  /** True when this store enforces per-run exclusive ownership (Task 2). */
  isLeaseBacked(): boolean {
    return this.leaseStore !== undefined;
  }

  /**
   * Acquire exclusive ownership of a run; returns the fencing token. Returns
   * undefined when no lease store is configured. Throws {@link FactoryLeaseError}
   * when another live owner holds the run.
   */
  acquireLease(runId: string): string | undefined {
    if (!this.leaseStore) return undefined;
    const result = this.leaseStore.acquire(runId);
    if (!result.ok) throw new FactoryLeaseError(result.reason, result.detail);
    return result.lease.owner.token;
  }

  /** Like {@link acquireLease} but returns undefined on refusal (restore path). */
  tryAcquireLease(runId: string): string | undefined {
    if (!this.leaseStore) return undefined;
    const result = this.leaseStore.acquire(runId);
    return result.ok ? result.lease.owner.token : undefined;
  }

  /** Release the lease only while the caller still holds the current token. */
  releaseLease(runId: string, token: string): boolean {
    return this.leaseStore?.release(runId, token) ?? false;
  }

  /** Register an unresolved spawn with the process-local ownership registry
   * before the RPC crosses the transport. Plain stores are a no-op success. */
  beginSpawn(runId: string, token: string | undefined): boolean {
    if (!this.isLeaseBacked()) return true;
    return token !== undefined && (this.leaseStore?.beginSpawn(runId, token) ?? false);
  }

  /** The spawn resolved with a live child. */
  childSpawned(runId: string, token: string | undefined, agentId: string): void {
    if (token === undefined) return;
    this.leaseStore?.childSpawned(runId, token, agentId);
  }

  /** A restored run adopted a still-live child. */
  adoptChild(runId: string, token: string | undefined, agentId: string): void {
    if (token === undefined) return;
    this.leaseStore?.adoptChild(runId, token, agentId);
  }

  /** The spawn RPC failed without creating a child. */
  spawnFailed(runId: string, token: string | undefined): void {
    if (token === undefined) return;
    this.leaseStore?.spawnFailed(runId, token);
  }

  /** The child settled; its termination is independently confirmed. */
  endChild(runId: string, token: string | undefined, agentId: string): void {
    if (token === undefined) return;
    this.leaseStore?.endChild(runId, token, agentId);
  }

  /** Whether the current generation still has outstanding spawn/child activity. */
  hasOutstandingActivity(runId: string, token: string | undefined): boolean {
    if (token === undefined) return false;
    return this.leaseStore?.hasOutstandingActivity(runId, token) ?? false;
  }

  pathFor(runId: string): string {
    // This check must precede join(): a user-controlled id must never become a
    // filesystem path before its grammar has been accepted.
    assertValidRunId(runId);
    return join(factoryDir(this.cwd), `${runId}.json`);
  }

  /**
   * Persist a run state atomically (temp file + rename).
   *
   * When the store is lease-backed and a fencing token is supplied, the write
   * is authorized only by the CURRENT lease owner: a stale token, a lost lease,
   * or an ownerless write while a lease is held is rejected, and a state
   * revision behind the persisted one is rejected rather than overwriting it.
   * Legacy (unfenced) saves preserve the Task 1 revision-bump behaviour so
   * direct tool/test snapshots never reuse a revision.
   */
  save(state: FactoryRunState, fenceToken?: string): void {
    const next = structuredClone(state);
    assertValidRunId(next.runId);
    const existing = this.readRaw(next.runId);

    if (this.leaseStore !== undefined) {
      const lease = this.leaseStore.readLease(next.runId);
      if (fenceToken === undefined) {
        if (lease !== undefined) {
          throw new FactoryLeaseError(
            `Cannot write run ${next.runId}: no ownership token supplied while a lease is held by ${lease.owner.pid} on ${lease.owner.hostname}`,
          );
        }
      } else {
        if (lease === undefined) {
          throw new FactoryLeaseError(`Cannot write run ${next.runId}: no valid lease is held; the controller has lost ownership`);
        }
        if (lease.owner.token !== fenceToken) {
          throw new FactoryLeaseError(
            `Cannot write run ${next.runId}: stale ownership token; the run is now owned by ${lease.owner.pid} on ${lease.owner.hostname}`,
          );
        }
        if (existing?.version === FACTORY_STATE_VERSION && typeof existing.stateRevision === "number" && (next.stateRevision ?? 0) < existing.stateRevision) {
          throw new FactoryLeaseError(
            `Cannot write run ${next.runId}: stale state revision ${next.stateRevision ?? 0} is behind persisted revision ${existing.stateRevision}`,
          );
        }
      }
    }

    // Direct test/tools edits of a v2 snapshot are still serialized as a new
    // checkpoint rather than silently reusing a revision. Controller commits
    // already advance the revision before calling save().
    if (next.version === FACTORY_STATE_VERSION) {
      if (existing?.version === FACTORY_STATE_VERSION && typeof existing.stateRevision === "number" && (next.stateRevision ?? 0) <= existing.stateRevision) {
        next.stateRevision = existing.stateRevision + 1;
        next.checkpoint = createFactoryCheckpoint(next, next.stateRevision);
      }
    }
    assertValidFactoryRunState(next, this.cwd);
    writeJsonAtomic(this.pathFor(next.runId), next);
  }

  /** Load a persisted run state, or undefined when absent/corrupt. */
  load(runId: string): FactoryRunState | undefined {
    const file = this.pathFor(runId);
    if (!existsSync(file)) return undefined;
    try {
      return parseFactoryRunState(JSON.parse(readFileSync(file, "utf8")), this.cwd);
    } catch {
      return undefined;
    }
  }

  /** Strict load variant for callers that must distinguish corruption from absence. */
  loadStrict(runId: string): FactoryRunState | undefined {
    const file = this.pathFor(runId);
    if (!existsSync(file)) return undefined;
    return parseFactoryRunState(JSON.parse(readFileSync(file, "utf8")), this.cwd);
  }

  private readRaw(runId: string): FactoryRunState | undefined {
    const file = this.pathFor(runId);
    if (!existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as FactoryRunState; } catch { return undefined; }
  }

  /** All persisted run ids (by filename, excluding temp files). */
  list(): string[] {
    const dir = factoryDir(this.cwd);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".lease.json"))
        .map((f) => f.replace(/\.json$/, ""))
        .filter((id) => {
          try { assertValidRunId(id); return true; } catch { return false; }
        });
    } catch {
      return [];
    }
  }

  /** Delete a run's persisted state and its lease (tests and explicit cleanup). */
  remove(runId: string): void {
    rmSync(this.pathFor(runId), { force: true });
    this.leaseStore?.remove(runId);
  }
}
