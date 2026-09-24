# AI Factory

A lean, deterministic orchestration layer on top of pi-subagents. It runs one
"factory" — a Lead, an Architect, an Engineer and a Reviewer — through a
persisted state machine, with fresh bounded contexts and no hidden model calls.

## Purpose

The Factory automates a full coding task as a fixed pipeline:

```
USER TASK
  → Lead reconnaissance + architecture proposal
  → mandatory INITIAL_ARCHITECT gate
  → approved targets: Engineer implements → Reviewer assesses correctness
  → bounded per-target Engineer/Reviewer repair loop, then next eligible target
  → Lead integration + system verification (only after all targets pass)
  → mandatory FINAL_ARCHITECT acceptance gate
  → (one bounded remediation cycle, one recheck)
  → mandatory FINAL_SYNTHESIS (final Lead report of the accepted state)
  → DONE / STOPPED
```

Two kinds of decisions:

- **Deterministic decisions — code owns them.** What phase comes next, whether
  a checkpoint ran, repair/remediation counters, retry/fallback selection,
  capacity waiting, persistence/recovery, legality of a transition. None of
  these ever costs a model turn.
- **Semantic decisions — models own them.** Reconnaissance, architecture,
  implementation, correctness assessment, integration, final acceptance. These
  happen *inside* role agents, never in the controller.

## Architecture

```
src/ai-factory/
  index.ts        pi extension entry: Factory + factory_status tools, discovery
  transport.ts    seam to pi-subagents (cross-extension RPC + manager registry)
  controller.ts   the deterministic state machine (pi-free, fully tested)
  state.ts        legal transition table (illegal transitions throw)
  packets.ts      structured handoff packets (schemas + parsing)
  prompts.ts      deterministic role prompts (packets in, no parent context)
  config.ts       role → model targets, agent types, limits; .pi/factory.json
  metrics.ts      per-role token/cost accounting + run summary
  store.ts        small atomic JSON persistence (.pi/factory/<runId>.json)
  targets.ts      approved target graph, deterministic serial eligibility/blocking
  clock.ts        injectable clock (fake clock drives multi-hour waits in tests)
  panel.ts        visibility-mode vocabulary, target resolution, compact summary
  panel-widget.ts the compact orchestration widget (above the editor)
  live-view.ts    focused live transcript overlay (reuses pi-subagents' viewer)
```

The Factory is a **second pi extension** in this package
(`package.json` → `pi.extensions`). It talks to pi-subagents only through the
documented cross-extension surface: `subagents:rpc:spawn` / `subagents:rpc:consume`,
the `subagents:started/completed/failed` events, and the
`Symbol.for("pi-subagents:manager")` registry for post-settle details. It never
reaches into pi-subagents internals and never spawns through the model-mediated
`Agent` tool.

## Roles

| Role | What it does | Fresh context | Backend |
|---|---|---|---|
| Lead | recon, architecture proposal, integration/verification, escalation disposition | yes, per phase | configured primary + equivalent fallbacks |
| Architect | initial gate, mid-run escalation, final acceptance | yes, per checkpoint | configured primary; conservative fallback (wait, never silently degrade) |
| Engineer | implements one work package, runs fundamental tests, returns a completion packet | yes, per run/repair | configured primary + permissive fallback chain |
| Reviewer | independent implementation-correctness verdict (never architecture) | yes, per review | configured primary; quality-floor targets |

Child agents are spawned **isolated** (no parent extensions/skills/nested
tools) with **fresh contexts** (`inheritContext` is never set). Each child must
report through a `StructuredOutput` tool whose schema is the packet type it is
expected to produce; the controller has a lenient prose fallback.

## Deterministic vs semantic boundary

- The controller has **no model client**. It only calls `transport.spawn`,
  `transport.consume`, `transport.stop`, and reacts to lifecycle events.
- A deterministic transition (Reviewer PASS → next eligible target, or to
  INTEGRATION when all approved targets passed; counter checks; capacity
  waiting; consuming a child result) causes **zero model requests**.
- The only model-mediated dispatches are the role runs themselves; there is no
  "ask the Lead what to do next" consult, no message relay between Engineer and
  Reviewer (the controller mediates with only the concrete findings).

## State diagram

