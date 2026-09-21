# Architecture Proposal: Factory Checkpoint Resume & Preset Replacement

## Goal

Implement safe checkpoint-based resume and optional preset replacement for AI Factory. Allow a previously interrupted Factory run to resume from its last safe checkpoint, and support explicit replacement of the run's model configuration using an existing saved preset (e.g., switching from exhausted cloud providers to local-only).

---

## Repository Findings

### State Machine (state.ts)
- 14 states: DISCOVERY, INITIAL_ARCHITECT, EXECUTION, REVIEW, ARCHITECT_ESCALATION, INTEGRATION, FINAL_ARCHITECT, REMEDIATION, FINAL_ARCHITECT_RECHECK, FINAL_SYNTHESIS, WAITING_CAPACITY, DONE, STOPPED, FAILED
- 3 terminal states: DONE, STOPPED, FAILED (no transitions out)
- WAITING_CAPACITY is a park state that records `resumeState` — the state to return to when capacity is available
- All transitions are pure code, zero model calls

### Persistence (store.ts)
- Atomic JSON writes to `.pi/factory/<runId>.json`
- Versioned (`FACTORY_STATE_VERSION = 1`)
- Stores packets + references, never child transcripts
- `FactoryStore` class: save/load/list/remove

### Controller (controller.ts)
- `create()` — new run, persists initial state
- `restore()` — loads persisted state, optionally drives it (default resume=true)
- `onRestore()` — handles process restart: in-flight agents treated as failed and retried; parked WAITING_CAPACITY resumes; parked backoff retries clear the park flag
- `stop()` — stops in-flight child, transitions to STOPPED
- `ensureController()` (index.ts) — lazily restores non-terminal runs from session switches or process restarts
- `controllers` Map prevents duplicate in-process controllers

### Commands (commands.ts)
- `/factory` — start a run
- `/factory-status` — read-only status of latest run
- `/factory-stop` — stop active run (restores without resuming)
- `/factory-report` — print final report
- `/factory-metrics` — show operational metrics
- `/factory-config` — interactive config UI
- `/factory-verbose` — visibility mode

### Presets (presets.ts + config.ts)
- Named configs stored in `factory-presets.json` (user-level)
- Resolution order: defaults <- preset <- project overrides <- inline
- `FactoryRunState.config` is the persisted config snapshot — a run resumes with its own config, not the current project config
- `loadPresetAsWorkingConfig()` replaces working config with a preset

### Transport (transport.ts)
- Cross-extension RPC over `pi.events` bus
- `subagents:rpc:spawn`, `subagents:rpc:consume`, lifecycle events
- `classifyError()` — categorizes failures as transient/quota/hard

### Existing Tests
- `controller.test.ts` — state machine, repair loops, escalations, finding fidelity (17 tests)
- `persistence.test.ts` — restart/recovery scenarios (6 tests): in-flight resume, WAITING_CAPACITY resume, completed phase non-duplication, terminal stays terminal, persisted config preservation, backoff retry recovery
- `scenarios.test.ts` — happy path, fallback, capacity wait, remediation (4 tests)
- `commands.test.ts` — slash command dispatch, status, stop, config (14+ tests)
- `state.test.ts` — transition legality table
- `config.test.ts` — config resolution, presets, working-copy semantics

### What is NOT currently implemented
- No `/factory-resume` command exists
- `onRestore()` resumes ALL non-terminal runs indiscriminately — no eligibility check
- No concept of user-stopped vs interrupted in recovery logic
- No preset replacement during resume
- No tracking of which preset was used per phase in metrics
- No explicit handling of FAILED runs for recovery
- No workspace-change detection for interrupted Engineer phases

---

## Current Architecture Summary

### Core Components
- **FactoryController** — deterministic orchestration engine, transport-agnostic, fully tested against FakeTransport
- **FactoryStore** — atomic JSON persistence to `.pi/factory/<runId>.json`
- **FactoryTransport** — cross-extension RPC seam to pi-subagents
- **FactoryConfig** — role model targets, fallbacks, limits; persisted per-run in `FactoryRunState.config`
- **Presets** — user-level named configs in `factory-presets.json`, resolution: defaults <- preset <- project overrides <- inline

