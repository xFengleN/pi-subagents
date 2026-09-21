/**
 * ai-factory/lease.ts — Per-run exclusive ownership (local, same-host).
 *
 * Task 2 of the minimum safe recovery contract. A process-local controllers
 * map cannot arbitrate across processes, and atomic JSON replacement prevents
 * partial writes but not two drivers. This module provides a durable per-run
 * lease: an owner file created atomically carrying a unique fencing token, the
 * hostname, the pid, a process identity where reliably available, and the
 * acquisition time.
 *
 * Filesystem guarantees and honest limits (see docs/ownership.md):
 *  - Acquisition uses link(2) with an absent target, which is an atomic
 *    create-if-absent primitive (EEXIST on contention). This is NOT a general
 *    compare-and-swap: the stored token alone never atomically replaces a
 *    different lease.
 *  - Reclamation of a stale lease is a remove-then-create sequence. A loser of
 *    that race re-reads the winner's lease and re-evaluates, so at most one
 *    contender ends up holding the lease, but the sequence is not a single
 *    atomic operation.
 *  - A pid alone does not prove identity. On Linux we store boot_id + proc
 *    starttime; on macOS the `ps` start time. Reclamation of an ALIVE pid is
 *    only permitted when the stored identity provably differs from the current
 *    occupant (pid reuse); otherwise it is conservatively rejected.
 *  - The lease identifies a PROCESS. Within one process the controllers map is
 *    the arbiter; a same-process re-acquisition (e.g. session-switch adoption)
 *    is permitted and re-tokens the lease. Foreign hosts, permission errors,
 *    unparseable lease files, and unverifiable identity are treated
 *    conservatively and never reclaimed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Clock } from "./clock.js";
import { assertValidRunId } from "./recovery-model.js";
import { factoryDir } from "./store.js";

/** Identity of the process this lease store represents as an owner. */
export interface MachineIdentity {
  hostname: string;
  pid: number;
  /** Process start identity when reliably available (guards against pid reuse). */
  processIdentity?: string;
}

/** Outcome of a liveness probe for a pid on this host. */
export type Liveness = { state: "alive" } | { state: "dead" } | { state: "unknown"; reason?: string };

/** Platform seam for process liveness and identity, injectable in tests. */
export interface LeaseProbe {
  liveness(pid: number): Liveness;
  processIdentity(pid: number): string | undefined;
}

/** The persisted owner of a run lease. */
export interface LeaseOwner {
  /** Unique fencing token binding every state write to this acquisition. */
  token: string;
  hostname: string;
  pid: number;
  processIdentity?: string;
  acquiredAt: number;
}

/** The durable lease file payload for one run. */
export interface RunLease {
  runId: string;
  owner: LeaseOwner;
}

export type LeaseAcquireResult =
  | { ok: true; lease: RunLease }
  | { ok: false; reason: string; detail?: string };

/** A lease/fencing violation surfaced to the caller. */
export class FactoryLeaseError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "FactoryLeaseError";
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Process identity                                                           */
/* -------------------------------------------------------------------------- */

function linuxBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function linuxProcStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    // The tail starts at field 3 (state); field 22 (starttime) is index 19.
    const tail = stat.slice(close + 2).trim().split(/\s+/);
    return tail[19];
  } catch {
    return undefined;
  }
}

function darwinStarttime(pid: number): string | undefined {
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    if (out.status !== 0) return undefined;
    const text = (out.stdout ?? "").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A process start identity that survives pid reuse, when the platform exposes
 * one. Linux: boot_id + /proc starttime. macOS: `ps -o lstart`. Other hosts
 * return undefined, which makes ambiguous reclamation fail conservatively.
 */
export function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    const start = linuxProcStarttime(pid);
    return start !== undefined ? `${linuxBootId() ?? "boot-unknown"}:${start}` : undefined;
  }
  if (process.platform === "darwin") return darwinStarttime(pid);
  return undefined;
}

let cachedIdentity: MachineIdentity | undefined;

/** Identity of this process. Cached: it cannot change within a process. */
export function currentMachineIdentity(): MachineIdentity {
  cachedIdentity ??= {
    hostname: hostname(),
    pid: process.pid,
    processIdentity: processStartIdentity(process.pid),
  };
  return cachedIdentity;
}

