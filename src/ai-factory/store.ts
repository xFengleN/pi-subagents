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
import { FACTORY_STATE_VERSION, type FactoryRunState } from "./types.js";

export const FACTORY_DIR = ".pi/factory";

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
  constructor(private readonly cwd: string) {}

  pathFor(runId: string): string {
    return join(factoryDir(this.cwd), `${runId}.json`);
  }

  /** Persist a run state atomically (temp file + rename). */
  save(state: FactoryRunState): void {
    writeJsonAtomic(this.pathFor(state.runId), state);
  }

  /** Load a persisted run state, or undefined when absent/corrupt. */
  load(runId: string): FactoryRunState | undefined {
    const file = this.pathFor(runId);
    if (!existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as FactoryRunState;
      if (raw?.version !== FACTORY_STATE_VERSION || typeof raw.runId !== "string") return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  /** All persisted run ids (by filename, excluding temp files). */
  list(): string[] {
    const dir = factoryDir(this.cwd);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  /** Delete a run's persisted state (used by tests and explicit cleanup). */
  remove(runId: string): void {
    rmSync(this.pathFor(runId), { force: true });
  }
}