```
START → DISCOVERY ──Lead proposal──▶ INITIAL_ARCHITECT ──APPROVE/CORRECT──▶ EXECUTION
EXECUTION ──Engineer packet──▶ REVIEW
REVIEW ──PASS──▶ next eligible target's EXECUTION; all passed ──▶ INTEGRATION
REVIEW ──NEEDS_FIX, rounds left──▶ EXECUTION            (bounded local loop)
REVIEW / EXECUTION ──architectural──▶ ARCHITECT_ESCALATION ──Architect──▶ EXECUTION
INTEGRATION ──Lead acceptance packet──▶ FINAL_ARCHITECT
FINAL_ARCHITECT ──ACCEPT──▶ FINAL_SYNTHESIS
FINAL_ARCHITECT ──NEEDS_REMEDIATION, rounds left──▶ REMEDIATION
REMEDIATION ──Engineer + Reviewer PASS──▶ dependent revalidation (when needed) ──▶ FINAL_ARCHITECT_RECHECK
FINAL_ARCHITECT_RECHECK ──ACCEPT──▶ FINAL_SYNTHESIS
FINAL_ARCHITECT_RECHECK ──reject (budget spent)──▶ STOPPED
FINAL_SYNTHESIS ──Lead report persisted──▶ DONE
any active state ──all targets unavailable──▶ WAITING_CAPACITY ──capacity──▶ resume
any active state ──unrecoverable──▶ FAILED / STOPPED
```

`FINAL_SYNTHESIS` is the mandatory finalization gate: **every** accepted run,
including one that went through remediation, must produce exactly one bounded
final Lead synthesis before `DONE`. It is a synthesis of accepted evidence only
— it cannot modify repository files, spawn agents, or reopen remediation. The
accepted state it describes is the post-remediation state when one exists; the
earlier rejected `results.integration` packet and both Architect gate packets
remain preserved as audit history.

Illegal transitions are rejected programmatically (`assertTransition`), so a
run can never skip a mandatory checkpoint (e.g. Engineer before the initial
Architect).

### Approved target plan

New runs persist version-3 `targetPlan` alongside the approved architecture.
The Lead proposes structured targets (`id`, `description`, `dependsOn`,
`acceptanceCriteria`, optional `requiresArchitectAcceptance`) and extracts
explicit human requirements, constraints, and dependencies. Before Architect
review, code assigns deterministic per-run IDs (`REQ-001`, …) to the Lead's
requirement/constraint inventory and persists that catalog with the original
task and proposal. The initial Architect receives those ID/text pairs, assesses
the original request, maps each ID exactly once to approved target IDs, marks
preserved constraint IDs, reports uncovered requirements, and returns the
complete `approvedTargets` graph. Coverage identity is the ID, not requirement
wording: Architect assessment text may paraphrase or split requirements and
acceptance criteria may be refined, split, or rewritten. A missing, duplicate,
unknown, or unmapped ID still rejects approval, as does an unpreserved explicit
constraint, unresolved coverage, removal of a user-mandated dependency, or an
invalid graph. Architect approval must contain exactly the Lead's proposed
implementation target ID set: it may refine descriptions, criteria, inferred
dependencies, and architectural constraints, but may not add, remove, or rename
targets. Requested target-specific tests belong to those targets. Cross-target
validation/integration, the final Architect acceptance gate, and evidence-based
final reporting remain in the existing Factory lifecycle, not implementation
targets. Requirements about those lifecycle activities remain in the REQ
catalog and are attributed to the affected implementation targets for coverage;
the lifecycle still executes the system-level checks and report. If a genuine
implementation deliverable cannot be assigned to any existing target without
weakening a requirement, Architect must return CLARIFY with the exact REQ IDs,
missing deliverable, reason, and request for an owner-authorized revised Lead
plan. This stops the run before engineering; it does not trigger an automatic
retry or another Architect call. For multi-target runs the explicit graph and
assessment are mandatory even for APPROVE; an unchanged Lead proposal is not
implicitly Architect approval. `dependsOn` edges listed separately as
`humanDependencies` are user-mandated; other proposed edges are
technical/inferred and may be corrected without claiming the user required
that ordering. CLARIFY or incomplete approval stops safely.

The controller verifies graph structure, preserves explicit human dependency
edges, and checks the Architect's identity mappings and constraint assertions.
It cannot independently prove that the Lead extracted every original
requirement or that a mapped target truly satisfies one: semantic mission
coverage remains an Architect judgment and requires live-model/human
assessment. Multiple plain-text work packages without explicit
Architect-approved targets do **not** silently collapse into WP0. A legacy
one-package request retains its economical fallback without extra role calls.
Historical snapshots without the ID catalog retain their original
validation/recovery semantics and are never rewritten; new multi-target plans
require the identity-aware assessment.