/** Default liveness/identity probe backed by real OS facilities. */
export const defaultLeaseProbe: LeaseProbe = {
  liveness(pid) {
    if (pid === process.pid) return { state: "alive" };
    try {
      process.kill(pid, 0);
      return { state: "alive" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { state: "dead" };
      // EPERM and similar: the process exists but is not ours to signal. The
      // owner cannot be verified dead — treat conservatively.
      return { state: "unknown", reason: code ?? String(err) };
    }
  },
  processIdentity: processStartIdentity,
};

/* -------------------------------------------------------------------------- */
/* Process-local ownership registry                                           */
/* -------------------------------------------------------------------------- */

/**
 * In-process record of outstanding spawn/child activity per run. Shared by
 * EVERY {@link LeaseStore} instance in this process (module-level), so an
 * independent lease-store cannot bypass the same-process takeover guard. It is
 * retained through controller disposal until the outstanding activity resolves
 * or the process exits, so an unresolved spawn always blocks a replacement
 * controller from acquiring the run and starting a second child.
 */
interface OwnershipRecord {
  /** Fencing token of the current ownership generation in this process. */
  token: string;
  /** Monotonic generation; every acquisition/takeover increments it. */
  generation: number;
  /** Unresolved spawn requests + live children not yet settled/confirmed. */
  outstanding: number;
  /** Agent ids of live children spawned (or adopted) by this process. */
  liveChildren: Set<string>;
}

const processOwnership = new Map<string, OwnershipRecord>();

/** Clear the process-local ownership registry (test support). */
export function resetProcessOwnership(): void {
  processOwnership.clear();
}

/** The record for a run, when it belongs to the current ownership generation. */
function currentRecord(runId: string, token: string): OwnershipRecord | undefined {
  const record = processOwnership.get(runId);
  return record !== undefined && record.token === token ? record : undefined;
}

/** Human-readable refusal when the previous generation is not quiescent. */
function outstandingBlockReason(runId: string): string | undefined {
  const prior = processOwnership.get(runId);
  if (prior !== undefined && prior.outstanding > 0) {
    return `run ${runId}: the previous ownership generation in this process still has outstanding spawn/child activity (${prior.outstanding}); takeover is refused until it is quiescent`;
  }
  return undefined;
}

/**
 * The process-local ownership registry is only used to fence SAME-process
 * ownership transitions. A foreign process's activity is tracked in that
 * process's own registry, so this one is reset when a foreign owner is
 * displaced (or the recorded dead owner is reclaimed).
 */
function registerOwnership(runId: string, token: string, prior?: OwnershipRecord): void {
  processOwnership.set(runId, { token, generation: (prior?.generation ?? 0) + 1, outstanding: 0, liveChildren: new Set() });
}

/* -------------------------------------------------------------------------- */
/* Lease store                                                                */
/* -------------------------------------------------------------------------- */

export interface LeaseStoreDeps {
  cwd: string;
  clock: Clock;
  /** Owner identity; defaults to the current process. */
  identity?: MachineIdentity;
  /** Liveness/identity probe; defaults to the OS-backed probe. */
  probe?: LeaseProbe;
}

/** Parse and structurally validate a lease file for a specific run. */
function normalizeLease(raw: unknown, runId: string): RunLease | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const owner = record.owner as Record<string, unknown> | undefined;
  if (record.runId !== runId) return undefined;
  if (
    !owner
    || typeof owner.token !== "string" || owner.token === ""
    || typeof owner.hostname !== "string" || owner.hostname === ""
    || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.acquiredAt !== "number" || !Number.isFinite(owner.acquiredAt)
  ) return undefined;
  const lease: RunLease = {
    runId,
    owner: { token: owner.token, hostname: owner.hostname, pid: owner.pid, acquiredAt: owner.acquiredAt },
  };
  if (typeof owner.processIdentity === "string" && owner.processIdentity !== "") {
    lease.owner.processIdentity = owner.processIdentity;
  }
  return lease;
}

/** Result of one acquisition attempt; `retry` asks the caller to loop. */
type AcquireAttempt = LeaseAcquireResult & { retry?: boolean };

export class LeaseStore {
  readonly cwd: string;
  private readonly clock: Clock;
  private readonly identity: MachineIdentity;
  private readonly probe: LeaseProbe;

  constructor(deps: LeaseStoreDeps) {
    this.cwd = deps.cwd;
    this.clock = deps.clock;
    this.identity = deps.identity ?? currentMachineIdentity();
    this.probe = deps.probe ?? defaultLeaseProbe;
  }

  /** Path of the lease file for a run (validated id only). */
  leasePath(runId: string): string {
    assertValidRunId(runId);
    return join(factoryDir(this.cwd), `${runId}.lease.json`);
  }

  /** The current lease for a run, or undefined when absent or corrupt. */
  readLease(runId: string): RunLease | undefined {
    return this.readLeaseDetail(runId).lease;
  }