### State Machine
- 14 states, 3 terminal (DONE/STOPPED/FAILED)
- WAITING_CAPACITY records `resumeState` for deterministic return
- All transitions are pure code, zero model calls

### Persistence Model
- Versioned atomic JSON (`FACTORY_STATE_VERSION = 1`)
- Stores packets + references, never child transcripts
- `FactoryRunState.config` is the run's own config snapshot

### Current Recovery (onRestore)
- Loads persisted state, resumes driving
- In-flight agents treated as failed, retried from phase 0
- WAITING_CAPACITY resumes with existing retry timing
- Parked backoff clears park flag, fresh spawn
- Terminal runs no-op (returns early)

### Ownership Model
- `controllers` Map in extension entry point
- `ensureController()` lazily restores non-terminal runs
- Session switch disposes all controllers and clears the map
- No cross-process locking mechanism

### Metrics
- Per-role aggregate metrics + append-only per-call telemetry (`calls` array)
- Model identity tracked via `modelId`, `modelName`, `target` fields
- `buildRunMetrics()` degrades gracefully for legacy runs without per-call records

---

## Proposed Solution

### 1. New Command: `/factory-resume`

```
/factory-resume <runId> [--preset <presetName>]
```

- Reads persisted state WITHOUT resuming (like `/factory-stop` uses `resume: false`)
- Evaluates eligibility deterministically based on current state
- If eligible, shows a concise confirmation summary (run ID, checkpoint, original vs replacement preset, action to retry)
- On confirmation, restores and drives the run

### 2. Eligibility Matrix

| State | Eligible? | Action |
|-------|-----------|--------|
| WAITING_CAPACITY | Yes | Resume with original config or replacement preset |
| Active states (DISCOVERY..FINAL_SYNTHESIS) | Yes | Resume from last checkpoint; in-flight phase retried |
| STOPPED | Conditional | Only if stoppedReason indicates a correctable issue (e.g., capacity exhaustion); user must confirm |
| FAILED | Conditional | Only if error is transient/correctable; user must confirm with error details |
| DONE | No | Explicit rejection: "Run already completed" |

### 3. Preset Replacement

**New field on `FactoryRunState`:**
```typescript
presetReplacement?: {
  preset: string;
  snapshot: FactoryConfig;
  appliedAt: number;
}
```

- Preset is resolved through existing preset system and validated against available models
- Only future child invocations use the replacement — no mid-invocation model change
- The original `config` field is preserved as-is (audit trail)
- Metrics record the replacement via a new `replacementPreset` field on `RoleMetrics`

### 4. Interrupted-Phase Safety

Before replaying an interrupted phase, the controller checks:
1. If a valid packet was already persisted → skip (completed phase invariant)
2. If the phase had an in-flight agent → treat as failed, retry from scratch

For Engineer phases: no automatic reconciliation — the Engineer packet captures `changedFiles`, so the user is warned about potential partial workspace changes.

Every accepted phase transition has a valid persisted result packet (invariant preserved).

### 5. Ownership and Concurrency

- **In-process:** `controllers` Map + `ensureController()` prevents duplicate controllers
- **Cross-process:** no unsafe locking; the store atomic writes prevent corruption
- **Same-process duplicate** `/factory-resume` on same runId → rejected with "Run already being driven"
- **Stale ownership after process termination:** `ensureController()` handles this by loading from store

### 6. Metrics Tracking

- New `RoleMetrics.replacementPreset?: string` — records which preset was active when the role ran
- New `CallMetric.replacementPreset?: string` — tracks replacement provenance per call
- Model identity from replacement preset appears correctly in `/factory-metrics` output

### 7. UX Updates

| Command | Purpose |
|---------|---------|
| `/factory-resume <runId>` | Primary resume command |
| `/factory-resume --list` | List resumable runs with their eligibility status |
| `/factory-status` | Shows resumable flag for eligible non-terminal runs |
| `/factory-metrics` | Shows replacement preset in model sequence when applicable |