The scheduler considers targets in declaration order, choosing the first whose
prerequisites have Reviewer PASS evidence. One Engineer/Reviewer pair runs at a
time in the **same working tree**; there are no parallel worktrees or automatic
integration merges. A target that exhausts its correction allowance fails,
transitively blocks dependents, and does not prevent independent targets from
running. Integration and mission-level acceptance require *every* target to
pass; a partial result remains STOPPED. A per-target Architect check runs only
when explicitly required or escalated; unsafe amendments of accepted target
contracts are rejected rather than quietly replayed. Reviewer PASS is the
normal per-target acceptance gate; the final Architect remains the mission gate.

For multi-target final rejections the Architect must specify exactly one
`affectedTargetIds` entry, or `integrationOnly: true`. Remediation is restricted
to that scope; passed dependents of a corrected target receive fresh Reviewer
revalidation in dependency order before final recheck, even if targets were
declared out of order. An interrupted run labels unreviewed dependents as
awaiting revalidation, not completed. A failed scoped remediation marks its
target failed and passed dependents blocked instead of retaining stale PASS
status. A failed dependent revalidation blocks only that target's actual
descendants; independent affected siblings continue through revalidation
before the mission stops without acceptance. If a correction affects a target
that requires renewed Architect acceptance, the run stops rather than treating
stale approval as valid. Scope that cannot be identified uniquely also stops;
unresolved work needs a new explicitly scoped task. The pre-remediation
integration packet remains historical, not an assertion that the corrected
workspace was integrated.

## Configuration

`<cwd>/.pi/factory.json` — plain JSON, no model involved. Defaults live in
`src/ai-factory/config.ts`. Per-call overrides can be passed to the `Factory`
tool.

```json
{
  "roles": {
    "lead":     { "targets": { "primary": "openai-codex/gpt-5.5", "fallbacks": ["openai-codex/gpt-5.4"] } },
    "architect":{ "targets": { "primary": "openai-codex/gpt-5.5" } },
    "engineer": { "targets": { "primary": "openai-codex/gpt-5.4", "fallbacks": ["openai-codex/gpt-5.3-codex-spark"] } },
    "reviewer": { "targets": { "primary": "openai-codex/gpt-5.4", "fallbacks": ["openai-codex/gpt-5.5"] } }
  },
  "maxRepairRounds": 1,
  "maxArchitectRemediationRounds": 1,
  "defaultRetryAfterMs": 1800000
}
```

See `examples/ai-factory/` for a full example (including role agent files).

### Slash commands and presets

Factory is usable directly from Pi's command line — the currently selected main
model plays no part in starting, inspecting, stopping or configuring a run:

| Command | What it does |
|---|---|
| `/factory [task]` | Starts a run deterministically. Uses the text after the command as the task; with no text it opens the task editor. Prints the runId and initial state. A compact run panel appears above the editor showing orchestration state (run id, state, active role/phase/model, counters) — it deliberately does not duplicate the pi-subagents agent tree. Every terminal outcome (`DONE`, controlled `STOPPED`, or `FAILED`) appends an evidence-based final report automatically as a normal rendered (Markdown) message at the bottom of the conversation. Reporting is observational: it never changes the terminal state or verdict. |
| `/factory-verbose [mode]` | Selects what the Factory's focused live view shows (read-only; no model call). With no argument it reports the current mode and usage. Modes: `on` (follow the active agent, then the last finished one — the default), `off` (compact progress only, no live view), `active` (only the running agent, following phase changes), a role (`lead`/`architect`/`engineer`/`reviewer`, the latest agent of that role), or an exact phase (e.g. `execution.engineer`, that phase's agent). For every mode except `off` the command opens a scrollable, live-updating transcript overlay (Esc closes it) that reuses pi-subagents' own conversation viewer; `/agents` remains the full history. The mode is a session-scoped UI preference, independent of Factory configuration and persisted run data, and never affects execution. Invalid arguments show usage and never invoke a model. |
| `/factory-status` | Compact read-only status of the latest run for the project. Live: state/phase, active role and model, repair/remediation counts, retries, fallbacks, capacity waits, elapsed. Completed: final verdict, duration, remediation rounds, final HEAD, commit count, validation summary, human-verification state, per-role last target. Never prints the full report and never spends a request. |
| `/factory-report [runId]` | Prints the human-readable final report again for the latest terminal run, or for an explicit run id. Reads persisted state only — no model call — and is not suppressed by the automatic-delivery marker. Legacy runs without a final Lead synthesis use the latest authoritative Architect outcome first, then the integration fallback where valid, all clearly labelled. |
| `/factory-metrics [runId]` | Appends operational metrics for the latest run, or an explicit run id, as a normal message at the current bottom of the conversation: per-role calls and tokens, cost, context sizes, slowest call, and orchestration counters. Reads persisted state only. |
| `/factory-stop` | Stops the latest active run using the controller lifecycle. Restores without resuming, so stopping an orphaned run cannot spawn an agent first. |
| `/factory-resume <runId> [--preset <name>]` | Inspects an interrupted run read-only (state, phase, completed vs incomplete work, recovery checkpoint, next-action classification) and resumes it after confirmation where necessary. Preserves all completed packets and never replays a finished phase. Safe automatic continuation (clean checkpoints, WAITING_CAPACITY) proceeds directly; an interrupted Engineer whose workspace outcome is uncertain requires explicit approval (acknowledging the workspace is used as-is) before exactly one new attempt. `--preset <name>` swaps ONLY future children's model targets/fallbacks/retry/turn limits to a saved preset — workflow budgets, isolation, and the original config history are preserved. DONE/STOPPED/FAILED runs are not resumed. |
| `/factory-config` | Interactive menu: per-role primary/fallback models (chosen from Pi's available-model registry), transient retries/delay/max-turns, limits, and preset management. |

The config menus render on Pi's `SettingsList`, so navigation **wraps** (down on
the last row goes to the first, up on the first goes to the last). The top level
is grouped into labelled sections (`ROLES`, `CONFIG`, `EXECUTION`, `PI CHAT`,
`ACTIONS`) with a per-row `*` marking anything that differs from the base preset.
Role rows are the controls: entering `Primary`/`Fallbacks`/`Retries`/`Retry
delay`/`Max turns` edits the working config directly — there are no separate
"set/add/remove" actions. Fallbacks open a focused screen supporting add,
remove, and move up/down (stored order is execution priority).

Model selection is a **type-to-filter picker** built on Pi's own `fuzzyFilter`
(plus `SelectList`/`Input`), accepting forgiving fragments like `v4.1`,
`glm 5.3`, `codex spark` or `qwen 27`; it searches provider, id and display
name, wraps around, and writes the canonical `provider/id`. Pi's internal
`ModelSelectorComponent` is not reusable from an extension (it requires a
`SettingsManager` and `ModelRuntime` the public context does not expose), so the
picker reuses the same underlying primitives.