  readLeaseDetail(runId: string): { lease?: RunLease; corrupt?: string; absent: boolean } {
    const file = this.leasePath(runId);
    if (!existsSync(file)) return { absent: true };
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const lease = normalizeLease(raw, runId);
      if (!lease) return { absent: false, corrupt: "lease file is not a valid RunLease for this run" };
      return { absent: false, lease };
    } catch (err) {
      return { absent: false, corrupt: `lease file is not valid JSON: ${(err as Error).message}` };
    }
  }

  /**
   * Acquire exclusive ownership of a run.
   *
   * The first attempt is an atomic create-if-absent (hard link). On EEXIST the
   * existing lease is evaluated: a live same-host owner (or an unverifiable
   * one) rejects the acquisition; a provably dead same-host owner is reclaimed;
   * a foreign host is always rejected. A bounded number of retries absorbs the
   * benign races around concurrent release/reclamation.
   */
  acquire(runId: string): LeaseAcquireResult {
    assertValidRunId(runId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = this.acquireAttempt(runId);
      if (result.ok || result.retry !== true) return result;
    }
    return { ok: false, reason: `run ${runId}: lease contention could not be resolved after retries` };
  }

  private acquireAttempt(runId: string): AcquireAttempt {
    const leasePath = this.leasePath(runId);
    const token = nanoid(24);
    const owner: LeaseOwner = {
      token,
      hostname: this.identity.hostname,
      pid: this.identity.pid,
      acquiredAt: this.clock.now(),
    };
    if (this.identity.processIdentity !== undefined) owner.processIdentity = this.identity.processIdentity;
    const candidate: RunLease = { runId, owner };

    const tmp = `${leasePath}.${token}.tmp`;
    mkdirSync(factoryDir(this.cwd), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    try {
      linkSync(tmp, leasePath);
      rmSync(tmp, { force: true });
      // A lease file should never be absent while this process still has
      // outstanding spawn/child activity for the run (release refuses while
      // outstanding). If it is (explicit removal/tampering), do not start a
      // new generation that could race the still-live child — remove the lease
      // we just created and refuse.
      const blocked = outstandingBlockReason(runId);
      if (blocked !== undefined) {
        rmSync(leasePath, { force: true });
        return { ok: false, reason: blocked };
      }
      registerOwnership(runId, token, processOwnership.get(runId));
      return { ok: true, lease: candidate };
    } catch (err) {
      rmSync(tmp, { force: true });
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return this.evaluateExisting(runId, candidate, leasePath);
    }
  }

  /** Decide what to do with an existing lease after the atomic create failed. */
  private evaluateExisting(runId: string, candidate: RunLease, leasePath: string): AcquireAttempt {
    const detail = this.readLeaseDetail(runId);
    if (detail.absent) {
      // The previous owner released concurrently. Retry the atomic create.
      return { ok: false, retry: true, reason: "lease released concurrently; retrying" };
    }
    if (detail.corrupt !== undefined) {
      return {
        ok: false,
        reason: `run ${runId}: cannot acquire lease — ${detail.corrupt}. Refusing to destroy unverifiable ownership.`,
      };
    }
    const existing = detail.lease!;

    // Same-process takeover: the recorded owner is this same process (a
    // session-switch adoption or a re-restore). In-process arbitration is the
    // controllers map; the lease only fences cross-process contention.
    if (
      existing.owner.pid === this.identity.pid
      && existing.owner.processIdentity !== undefined
      && existing.owner.processIdentity === this.identity.processIdentity
    ) {
      // Same-process takeover: permitted only when the previous ownership
      // generation in this process is demonstrably quiescent. A matching pid
      // or process identity is NOT proof that the previous controller stopped
      // driving — an unresolved spawn or live child blocks the takeover.
      const blocked = outstandingBlockReason(runId);
      if (blocked !== undefined) {
        return { ok: false, reason: blocked, detail: JSON.stringify(existing.owner) };
      }
      if (this.replaceLease(leasePath, candidate)) {
        registerOwnership(runId, candidate.owner.token, processOwnership.get(runId));
        return { ok: true, lease: candidate };
      }
      return { ok: false, retry: true, reason: "lease takeover raced with another process; retrying" };
    }

    if (existing.owner.hostname !== this.identity.hostname) {
      return {
        ok: false,
        reason: `run ${runId} is owned by another host ("${existing.owner.hostname}"); refusing to displace a foreign owner`,
        detail: JSON.stringify(existing.owner),
      };
    }

    const liveness = this.probe.liveness(existing.owner.pid);
    if (liveness.state === "alive") {
      // The pid is alive. It is a different process (pid reuse) only when the
      // stored identity provably differs from the current occupant.
      if (existing.owner.processIdentity !== undefined) {
        const current = this.probe.processIdentity(existing.owner.pid);
        if (current !== undefined && current !== existing.owner.processIdentity) {
          if (this.replaceLease(leasePath, candidate)) return { ok: true, lease: candidate };
          return { ok: false, retry: true, reason: "lease reclamation raced with another process; retrying" };
        }
      }
      return {
        ok: false,
        reason: `run ${runId} is owned by live process ${existing.owner.pid} on this host; refusing to displace a live owner`,
        detail: JSON.stringify(existing.owner),
      };
    }
    if (liveness.state === "unknown") {
      return {
        ok: false,
        reason: `run ${runId}: cannot verify whether owner process ${existing.owner.pid} is alive (${liveness.reason ?? "unknown"}); refusing ambiguous reclamation`,
        detail: JSON.stringify(existing.owner),
      };
    }

    // Provably dead on this host: reclaim. The remove-then-create sequence is
    // not atomic (docs/ownership.md); a lost race re-reads the winner's lease.
    // The recorded owner is a different (dead) process, so this process's own
    // registry is re-seeded for the new generation.
    if (this.replaceLease(leasePath, candidate)) {
      registerOwnership(runId, candidate.owner.token, processOwnership.get(runId));
      return { ok: true, lease: candidate };
    }
    return { ok: false, retry: true, reason: "lease reclamation raced with another process; retrying" };
  }

  /** Replace the current lease file with `candidate`; false when the race was lost. */
  private replaceLease(leasePath: string, candidate: RunLease): boolean {
    const tmp = `${leasePath}.${candidate.owner.token}.tmp`;
    mkdirSync(factoryDir(this.cwd), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    rmSync(leasePath, { force: true });
    try {
      linkSync(tmp, leasePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    rmSync(tmp, { force: true });
    return true;
  }

  /**
   * Release a lease, but only when the caller still holds the current token
   * AND no outstanding spawn/child activity remains. A token mismatch means
   * ownership was lost or taken over — the lease of the current owner is never
   * removed. Outstanding activity (an unresolved spawn or a child whose
   * termination is not independently confirmed) retains ownership.
   */
  release(runId: string, token: string): boolean {
    const detail = this.readLeaseDetail(runId);
    if (detail.absent) return false;
    if (detail.corrupt !== undefined) return false;
    if (detail.lease!.owner.token !== token) return false;
    const record = currentRecord(runId, token);
    if (record !== undefined && record.outstanding > 0) return false;
    rmSync(this.leasePath(runId), { force: true });
    if (record !== undefined) processOwnership.delete(runId);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Outstanding spawn / child accounting (process-local registry)      */
  /* ------------------------------------------------------------------ */

  /** Register an unresolved spawn BEFORE the RPC crosses the transport. */
  beginSpawn(runId: string, token: string): boolean {
    const record = currentRecord(runId, token);
    if (!record) return false;
    record.outstanding++;
    return true;
  }

  /** The spawn resolved with a live child; the child stays outstanding. */
  childSpawned(runId: string, token: string, agentId: string): void {
    const record = currentRecord(runId, token);
    if (!record) return;
    record.liveChildren.add(agentId);
  }

  /** A restored run adopted a still-live child; track it as outstanding. */
  adoptChild(runId: string, token: string, agentId: string): void {
    const record = currentRecord(runId, token);
    if (!record) return;
    record.outstanding++;
    record.liveChildren.add(agentId);
  }

  /** The spawn RPC failed without creating a child. */
  spawnFailed(runId: string, token: string): void {
    const record = currentRecord(runId, token);
    if (!record) return;
    if (record.outstanding > 0) record.outstanding--;
  }

  /** The child settled (completion/failure), independently confirming its end. */
  endChild(runId: string, token: string, agentId: string): void {
    const record = currentRecord(runId, token);
    if (!record) return;
    if (record.liveChildren.delete(agentId) && record.outstanding > 0) record.outstanding--;
  }

  /** Whether the current generation still has outstanding spawn/child activity. */
  hasOutstandingActivity(runId: string, token: string): boolean {
    const record = currentRecord(runId, token);
    return record !== undefined && (record.outstanding > 0 || record.liveChildren.size > 0);
  }

  /** Explicit lease removal (used with run-state cleanup). */
  remove(runId: string): void {
    rmSync(this.leasePath(runId), { force: true });
  }
}
