# Authoritative Mission Daemon

## 1. Objective

Make the local Orrery daemon the single authority for repository trust, mission lifecycle, execution, cancellation, event history, inspection, and promotion. Electron and OpenTUI become two clients of the same validated Mission Control protocol and no longer imply independent mission authorities. A user may propose a local repository once, inspect its canonical identity, explicitly approve it, and then use that durable allowlist entry for later missions without re-authorizing the same repository unless its identity changes.

Success means that a daemon restart can recover approved repositories, mission snapshots, and the complete ordered event stream; every mutating request is an intent checked against durable state and current mission revision; a run is owned by a real `MissionRunner`, promotion by a real `PromotionService`, and cancellation actively aborts the run rather than merely changing displayed status.

## 2. Existing Patterns

- `packages/mission-control-domain` owns `Mission`, `MissionEvent`, plan revisions, statuses, and transition invariants. Consumers must use `transitionMission`; clients must not assign status directly.
- `packages/mission-kernel` provides dependency-injected `MissionRunner`, `PromotionService`, `WorkspaceService`, `CommandRunner`, `EvidenceStore`, and `MissionRepository` ports. The runner persists before emitting events and accepts an `AbortSignal`; promotion validates review state, plan revision, and exact change snapshot.
- `packages/mission-control-daemon` provides an authenticated numeric-loopback NDJSON server and an injected `MissionRegistry`, but the launcher currently supplies an empty repository and live-only event source.
- `packages/mission-control-protocol` validates versioned messages, rejects unknown fields and prototype-pollution-shaped keys, and currently contains read-only request/response types.
- `packages/mission-control-client` is transport-agnostic and already handles request correlation, ordered live events, and sequence-gap invalidation.
- Electron currently registers a separate in-memory mission IPC service. The new authority must be reached through the shared client boundary; renderer IPC may carry validated DTOs but must not receive kernel primitives or raw repository paths.
- `scripts/real-mission-smoke.ts` is the model for disposable Git-backed integration verification, including unchanged-target assertions and explicit promotion.

## 3. User Stories

- As a first-time local user, I want to propose a repository and see its canonical fingerprint before trusting it, so that approval is explicit and reviewable.
- As a returning user, I want an approved repository to remain available after daemon restarts, so that routine mission creation does not require repeated path approval.
- As a user, I want to create, run, inspect, cancel, and promote missions through either Electron or OpenTUI, so that both surfaces show the same authoritative state.
- As a reviewer, I want promotion to be bound to the exact plan and inspected change snapshot, so that stale or unreviewed changes cannot be promoted.
- As a user, I want the event history to survive reconnects and daemon restarts, so that the timeline can be replayed rather than guessed from a snapshot.

## 4. Scope And Boundaries

### In Scope

- A daemon-owned durable repository registry with canonical repository identity and persistent allowlist entries.
- A first-use proposal flow that accepts a raw local path only in the explicit proposal intent, canonicalizes and validates it as a Git root, returns a fingerprint and approval nonce, and requires a separate approval intent.
- Durable mission snapshots and an append-only, sequence-numbered, replayable mission event store.
- Daemon-owned construction and lifecycle of the real kernel services, including active run cancellation.
- Validated protocol intents for propose/approve repository, create/run/cancel/inspect/promote mission, plus existing authentication, listing, inspection, subscription, and ping operations.
- Shared protocol client use by Electron and OpenTUI.
- Restart recovery, idempotency rules, stale revision rejection, and integration/smoke coverage.

### Out Of Scope

- Remote repositories, SSH, cloud execution, team policy, SSO, billing, provider relay, deployment, or autonomous production changes.
- Arbitrary shell, Git, filesystem, process, provider, or Electron IPC operations exposed to either client.
- A generic repository picker implemented in the renderer. The explicit proposal intent is the only path-bearing operation.
- Replacing the domain state machine or rewriting the existing browser fixture runtime.
- Concurrent runs for one mission or multiple daemon authorities for one runtime identity.

## 5. Authority And Trust Model

The daemon is the only component allowed to call `MissionRunner`, `PromotionService`, repository persistence, evidence persistence, workspace services, or process cancellation. Clients receive DTOs and operation results only. A daemon restart reconstructs its registries and active-run bookkeeping from durable records; a run that cannot be safely resumed is recovered as interrupted/failed according to the domain transition rules, with a durable event explaining the recovery.

### Repository Approval

1. `propose_repository` is the sole ordinary protocol intent containing a raw local path. It is an explicit local action, not a field accepted by create/run/promote.
2. The daemon canonicalizes the path, resolves the real Git root, rejects non-directories, symlink ambiguity, non-Git roots, and paths outside supported local repositories, then computes a canonical fingerprint from the canonical root identity and stable Git repository identity. The response contains a non-secret `proposalId`, canonical display metadata, fingerprint, and one-time `approvalNonce`; it does not grant trust.
3. `approve_repository` requires the proposal ID, exact fingerprint, and approval nonce. The daemon verifies that the proposal is unexpired and still resolves to the same canonical identity, then atomically persists an allowlist entry. The nonce is single-use.
4. Later mission intents contain only an opaque `repositoryId` from the durable registry. The daemon resolves it internally and rechecks the canonical identity before execution or promotion. Changed or missing identity requires a new proposal and approval.
5. Raw paths may appear in daemon-local metadata and human-readable inspection DTOs only where needed for display, never in ordinary mutation intent payloads. Worktree paths, command working directories, and executable arguments remain kernel-owned and are never protocol inputs.

