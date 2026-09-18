/**
 * ai-factory/presets.ts — User-level named Factory presets.
 *
 * A preset is a complete Factory execution configuration (roles/targets/limits)
 * stored once per user and selected per project. It lives beside pi-subagents'
 * own global settings file, under Pi's global agent directory (honoring
 * `PI_CODING_AGENT_DIR`), so it follows the same relocation convention.
 *
 * This module deliberately does not import config.ts: config.ts imports the
 * raw-preset reader here, and keeping the dependency one-way avoids an import
 * cycle. Normalization/merging happens in config.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeJsonAtomic } from "./store.js";
import type { FactoryConfig } from "./types.js";

export const PRESETS_VERSION = 1 as const;

export interface FactoryPresetsFile {
  version: typeof PRESETS_VERSION;
  presets: Record<string, FactoryConfig>;
}

/** Absolute path to the user-level preset store. */
export function presetsPath(): string {
  return join(getAgentDir(), "factory-presets.json");
}

/** Read the store, tolerating absence/corruption (returns an empty store). */
export function loadPresetsFile(): FactoryPresetsFile {
  const path = presetsPath();
  if (!existsSync(path)) return { version: PRESETS_VERSION, presets: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FactoryPresetsFile>;
    if (raw?.version !== PRESETS_VERSION || raw.presets === null || typeof raw.presets !== "object") {
      return { version: PRESETS_VERSION, presets: {} };
    }
    return { version: PRESETS_VERSION, presets: raw.presets as Record<string, FactoryConfig> };
  } catch {
    return { version: PRESETS_VERSION, presets: {} };
  }
}

/** Preset names, sorted for a deterministic UI. */
export function listPresetNames(): string[] {
  return Object.keys(loadPresetsFile().presets).sort();
}

/**
 * The raw stored config for a preset, or undefined. Returned unnormalized so
 * config.ts can merge it over the built-in defaults (filling any field a preset
 * saved under an older shape did not carry).
 */
export function getRawPreset(name: string): Record<string, unknown> | undefined {
  const preset = loadPresetsFile().presets[name];
  return preset !== null && typeof preset === "object" && !Array.isArray(preset)
    ? (preset as unknown as Record<string, unknown>)
    : undefined;
}

export function hasPreset(name: string): boolean {
  return  Object.hasOwn(loadPresetsFile().presets, name);
}

/** Save (or overwrite) a preset with a complete config. */
export function savePreset(name: string, config: FactoryConfig): void {
  const file = loadPresetsFile();
  file.presets[name] = config;
  writeJsonAtomic(presetsPath(), file);
}

/** Delete a preset. Returns true when one existed. */
export function deletePreset(name: string): boolean {
  const file = loadPresetsFile();
  if (!Object.hasOwn(file.presets, name)) return false;
  delete file.presets[name];
  writeJsonAtomic(presetsPath(), file);
  return true;
}