---

## Assumptions

1. The running Pi process may have loaded an older copy of the extension — we must NOT reload Pi, modify the global installed extension, or restart the orchestrating process.
2. The repository is the Factory development worktree on branch `feature/factory-resume`.
3. Existing mechanisms (atomic JSON store, controller Map, transport RPC) are correct and should be reused.
4. Child agents are in-process — they cannot survive process death, so an in-flight child after restart is always a lost agent.
5. The Engineer may have modified workspace files before producing a valid result packet — these changes are not tracked by the current system.
6. `pi-subagents` is the underlying agent harness; the Factory talks to it only through the documented cross-extension surface.
7. The existing `FactoryRunState.config` snapshot mechanism is correct and should be extended, not replaced.

---

## Constraints

1. Do NOT reload Pi, modify the global installed extension, or restart the orchestrating process.
2. Do NOT implement live model switching during an active child-agent invocation.
3. Do NOT indiscriminately convert all STOPPED/FAILED states into resumable runs.
4. Do NOT silently apply the current `/factory-config` preset to an existing run.
5. Do NOT introduce unsafe locking mechanisms or claim cross-process protection without testing.
6. Do NOT re-run completed phases — every accepted phase transition has a valid persisted result packet.
7. Do NOT create another large interactive UI unless required for safe confirmation.
8. Preserve the existing final-report behavior — do not change it.
9. Prefer replacing model targets and related retry settings while preserving original workflow limits and progress counters.
10. Do NOT commit or push. Do NOT modify the user's existing SongLab project or active Factory run artifacts.

---

## Work Packages

### Work Package 1: State Machine and Type Extensions
- Add `PresetReplacement` interface to `types.ts`
- Add `presetReplacement` field to `FactoryRunState`
- Add `replacementPreset` to `RoleMetrics` and `CallMetric`
- Add `isResumeEligible()` function to `state.ts`

### Work Package 2: Controller Resume Logic
- Add `resume()` public method
- Modify `onRestore()` to use eligibility check
- Add `applyPresetReplacement()`
- Add `getResumeEligibility()`
- Ensure `resume()` checks for in-process duplicate

### Work Package 3: Command Registration
- Add `/factory-resume` command handler with `--preset` argument parsing
- Add eligibility display, confirmation summary
- Add `/factory-resume --list`
- Update `FactoryCommandRuntime` interface
- Update `formatRunStatus()` to show resumable flag

### Work Package 4: Extension Entry Point Updates
- Wire new runtime methods in `index.ts`
- Handle preset replacement validation at spawn time
- Ensure `ensureController()` does not interfere with explicit resume

### Work Package 5: Metrics Tracking
- Update `recordSettleMetrics()` and `appendCallMetric()` to accept and store `replacementPreset`
- Update `buildRunMetrics()` and `formatRunMetrics()` to show replacement preset in model sequence

### Work Package 6: Unit Tests
- Capacity-wait resume with original and replacement config
- Restart at safe checkpoints
- Duplicate resume rejection
- Completed-run rejection
- User-stopped run eligibility
- Failed-run eligibility
- Invalid preset rejection
- Preservation of accepted packets and metrics

### Work Package 7: Persistence Tests
- Interrupted Engineer with partial workspace changes
- No replay of completed phases
- Continued final synthesis and exactly-once final report after resume

### Work Package 8: Command Tests
- `/factory-resume` command dispatch
- `--list` listing
- Preset replacement in commands
- Eligibility explanation display

### Work Package 9: Integration Test
- Controlled restart/resume against temporary test project
- Capacity-wait resume with original and replacement preset
- No intentional exhaustion of paid providers

---

## Dependencies

| Dependency | Reuse Strategy |
|------------|----------------|
| FactoryStore | Atomic JSON persistence (reuse as-is) |
| FactoryController.restore() | Base mechanism for loading persisted state |
| Preset system (presets.ts, config.ts) | Preset resolution and validation |
| FactoryTransport | Spawn/stop/consume RPC seam |
| Metrics system (metrics.ts) | Per-role and per-call telemetry |
| State machine (state.ts) | Transition legality, terminal detection |
| FactoryConfig + mergeFactoryConfig() | Config resolution |
| Test infrastructure (fakes.ts) | FakeTransport, FakeClock, tempStore |

