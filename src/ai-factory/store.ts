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
import { join } from "node:path";
import { FACTORY_STATE_VERSION, type FactoryRunState } from "./types.js";

export const FACTORY_DIR = ".pi/factory";

/** Where Factory run state files live for a project. */
export function factoryDir(cwd: string): string {
  return join(cwd, FACTORY_DIR);
}

export class FactoryStore {
  constructor(private readonly cwd: string) {}

  pathFor(runId: string): string {
    return join(factoryDir(this.cwd), `${runId}.json`);
  }

  /** Persist a run state atomically (temp file + rename). */
  save(state: FactoryRunState): void {
    const dir = factoryDir(this.cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const target = this.pathFor(state.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, target);
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
