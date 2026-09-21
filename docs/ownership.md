# Factory exclusive ownership and fenced persistence

This guide documents Task 2 of Factory recovery: durable, per-run exclusive
ownership and fenced state persistence for local, same-host recovery.

## Why a lease

A process-local controllers map cannot arbitrate across processes. Atomic JSON
replacement (`writeJsonAtomic`: temp file + rename) prevents partial writes but
does not prevent two processes from driving the same run — both would read the
same state and spawn their own children.

Task 2 adds a durable per-run lease that is the ownership authority. The
in-process `controllers` map remains a cache of active controllers only.

## Lease file

Each run may have `.pi/factory/<runId>.lease.json`:

```json
{
  "runId": "factory_xxx",
  "owner": {
    "token": "<nanoid>",
    "hostname": "<os.hostname()>",
    "pid": 12345,
    "processIdentity": "boot:1234.5678 | Thu Apr 10 09:15:22 2025",
    "acquiredAt": 1710000000000
  }
}
```

The `token` is the fencing token. Every state write by the owning controller
must present the current token.

## Acquisition

`LeaseStore.acquire(runId)`:

1. Writes a unique temp file and publishes it with `linkSync` (hard link) to the
   lease path. `link(2)` fails with `EEXIST` when the target already exists, so
   this is an atomic create-if-absent: exactly one contender publishes its lease.
2. On `EEXIST` the existing lease is evaluated:
   - same hostname + same pid + same process identity (this process) → in-process
     takeover (session-switch adoption), re-tokenning the lease — **only when the
     previous ownership generation in this process is demonstrably quiescent**;
   - different hostname → rejected as foreign;
   - owner pid provably alive → rejected, unless the stored identity provably
     differs from the current occupant (pid reuse → the recorded owner is dead);
   - owner pid unverifiable (permission error) → rejected as ambiguous;
   - owner pid provably dead (`ESRCH`) → reclaimed;
   - corrupt/unparseable lease file → rejected, never destroyed.

A bounded retry loop absorbs the benign races (lease released concurrently, or a
reclamation race lost).

## Process-local ownership registry

A matching pid or process identity is **not** proof that the previous controller
stopped driving. Every `LeaseStore` instance in a process shares a module-level
ownership registry (`processOwnership`) per run:

- `beginSpawn` registers an unresolved spawn **before** the RPC crosses the
  transport; `childSpawned`/`adoptChild` keep a live child outstanding;
  `spawnFailed`/`endChild` release it once the outcome (or the settle event) is
  independently confirmed.
- A same-process takeover (or any fresh acquisition) is refused while the
  previous generation has outstanding spawn/child activity. This cannot be
  bypassed by constructing an independent lease-store instance: the registry is
  module-level, and the controllers map is only a cache.
- Records are retained through controller disposal until the activity resolves
  or the process exits. An unresolved spawn therefore always blocks a
  replacement controller from acquiring the run and starting a second child
  (no C1/C2-style concurrent workspace modification).

## Controller lifecycle, spawn and disposal safety (Task 3)

### Persist-before-spawn

Every invocation is durably journaled before the transport RPC crosses the
boundary: a unique `attemptId`, phase and role, the effective configuration
revision, `provenance` (prepared → spawn requested → spawned → settled), the
agent id when known, workspace-modification risk, and outcome certainty. Each
meaningful transition is persisted and fenced. A crash between approval and a
confirmed spawn stays recoverable through inspection and is never blindly
replayed.

### Disposal and ownership fencing

A disposed or non-owning controller can no longer start a spawn, commit state,
schedule wakes, or advance on settle events. An unresolved spawn RPC that
resolves after disposal or lease loss is never imported as owned work: the
returned child is stopped best-effort, its workspace-risk provenance is
retained, and the ownership registry keeps it outstanding until its settlement
is independently confirmed (a stop request is not proof of termination).

### Child completion ordering

A child that settles before its spawn RPC returns is buffered (keyed by agent
id) and imported exactly once when the spawn resolves and the child is adopted
into `inFlight`. If safe import cannot be established (disposal, ownership
loss), the buffered result is dropped and the phase blocks with a diagnostic.
Two controllers receiving the same completion cannot both advance: the stale
one is fenced out (inert), only the current owner persists and spawns
successors.

### Failed Engineer provenance

Engineer and remediation attempts preserve workspace risk after transport
failure, timeout/uncertain spawn outcome, aborted/stopped child, invalid or
missing packet, process interruption, or disposal during spawn. These are never
converted into a generic auto-recoverable parked or WAITING_CAPACITY state:
`nextAction` refuses to re-spawn (`engineerSpawnBlocked`) and eligibility
requires explicit approval. Automatic capacity recovery is permitted only for a
definitive pre-spawn rejection (quota) with `recoveryRisk: "none"` and the
original deadline preserved.

### Workspace binding

