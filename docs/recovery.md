# Factory persisted recovery model

This guide documents Factory's persisted state contract, strict validation, and pure recovery planner. Controller driving, leases, approvals, presets, and `/factory-resume` are separate layers; see [ownership.md](ownership.md) and [ai-factory.md](ai-factory.md).

## Persisted contract

New Factory snapshots use state version 3 (version 2 remains readable) and contain:

- `stateRevision`: a positive, monotonically increasing snapshot revision;
- `checkpoint`: a durable identity containing the run id, exact phase, progress counters, revision, and the current attempt/agent identity where applicable;
- `attempts`: append-only invocation provenance and recovery risk;
- the existing validated packets, metrics, configuration, and state-machine fields;
- a version-3 approved `targetPlan` with order, dependency graph, target outcomes,
  active target, and Reviewer/Engineer evidence identities after initial approval.
  Attempts and checkpoints carry target identity where relevant.

Checkpoint ids include the run id, so two runs cannot collide. They also include repair/remediation progress and revision, so revisiting the same phase in a later round produces a different checkpoint. Version-3 work-target checkpoints additionally identify the active target; an interrupted successor cannot inherit its predecessor's attempt provenance or approval token. A persisted accepted-target boundary with no successor dispatched can continue automatically; once a successor Engineer attempt is prepared or in flight, recovery remains approval-gated.

Attempt provenance is explicit:

| Provenance | Meaning | Default recovery treatment |
|---|---|---|
| `not_started` | No invocation exists for the current phase | Automatic, except ambiguous legacy Engineer states |
| `prepared` | Invocation was prepared before the transport boundary | Approval required |
| `spawn_requested` | A spawn request was persisted; outcome is uncertain | Approval required |
| `spawned` | A child was created; workspace impact may be possible | Approval required |
| `settled_validated_packet` | The child settled and its packet validated in the same snapshot as its packet | Automatic checkpoint continuation |
| `settled_without_valid_packet` | No valid packet was durably recovered | Blocked; never silently replayed |

Engineer and remediation attempts carry `workspace_may_have_changed` risk from preparation through an uncertain settlement. This risk survives reload because it is persisted in the attempt record; it is not inferred from `parked` or `WAITING_CAPACITY`.

## Validation

`src/ai-factory/recovery-model.ts` exports strict validation and parsing helpers:

- `validatePersistedFactoryRunState(value, intendedProjectDir?)` returns `{ ok, issues, legacy }`;
- `assertValidFactoryRunState` and `parseFactoryRunState` reject malformed snapshots;
- `validateRunId` / `assertValidRunId` accept only the bounded filename-safe run-id grammar;
- `canonicalWorkspacePath` compares canonical paths against the intended project directory.

`FactoryStore` validates ids before calling `path.join`, validates snapshots before saving, rejects corrupt snapshots on normal load, and exposes `loadStrict` when callers need the validation error. Version 1 snapshots remain readable as legacy snapshots, but their ambiguous Engineer recovery is never automatic.

Validation covers configuration keys and values, packet shapes and enum values, attempt provenance, metrics totals, state/park consistency, in-flight role/phase consistency, terminal invariants, checkpoint identity, and the canonical workspace path. Version-3 validation additionally rejects malformed target graphs, inconsistent outcomes, and claims of a passed target without matching Reviewer PASS evidence.

## Pure planner

`planFactoryRecovery(state)` (also re-exported from `state.ts` as `planFactoryRecovery` and `planRecovery`) performs no filesystem I/O, writes, timers, subscriptions, model calls, or agent spawns. It returns:

- `automatic` when the persisted checkpoint proves continuation is safe;
- `approval_required` when an invocation may have run or workspace safety is uncertain;
- `blocked` for corrupt/terminal state or a settled attempt without a valid packet.

`WAITING_CAPACITY` and `parked` are only state-machine conditions. They do not upgrade an uncertain Engineer attempt to automatic recovery.

The older `assessRecoveryEligibility` API remains available for the existing controller/approval surface. New recovery orchestration should use the Task-1 planner and durable checkpoint directly.

## Compatibility and limitations

- Version 1 run files are accepted conservatively for inspection and reporting. They have no durable attempt provenance, so ambiguous Engineer and remediation states require approval.
- Version 2 remains readable and keeps its original single-work-package semantics. Version 3 is the write format for newly created controller runs.
- The pure planner does not reconcile workspace changes, acquire ownership leases, drive a controller, execute approvals, or apply presets; those are handled outside this module.
- Atomic JSON persistence is not cross-process ownership protection.