## 6. Durable Data Model

```ts
interface ApprovedRepository {
  repositoryId: string;
  canonicalRoot: string;
  fingerprint: string;
  gitIdentity: string;
  approvedAt: string;
  lastVerifiedAt: string;
}

interface RepositoryProposal {
  proposalId: string;
  canonicalRoot: string;
  fingerprint: string;
  gitIdentity: string;
  approvalNonceHash: string;
  expiresAt: string;
}

interface MissionSnapshot extends Mission {
  repositoryId: string;
  lastEventSequence: number;
  currentChangeSnapshot?: ChangeSnapshot;
}

interface MissionEventRecord extends MissionEvent {
  payloadVersion: 1;
  recordedAt: string;
}
```

The repository registry persists approved entries and transient proposals in an Orrery-owned private runtime/state directory, not in repository-controlled files. The mission snapshot store persists one atomically replaced snapshot per mission. The event store appends immutable records with a per-mission contiguous sequence and supports `readAfter(missionId, sequence)` plus subscription. A filesystem mutation writes a recoverable transaction journal containing the next snapshot and events, appends and flushes the events, atomically replaces the snapshot, then removes the journal before acknowledging or broadcasting. Startup completes an intact journal idempotently; malformed records or an unexplained snapshot/event sequence mismatch stop mutation service rather than inviting the daemon to invent state.

Mission events remain the domain's normalized events. The durable record adds storage metadata without changing client-visible domain payloads. Replay returns events strictly after the supplied cursor, in sequence order, and clients refresh the snapshot on any detected gap or replay inconsistency.

## 7. Protocol Surface

All messages remain `mission-control.v1`, are exact-field validated, bounded, authenticated, and request-correlated. Every mutation includes an opaque `intentId` for deduplication and a relevant expected revision or nonce. Errors use stable codes and safe messages.

| Intent | Input | Result and authority check |
|---|---|---|
| `propose_repository` | `intentId`, raw `localPath` | Canonical fingerprint and one-time approval nonce; no trust grant. |
| `approve_repository` | `intentId`, `proposalId`, `fingerprint`, `approvalNonce` | Durable allowlist entry and opaque `repositoryId`; nonce is consumed. |
| `create_mission` | `intentId`, `repositoryId`, title, goal, mode, complete plan | Durable mission bound to an approved repository and submitted as `awaiting_approval`. |
| `run_mission` | `intentId`, `missionId`, `planRevisionId` | Explicitly approves that exact submitted plan revision, resolves the repository, invokes the real runner, claims one active run, and returns the accepted snapshot. |
| `cancel_mission` | `intentId`, `missionId`, `runId` | Aborts the active controller and lets the runner persist terminal cancellation before acknowledging completion. |
| `inspect_mission` | `requestId`, `missionId`, `planRevisionId` | Daemon-owned kernel inspection result or durable current snapshot; stale revisions are rejected. |
| `promote_mission` | `intentId`, `missionId`, `planRevisionId`, exact snapshot revision, decision, reviewer ID | Real `PromotionService` validates review readiness and exact snapshot, then records review result and performs explicit promotion. |

`list_missions`, `get_mission`, event subscription, and `ping` remain available. `subscribe_mission_events` now supports `replay: "durable"` in its response and emits stored events after `afterSequence` before live events; the server must establish the durable cursor and live subscription atomically so events cannot be lost between replay and live delivery.

The protocol never accepts `repositoryRoot`, `worktreePath`, `cwd`, executable strings, arbitrary command arrays, evidence-store paths, Git refs, or promotion primitives in mutation requests. The daemon selects verification commands from trusted mission configuration and kernel allowlists.

## 8. Runtime Flow

1. The authenticated client proposes and separately approves a repository.
2. `create_mission` loads the allowlisted repository, requires a complete plan, creates a domain mission with its opaque repository binding, applies `submit_plan`, persists the resulting `awaiting_approval` snapshot, and returns it.
3. `run_mission` verifies the exact submitted plan revision, applies `approve_plan` as the user's explicit execution approval, atomically claims the queued mission, creates an `AbortController`, resolves the approved repository, and invokes the real `MissionRunner` with daemon-injected services. Runner persistence is adapted to the snapshot/event stores; every emitted event is broadcast after durable commit.
4. `cancel_mission` verifies the active run ID, calls `AbortController.abort()`, and waits for the runner's cancellation persistence. Repeated cancellation is idempotent for the same intent/run; a wrong run ID cannot cancel another run.
5. `inspect_mission` reads the mission's current isolated workspace through the daemon's kernel service and persists the resulting review binding where required.
6. `promote_mission` loads the authoritative snapshot, verifies plan and change revisions, delegates to `PromotionService`, persists the review transition/result, and broadcasts the result event. The target branch remains untouched until this explicit operation.
7. On restart, durable state is loaded before the server accepts mutation traffic. Active runs are not silently resumed; each recoverable active run receives an interruption/recovery record and a safe terminal state before clients can act on it.