---

## Risks

1. **Interrupted Engineer workspace changes:** The Engineer may have modified files before producing a valid packet. We cannot automatically reconcile these changes. Safest approach: warn the user and let them decide whether to resume or start fresh.

2. **Cross-process ownership:** No unsafe locking mechanism is introduced. The `controllers` Map only protects in-process concurrency. If two Pi processes try to resume the same run simultaneously, the atomic store writes prevent corruption but may cause one to overwrite the other state.

3. **Preset validation timing:** The preset must be validated against currently available models (not the models that were available when the run started). If a model was available at run start but is now gone, the preset replacement should be rejected.

4. **Metrics continuity:** After resume, the per-call telemetry (`calls` array) must correctly attribute which calls used the original config vs the replacement preset.

5. **Backward compatibility with persisted state:** Runs persisted before the `presetReplacement` field existed will have `undefined` for it. Readers must handle this gracefully (already the pattern in metrics.ts with `calls` being optional).

6. **STOPPED run recovery:** The current `stop()` method sets `stoppedReason` but does not distinguish between user stopped and capacity exhausted. We need enough context to determine if recovery is safe.

---

## Acceptance Criteria

1. `/factory-resume <runId>` is a discoverable command that resumes eligible runs
2. `/factory-resume <runId> --preset <name>` replaces the run model config with a saved preset
3. WAITING_CAPACITY runs are resumable with original or replacement config
4. Active-phase runs resume from last checkpoint without re-running completed phases
5. DONE runs are explicitly rejected with "Run already completed"
6. STOPPED/FAILED runs require explicit user confirmation and only recover when safe
7. Invalid or missing preset is rejected with no state mutation
8. Replacement preset is validated against available models before application
9. Only future child invocations use the replacement config — no mid-invocation changes
10. Original config field is preserved as audit trail; replacement is recorded separately
11. Metrics correctly show replacement model identity in per-call records
12. Duplicate resume attempts are rejected
13. In-process duplicate commands are handled gracefully
14. Every accepted phase transition has a valid persisted result packet (invariant preserved)
15. `/factory-status` shows resumable flag for eligible non-terminal runs
16. All existing tests continue to pass
17. New tests cover all specified scenarios

---

## Architectural Questions

1. **STOPPED run recovery granularity:** The current `stoppedReason` is a free-text string. Should we add a structured `stopKind` field (e.g., `user_requested`, `capacity_exhausted`, `remediation_budget`) to make STOPPED recovery decisions more precise? Or is the existing `stoppedReason` text sufficient for the user to decide?

2. **Interrupted Engineer workspace reconciliation:** Should the resume command attempt any automatic workspace reconciliation (e.g., checking if changed files are still valid), or should it always require explicit user acknowledgment? The current system has no file-change tracking, so any reconciliation would be ad-hoc.

3. **Preset replacement scope:** The spec says prefer replacing model targets and related retry settings while preserving the original workflow limits and progress counters. Should we allow replacing ALL role targets, or only specific roles? What about `maxTurns`, `isolated`, and other non-model config fields?

4. **Resume confirmation UX:** Should the resume command require explicit user confirmation (e.g., a `/factory-resume --confirm` flag), or should it auto-confirm for eligible runs with a brief delay? The spec says do not create another large interactive UI unless it is required for safe confirmation.

5. **Cross-process resume coordination:** Is in-process `controllers` Map protection sufficient, or do we need a simple file-based lock (e.g., `.pi/factory/<runId>.lock`) to prevent two Pi processes from simultaneously resuming the same run? The atomic store writes prevent corruption but do not prevent duplicate spawning.

6. **Metrics replacement provenance:** When a preset is replaced mid-run, should the per-call records show both the original and replacement model identities (e.g., `target: p/eng` to `local/llama`), or just the effective target at spawn time? The current system only tracks one target per call.