**Presets.** A preset is a complete Factory execution config stored once per
user at `<getAgentDir()>/factory-presets.json` (thence honoring
`PI_CODING_AGENT_DIR`, alongside pi-subagents' own `subagents.json`). The
`/factory-config` UI can save the current config as a named preset, overwrite
(with confirmation), delete (with confirmation), and select the active preset.

**Resolution order** (per project):

```
built-in defaults
  → preset named by ".pi/factory.json" { "preset": "<name>" }
  → ".pi/factory.json" overrides
  → inline `Factory({ config })` overrides
```

A project file with no `preset` key resolves exactly as before, so existing
configs are unaffected.

**Base preset vs effective configuration (working copy).** The config UI keeps
two concepts explicit:

- the **base preset** is an immutable saved snapshot the project selected; and
- the **working configuration** is what the next `/factory` run will actually
  use (`defaults <- base preset <- project overrides`).

Editing any role/limit writes a project override and takes effect immediately —
no preset save is required, and no saved preset is mutated. The top level shows
the working configuration for the next run, marking only the rows that differ:

```
Factory configuration — effective for next run
Lead       openai-codex/gpt-5.3-codex-spark  *
Architect  opencode-go/glm-5.3
Engineer   opencode-go/deepseek-v4.1-flash
Reviewer   opencode-go/glm-5.3-flash
Configuration: Modified
Based on: go-balanced
* differs from go-balanced
```

When unmodified it reads simply `Configuration: go-balanced`. `dirty` is a
deterministic deep comparison of the resolved preset against the effective
config — no mutable flag.

**Loading a preset is a REPLACE.** `Load preset` (and `Load another preset…`)
clears every project override and installs the chosen preset, so the effective
config equals that preset immediately; it never layers old overrides on top. If
the working config is modified, the UI confirms that unsaved changes will be
discarded first. `Revert to <base>` does the same for the currently selected
preset.

When modified, `Presets…` offers `Revert to <base>`, `Save as new preset…`
(snapshot of the working config; the old preset is untouched), `Update <base>…`
(confirmed overwrite), `Load another preset…`, and `Delete preset…`.

`/factory-status` is **historical/current-run state**, labelled `Run
configuration snapshot`, and never mixed with next-run configuration.

**Model scopes (Factory roles vs Pi chat).** The active preset / project config
controls **only** the models the Factory role agents run on. Pi's ordinary chat
model is separate and is shown in `/factory-config` (`Pi chat model: …`). Saving,
activating or deleting a preset never changes Pi's chat model. The UI offers an
explicit, opt-in `Pi chat model` item (Leave unchanged / Same as Factory Lead /
Choose model…) via `pi.setModel`; the default is Leave unchanged, and it only
acts when the user selects it. Normal messages stay normal Pi messages — Factory
runs only when invoked via `/factory` or the `Factory` tool.

### Fallback semantics

Per-role ordered targets (`primary` then `fallbacks`). Role identity never
changes during fallback — fallback is about **availability**, never task
difficulty.

- `transient` (timeout, 5xx, connection reset): bounded same-target backoff
  retries, then the next fallback.
- `quota` / capacity exhaustion: advance to the next fallback immediately.
- `hard` (model not found, auth, unknown agent type): do not hop — surface
  through `FAILED` with a structured error.
- all targets exhausted: **WAITING_CAPACITY** — park, persist `nextRetryAt`
  (provider retry-after when parseable, else `defaultRetryAfterMs`), resume
  with no LLM call. `WAITING_CAPACITY` is purely timer/clock driven.

## Persistence

Run state lives at `<cwd>/.pi/factory/<runId>.json` (atomic write, versioned).
It holds packets and references only — never child transcripts. Version-3
snapshots also hold target order, dependencies, statuses, per-target Reviewer
and Engineer evidence IDs, the active target and revalidation queue. On restart:

- completed targets and phases are never re-run (their packets are in the store);
- an interrupted Engineer with uncertain workspace effects requires the
  existing explicit recovery approval before any new attempt; a clean accepted
  target boundary safely selects its next eligible target;
- a `WAITING_CAPACITY` run restores its `nextRetryAt` and wakes on the clock.

`results.finalReport` is the final Lead synthesis for the actual accepted
state; `results.integration`, `results.finalArchitect` and
`results.finalRecheck` are never overwritten by it, so the full acceptance
history survives. Older run files that predate these fields stay readable: the
commands degrade gracefully (and `/factory-report` labels a legacy fallback).

**`.pi/` ownership.** `<cwd>/.pi/factory.json` is project configuration — it is
hand-edited (or written by `/factory-config`) and may be committed. Everything
under `<cwd>/.pi/factory/` is a per-run runtime artifact: treat it as
untracked output and add `.pi/factory/` to the project's `.gitignore`. Factory
never commits run artifacts.

## Run panel and final-output rendering

While a `/factory` run is active, the Factory shows a compact above-editor panel
with the run id, state, the active role/phase/model and the orchestration
counters (repair/remediation rounds, retries, fallbacks, capacity waits). It
deliberately does **not** list agents or render transcripts: pi-subagents' own
agent tree is the single agent list, and a full transcript cannot live safely in
the tiny non-scrollable widget (custom session entries are append-only and not
re-rendered live; custom *messages* would pollute the parent model's context).

Live detail therefore lives in a **focused, scrollable overlay** opened by
`/factory-verbose`. The overlay reuses pi-subagents' own `ConversationViewer` —
the same live, scrollable surface `/agents → Enter` opens — and subscribes to the
retained agent session, so assistant prose, tool calls, tool results and shell
commands/output stream in real time (never chain-of-thought). The Factory wrapper
re-resolves the target on a timer, so `on`/`active` follow the running agent as
phases change and a not-yet-spawned role/phase target appears when it starts. It
is read-only: the Factory controller owns stop and steering. Esc closes the
overlay; arrows / PgUp / PgDn scroll.

The mode is UI state, deliberately separate from Factory execution configuration
and persisted run data, and it is preserved across runs in the same pi session
(a session switch disposes the panel but does not reset the preference).
`/factory-agent` remains registered as a deprecated alias over the same state —
it is not a second visibility system, and it is no longer advertised.

Because the panel is a fixed few lines and the transcript lives in the overlay,
there is no widget truncation: the underlying transcript is never deleted or
mutated, and the full inspection remains available through `/agents → Enter`.

At every terminal outcome the final report is appended to the conversation as a
normal rendered message at the bottom: the same single-source formatter
`/factory-report` uses, with section titles promoted to Markdown headings, sent
through pi's custom-message renderer (the same mechanism pi-subagents uses for
its completion notifications). `DONE` keeps its accepted final synthesis.
`STOPPED` keeps its rejecting verdict and includes the failed gate, counters,
per-target passed/failed/blocked/not-attempted/awaiting-revalidation status and packet-sourced artifacts,
available partial/incomplete-work and validation evidence, a bounded recovery
recommendation, and the artifact path; `FAILED` is explicitly labelled as a
runtime/unrecoverable failure rather than a controlled rejection. Missing
optional evidence is omitted or labelled unavailable rather than inferred.

Automatic delivery uses a durable sidecar marker beside the run artifact, so
repeated terminal callbacks, status refreshes, and ordinary session rehydration
do not print the report twice. The message is sent before the marker is written:
if the process crashes in that narrow interval, or the marker write fails,
rehydration may print a duplicate. This is intentionally at-least-once rather
than a false exactly-once claim.
`/factory-report` is an explicit recall and always prints again without changing
the marker. `/factory-status` is read-only and never triggers delivery.
`/factory-metrics` likewise appends its output as a normal message at the
invocation point rather than updating a top status region.

## Metrics

Per role/agent: actual model (when exposed), input/output/cacheWrite tokens
(logical work), cache-read tokens (reported separately, never conflated),
billed cost, tool uses, duration, compaction count, attempts, retries,
fallbacks. A metric a provider does not expose stays **unknown** — never a
fabricated zero. `factory_status` returns a compact machine-readable run
summary at completion.

Every settled call is also appended to an append-only per-call record
(`metrics.calls`), so `/factory-metrics` can report honest totals, request
context sizes and the slowest call instead of only the last settle per role.
TTFT and generation tokens/second are **not** captured by the transport and are
shown as `n/a`; they are never inferred. A run persisted before per-call
telemetry existed sets a legacy flag and reports the last reported call per
role, clearly labelled.

## Running a minimal example

```bash
# 1. install this extension into pi
pi install /path/to/pi-subagents

# 2. configure roles interactively (writes <cwd>/.pi/factory.json)
#    inside a pi session:
/factory-config

# 3. start a run directly — no model has to decide to call Factory
/factory add a widgets package with tests

# 4. choose what the live view shows (default: on), then inspect / stop
/factory-verbose active   # opens a live transcript overlay following the run; off/<role>/<exact-phase> also work
/factory-status
/factory-report      # reprint the latest terminal report (DONE/STOPPED/FAILED)
/factory-metrics     # per-call tokens, cost, context and orchestration counts
/factory-stop
```

The model-mediated path still exists for programmatic use: the main model can
call `Factory({ task })`, then `factory_status({ run_id, wait: true })`.

Optionally install the role agent files from `examples/ai-factory/agents/` into
`.pi/agents/` for role-appropriate tool sets (e.g. read-only Reviewer). Without
them the roles fall back to `general-purpose` (still isolated).

## Known limitations

- One Engineer runs at a time, even for multiple approved targets. Semantic
  coverage and dependency intent remain Architect judgments; the controller
  validates structure and order, not the truth of repository descriptions.
- A repair "round" spawns a fresh Engineer with the concrete findings; true
  in-session resume/steer of the same child is not exposed over the RPC bus and
  is deferred.
- `modelRequests` in the summary counts role-agent runs spawned, not
  per-turn provider requests (pi does not expose per-agent turn counts).
- Fallback is configuration, not inference: no difficulty classification, no
  autonomous benchmarking, no quota forecasting.

## Intentionally deferred

- easy/medium/hard Engineer routing; autonomous model benchmarking; quota
  forecasting dashboards; provider usage scraping; bounty hunting;
  PO/stakeholder/UI roles; nested agent hierarchies; councils/swarms/voting;
  missions; autonomous schedules; persistent agent memory; a generic workflow
  product; web/mobile clients; automatic merge-conflict resolution.
- Parallel dependency-aware work packages + worktree isolation (Phase 3) —
  design only.