Every spawn carries the canonical persisted workspace directory (`cwd`); the
transport forwards it to the child and rejects a missing or non-absolute
workspace before any child executes.

## Unresolved spawn provenance on restore

A persisted attempt with `prepared`/`spawn_requested` provenance and no
settlement means a child may have been dispatched whose outcome is unknown.
Restore never replays such a phase merely because `inFlight` is absent:
`performSpawn` parks the run instead, and eligibility (`assessRecoveryEligibility`)
reports `requiresApproval` for the unresolved phase (even when parked), so only
an explicit approval may authorize the replay.

## Filesystem guarantees and limitations

- `linkSync` with an absent target is an atomic create-if-absent primitive. It is
  **not** a general compare-and-swap: the stored token alone never atomically
  replaces a different lease, and `renameSync` (used for state files) is atomic
  for replacement but clobbers whatever is there.
- **Reclamation is remove-then-create, not a single atomic operation.** Between
  removing the stale lease and linking the new one, another process could link
  first. The loser's `linkSync` fails with `EEXIST`, the loser re-reads the
  winner's lease and re-evaluates (a live winner is never displaced), so at most
  one contender ends up holding the lease. The sequence is documented as not
  atomic rather than claimed as a CAS.
- Single host, local filesystem only. Foreign hosts, permission errors, corrupt
  files, and unverifiable identity are conservatively refused.
- A pid alone is not proof of identity. On Linux the lease records
  `boot_id + /proc/<pid>/stat` starttime; on macOS the `ps -o lstart` start time.
  Reclamation of an *alive* pid requires the stored identity to provably differ
  from the current occupant. Where identity cannot be captured, ambiguous
  reclamation is refused.

## Fencing and revision guard

`FactoryStore.save(state, fenceToken)`:

- lease-backed store + no token while a lease exists → rejected;
- token that does not match the current lease → rejected (stale owner);
- no valid lease while a token is supplied → rejected (ownership lost);
- a v2 state whose `stateRevision` is behind the persisted revision → rejected,
  so a stale snapshot can never silently overwrite newer state.

A fenced commit that is rejected makes the controller **inert** (`hasOwnership()`
false): it stops driving and can no longer persist. It never throws into the
event bus.

The unfenced (legacy) save path preserves the Task 1 revision-bump behaviour for
direct tool/test snapshots on non-lease-backed stores.

## Release

`LeaseStore.release(runId, token)` removes the lease only while the caller still
holds the current token AND no outstanding spawn/child activity remains — a
token mismatch (ownership taken over) never removes the current owner's lease,
and outstanding activity never releases.

A controller releases its lease on `dispose()` only when it has safely
relinquished ownership: not while the drive loop is mid-turn, not while an
in-flight agent exists, and not while the ownership registry still reports
outstanding spawn/child activity. A **best-effort stop request is not proof of
termination**: `stop()` clears `inFlight` before the child's settle event
confirms it ended, so the lease is retained and the unresolved state is reported
via `getReleaseBlockedReason()` until the settle event (or process exit) closes
the window. Such leases are reclaimed after this process dies or taken over by a
later in-process restore.

## Read-only inspection

Ordinary state inspection (`load`, `loadStrict`, `list`, `peekState`,
`/factory-status`, `/factory-report`, `/factory-metrics`) never acquires a lease
and never writes. Only controller creation/restore acquires ownership.

## What remains dependent on Task 3

- Late-spawn cleanup: a disposed controller with an in-flight agent keeps its
  lease; stopping the child and safely relinquishing before release is not
  implemented here.
- Approval execution, preset replacement, `/factory-resume`, and cross-process
  controller handover are later tasks.
- The extension degrades to read-only for a run owned by a live process on
  another host (restore refuses to drive) without a dedicated user-facing
  diagnostic surface.

## Resume command (V1)

`/factory-resume <runId> [--preset <name>]` reads the persisted run without
acquiring a lease or driving, shows a preview (state, completed vs incomplete
work, recovery checkpoint, approval token, next-action classification), then
continues from the next unfinished action after confirmation where required.

- Safe automatic continuation: clean phase boundaries and WAITING_CAPACITY
  (definite pre-spawn rejections) resume directly; the preserved retry deadline
  applies.
- Workspace-risking recovery: an interrupted Engineer requires explicit approval
  (Pi's native confirm), which is bound to one durable checkpoint and consumed
  before exactly one new attempt — a second or stale approval is rejected, and
  the resumed Engineer is instructed to inspect existing files and finish only
  missing work.
- `--preset <name>` persists a validated replacement snapshot
  (`presetReplacement`) affecting only future children (targets, fallbacks,
  retry settings, turn limits); the original `config` stays as history and
  subsequent metrics record the effective configuration.
- DONE, STOPPED and FAILED runs are not resumed. An accidental Escape that
  produces terminal STOPPED remains a documented V1 limitation.