## 9. Error Handling And Concurrency

- Unknown repository, unapproved identity, expired proposal, reused nonce, stale plan revision, stale change snapshot, missing reviewer, invalid state transition, missing active run, duplicate intent, and event-store inconsistency each have distinct stable error codes.
- Intent deduplication stores the outcome associated with `intentId`; retrying the same authenticated intent returns the original outcome without running or promoting twice. Reusing an intent ID with different payload bytes is rejected.
- Per-mission mutation serialization prevents two runs, cancellation races, or promotions from observing contradictory snapshots. Cross-mission execution may proceed concurrently subject to kernel resources.
- Event append and snapshot update are one logical transaction. Filesystem adapters use temp-file-plus-rename and serialized append; a production database adapter must provide equivalent atomicity and uniqueness constraints.
- Client disconnect does not cancel a run. Cancellation requires an authenticated explicit intent, while the daemon continues publishing durable state for a later reconnect.
- Bounded payloads, safe error messages, private token/state files, constant-time token comparison, and numeric loopback binding retain the current daemon trust requirements.

## 10. Acceptance Criteria

1. Given an unapproved local Git repository, a client can propose it and receives a canonical fingerprint plus one-time nonce; no create/run request can use the proposal as trust.
2. Given a valid proposal, approval persists an allowlist entry; a reused nonce, changed fingerprint, expired proposal, or changed canonical identity is rejected and does not persist trust.
3. Given an approved repository, daemon restart preserves the repository ID and permits mission creation without a raw path.
4. Given a valid build mission with a complete submitted plan, `run_mission` approves only the supplied current revision, invokes the real `MissionRunner`, persists snapshots/events before acknowledgements, and reaches `ready_for_review` only with evidence and a completion summary.
5. Given an active run, `cancel_mission` actively aborts the underlying command/run and persists a terminal `cancelled` state and cancellation event; it does not leave a falsely running mission.
6. Given a review-ready mission, promotion succeeds only for the matching plan revision and exact current change snapshot with a non-empty reviewer; stale, dirty, moved, rejected, or duplicate promotion attempts do not mutate the target.
7. Given a daemon restart or reconnect, subscription replay delivers every durable event after `afterSequence` in contiguous order before live events; a detected gap causes snapshot refresh rather than inferred transitions.
8. Given Electron and OpenTUI clients, both use the same shared client/protocol contracts and observe equivalent snapshots, results, and events; neither receives raw kernel primitives or ordinary mutation paths.
9. Given malformed, oversized, unauthenticated, duplicate, or unknown-field messages, the daemon rejects them without dispatching a mutation.
10. Existing browser fixture, Electron security, kernel unit, daemon lifecycle, and real mission smoke tests remain passing, with new end-to-end daemon authority coverage proving restart and promotion behavior.

## 11. Testing Strategy

- Domain/adapter unit tests cover repository fingerprint normalization, allowlist/nonce transitions, snapshot/event atomicity, replay cursors, idempotency, and recovery invariants.
- Protocol tests cover every new request/response shape, exact fields, raw-path allowance only for proposal, bounded nonce/fingerprint fields, duplicate intent semantics, and rejection of path-bearing ordinary mutations.
- Daemon integration tests use a temporary state directory, fake kernel ports, a real authenticated TCP connection, concurrent requests, disconnects, restart, replay, cancellation, and safe error mapping.
- Kernel integration tests retain existing real worktree, command cancellation, evidence, and promotion tests; the daemon adapter proves that the real services are called rather than mocked at the authority boundary.
- Client tests cover shared Electron/OpenTUI request behavior, mutation result correlation, durable replay ordering, and reconnect snapshot refresh after a gap.
- The disposable smoke creates a temporary approved Git repository, proposes/approves it through protocol, runs and cancels/runs a mission, restarts the daemon, replays events, and promotes only the reviewed snapshot.

## 12. Implementation Constraints

- Keep Electron and OpenTUI renderer packages free of direct imports of `MissionRunner`, `PromotionService`, Git, filesystem, or child-process adapters.
- Keep raw canonical paths inside daemon/kernel boundaries; redact them from ordinary mutation intents, logs, and error messages where they are not needed.
- Preserve `mission-control.v1` compatibility for existing read-only clients unless a shape change is unavoidable; add explicit fields/types and validate them rather than silently accepting aliases.
- Do not add a second mission state machine, a second event ordering scheme, or a second execution implementation.
- Do not commit or treat this design as implementation evidence; the implementation plan is the next artifact.

## 13. Open Decisions Resolved For This Slice

- Repository trust is per canonical repository identity, not per textual path.
- Approval is two-step and nonce-bound, with a single-use nonce.
- Event replay is durable and cursor-based, with snapshot refresh as the recovery path for inconsistency.
- The daemon owns active execution and cancellation; clients cannot locally emulate either.
- Electron and OpenTUI share the transport-agnostic `MissionControlClient`; their transports and rendering remain surface-specific.
