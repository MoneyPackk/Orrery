# Authoritative Mission Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's empty read-only registry with one durable, restart-safe authority for approved repositories, real mission execution, cancellation, replayable events, inspection, and promotion.

**Architecture:** Add daemon-owned repository trust and persistence adapters behind explicit interfaces, then extend the existing validated protocol and shared client with guarded intents. The daemon serializes mission mutations, owns real `MissionRunner`/`PromotionService` instances and active `AbortController`s, and publishes snapshot/event results to both Electron and OpenTUI clients. Raw local paths are accepted only by repository proposal; all other mutation intents use opaque IDs, revisions, fingerprints, or approval nonces.

**Tech Stack:** TypeScript, Node.js 24 for browser/Electron tooling, Node.js 26.4+ with `--experimental-ffi` for OpenTUI entrypoints, newline-delimited JSON over authenticated loopback TCP, Vitest, existing `mission-control-domain` and `mission-kernel` packages, filesystem-backed local persistence for this slice.

**Spec:** `docs/superpowers/specs/2026-08-28-authoritative-mission-daemon-design.md`

## Global Constraints

- The daemon is the only owner of mission execution, cancellation, persistence, inspection, and promotion.
- First-use repository trust is explicit: proposal returns a canonical fingerprint and one-time approval nonce; approval is a separate intent and durable allowlist write.
- Raw paths are allowed only in `propose_repository`; ordinary mutation intents use opaque repository/mission IDs and revision or nonce bindings.
- Persist the mission snapshot and append-only event records before acknowledging or broadcasting a mutation result.
- Use the existing domain transitions and real `MissionRunner` and `PromotionService`; do not add a parallel state machine or fake execution path.
- Bind only to numeric loopback and preserve token, parser, request-ID, output, and idle-timeout protections.
- Durable replay is ordered by per-mission sequence and supports `readAfter`; clients refresh snapshots instead of inferring missing history.
- Electron and OpenTUI consume the same `MissionControlClient` contracts; neither receives Git, filesystem, process, command, or kernel primitives.
- Preserve browser fixture behavior, Electron security behavior, existing kernel tests, daemon lifecycle behavior, and OpenTUI bundle isolation.

---

### Task 1: Define Authority Ports And Durable Records

**Files:**
- Create: `packages/mission-control-daemon/src/authority-types.ts`
- Create: `packages/mission-control-daemon/src/authority-ports.ts`
- Create: `packages/mission-control-daemon/src/authority-ports.test.ts`
- Modify: `packages/mission-control-daemon/src/index.ts`

**Interfaces:**
- `RepositoryRegistry.propose(localPath): Promise<RepositoryProposalResult>`
- `RepositoryRegistry.approve(input): Promise<ApprovedRepository>`
- `RepositoryRegistry.resolve(repositoryId): Promise<ApprovedRepository>`
- `MissionStore.create(snapshot): Promise<void>`, `load(id)`, `list()`, `save(snapshot, events)`
- `MissionEventStore.append(events): Promise<void>`, `readAfter(missionId, sequence): Promise<readonly MissionEventRecord[]>`, `subscribe(...)`
- `MissionAuthority` record types contain `repositoryId`, `fingerprint`, `lastEventSequence`, and payload version `1`.

- [ ] **Step 1: Write failing tests for proposal/approval records, opaque mission repository binding, event sequence records, and rejection of ordinary mutation inputs containing raw paths.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-daemon/src/authority-ports.test.ts` and verify the new contracts are absent or failing.**
- [ ] **Step 3: Define the TypeScript interfaces and immutable record types, reusing `Mission` and `MissionEvent` from `@orrery/mission-control-domain` and `ChangeSnapshot` from the kernel.**
- [ ] **Step 4: Run the focused test and `npm run typecheck`; verify no Electron or TUI import is introduced.**

### Task 2: Implement Canonical Repository Proposal And Allowlist

**Files:**
- Create: `packages/mission-control-daemon/src/repository-registry.ts`
- Create: `packages/mission-control-daemon/src/repository-registry.test.ts`
- Modify: `packages/mission-control-daemon/src/index.ts`

**Interfaces:**
- `FileRepositoryRegistry({ persistence, gitInspector, now, proposalTtlMs })` implements `RepositoryRegistry`.
- `gitInspector.inspect(localPath)` returns `{ canonicalRoot, gitIdentity }`; fingerprint is a deterministic SHA-256 of the canonical identity tuple.
- `RepositoryRegistryPersistence.load()`, `save(entries)`, and `saveProposal(proposal)` are injected.

- [ ] **Step 1: Write failing tests for canonicalization, Git-root rejection, stable fingerprints for equivalent paths, proposal TTL, single-use nonce, changed identity rejection, and restart-loaded allowlist entries.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-daemon/src/repository-registry.test.ts` and verify failure.**
- [ ] **Step 3: Implement path-bearing proposal handling with `realpath`, Git-root inspection, random nonce generation, hashed nonce persistence, and deterministic fingerprint generation.**
- [ ] **Step 4: Implement approval using constant-time nonce-hash comparison, exact fingerprint matching, identity revalidation, atomic persistence, and opaque `repositoryId` generation.**
- [ ] **Step 5: Run focused tests, `npm run typecheck`, and `git diff --check`; confirm no proposal nonce or raw path is returned from ordinary resolve calls.**

### Task 3: Add Filesystem Mission Snapshot And Event Persistence

**Files:**
- Create: `packages/mission-control-daemon/src/file-mission-store.ts`
- Create: `packages/mission-control-daemon/src/file-event-store.ts`
- Create: `packages/mission-control-daemon/src/durable-store.test.ts`
- Modify: `packages/mission-control-daemon/src/index.ts`

**Interfaces:**
- `FileMissionStore(stateDirectory)` implements `MissionStore`; each mission snapshot is atomically written beneath the daemon-owned state directory.
- `FileMissionEventStore(stateDirectory)` implements append-only JSONL records with serialized writes and `readAfter` replay.
- `MissionStore.save(snapshot, events)` validates contiguous sequences and uses a recoverable transaction journal to commit event records plus snapshot as one serialized logical operation.

- [ ] **Step 1: Write failing tests for create/load/list, immutable snapshots, append-only records, contiguous sequence enforcement, replay after a cursor, concurrent append serialization, interrupted transaction recovery, and unexplained snapshot/event sequence mismatch.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-daemon/src/durable-store.test.ts` and verify failure.**
- [ ] **Step 3: Implement bounded JSON parsing, private directory creation, a transaction journal containing the next snapshot/events, append-and-flush event writes, temp-file-plus-rename snapshot writes, and a per-store promise queue.**
- [ ] **Step 4: Implement idempotent journal completion on restart and consistency validation using `lastEventSequence`; reject malformed journals or unexplained corruption rather than reconstructing guessed state.**
- [ ] **Step 5: Run focused tests and `npm run typecheck`; inspect generated test state is outside the repository and is removed in `finally`.**

### Task 4: Extend The Versioned Protocol With Guarded Intents

**Files:**
- Modify: `packages/mission-control-protocol/src/types.ts`
- Modify: `packages/mission-control-protocol/src/validation.ts`
- Modify: `packages/mission-control-protocol/src/validation.test.ts`

**Interfaces:**
- Add client requests `propose_repository`, `approve_repository`, `create_mission`, `run_mission`, `cancel_mission`, `inspect_mission`, and `promote_mission`.
- Add corresponding responses `repository_proposal`, `repository_approved`, `mission_created`, `mission_run_accepted`, `mission_cancelled`, `mission_inspection`, and `mission_promotion`.
- `subscribe_mission_events` acknowledges `replay: "durable"`; `afterSequence` remains the cursor.

- [ ] **Step 1: Write failing validation tests for every valid shape, missing/extra fields, invalid revisions, replay values, nonce/fingerprint bounds, and raw paths in all non-proposal mutation intents.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-protocol/src/validation.test.ts` and verify failure.**
- [ ] **Step 3: Add discriminated TypeScript request/response types with exact fields and no path fields outside `propose_repository`.**
- [ ] **Step 4: Extend runtime validation, preserving prototype-key rejection, maximum line size, version checks, request-ID bounds, and safe string limits.**
- [ ] **Step 5: Run protocol tests and `npm run typecheck`; verify existing read-only messages remain decodable.**

### Task 5: Implement Daemon Mission Authority And Active Cancellation

**Files:**
- Create: `packages/mission-control-daemon/src/mission-authority.ts`
- Create: `packages/mission-control-daemon/src/mission-authority.test.ts`
- Modify: `packages/mission-control-daemon/src/mission-registry.ts`
- Modify: `packages/mission-control-daemon/src/index.ts`

**Interfaces:**
- `MissionAuthority` exposes `create`, `run`, `cancel`, `inspect`, and `promote` methods matching protocol DTO inputs but accepting only daemon-resolved repository records.
- Constructor dependencies include `MissionStore`, `MissionEventStore`, `RepositoryRegistry`, `MissionRunner`, `PromotionService`, `workspaceService`, and a trusted verification-command resolver.
- `activeRuns: Map<missionId, { runId: string; controller: AbortController; promise: Promise<RunMissionResult> }>` is private to the authority.

- [ ] **Step 1: Write failing tests for create submitting a complete plan as `awaiting_approval`, run approving only the exact current plan revision, one-run-per-mission claiming, stale plan rejection, real runner invocation, persistence-before-event publication, duplicate intent replay, and cancellation calling `AbortController.abort()`.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-daemon/src/mission-authority.test.ts` and verify failure.**
- [ ] **Step 3: Implement per-mission serialized mutation execution, exact-revision `approve_plan` during `run`, and intent outcome storage so retries cannot execute or promote twice.**
- [ ] **Step 4: Wire `MissionRunner.run` with daemon-resolved repository data and an `AbortSignal`; adapt runner saves/events into the durable stores and event publisher.**
- [ ] **Step 5: Implement cancellation by validating the active run ID, aborting the controller, awaiting runner completion, and returning only after durable cancellation state exists.**
- [ ] **Step 6: Implement inspection and promotion delegation with exact plan/change snapshot checks and review-result persistence.**
- [ ] **Step 7: Run focused tests, existing `packages/mission-kernel` tests, and `npm run typecheck`.**

### Task 6: Wire Authenticated Server Dispatch And Durable Replay

**Files:**
- Modify: `packages/mission-control-daemon/src/server.ts`
- Modify: `packages/mission-control-daemon/src/server.test.ts`
- Modify: `packages/mission-control-daemon/src/mission-registry.ts`

**Interfaces:**
- `DaemonServerOptions` receives `authority`, durable `eventSource`, and a startup recovery callback.
- Dispatch maps each validated request to one authority method and maps domain/kernel errors to stable protocol error codes without leaking paths or stack traces.
- Subscription registration reads durable events after `afterSequence`, then switches to live delivery without a replay/live race.

- [ ] **Step 1: Write failing TCP integration tests for proposal then approval, create/run/cancel/inspect/promote dispatch, authentication gating, duplicate intent IDs, and stable error codes.**
- [ ] **Step 2: Write a failing replay test that reconnects after events and expects durable events after a cursor before newly published live events.**
- [ ] **Step 3: Run `npx vitest run packages/mission-control-daemon/src/server.test.ts` and verify failure.**
- [ ] **Step 4: Extend the existing bounded NDJSON dispatcher without weakening loopback, token, request ordering, output, or idle protections.**
- [ ] **Step 5: Implement subscription replay/live handoff with a serialized event-source cursor and close the socket on overflow or inconsistent sequences.**
- [ ] **Step 6: Run daemon tests and `npm run typecheck`; verify an ordinary mutation payload containing `repositoryRoot`, `cwd`, or `worktreePath` never reaches authority dispatch.**

### Task 7: Persist Runtime State And Recover On Daemon Restart

**Files:**
- Create: `scripts/daemon-authority-bootstrap.ts`
- Modify: `scripts/orrery-daemon.ts`
- Modify: `scripts/daemon-lifecycle.ts`
- Create: `scripts/daemon-authority-bootstrap.test.ts`

**Interfaces:**
- `createDaemonAuthority(runtimeDirectory): Promise<{ authority: MissionAuthority; registry: MissionRegistry; eventSource: MissionEventSource }>` loads durable stores before server start.
- `recoverActiveMissions()` writes an interruption/recovery event and safe terminal snapshot for active runs that cannot be resumed.

- [ ] **Step 1: Write failing bootstrap tests for empty startup, persisted repository/missions loading, corrupt snapshot refusal, active-run recovery, and state-directory permission setup.**
- [ ] **Step 2: Run `npx vitest run scripts/daemon-authority-bootstrap.test.ts` and verify failure.**
- [ ] **Step 3: Implement bootstrap wiring using the existing runtime directory and private state paths; inject real Git workspace, command, evidence, runner, and promotion services.**
- [ ] **Step 4: Replace the empty launcher registry with the bootstrap authority while preserving startup lock, endpoint publication, managed-child handoff, and cleanup ownership.**
- [ ] **Step 5: Run lifecycle tests plus `npm run daemon` readiness checks with a temporary runtime directory; verify endpoint metadata still omits the token.**

### Task 8: Make The Shared Client Support Electron And OpenTUI Mutations

**Files:**
- Modify: `packages/mission-control-client/src/client.ts`
- Modify: `packages/mission-control-client/src/client.test.ts`
- Modify: `packages/mission-control-client/src/transport.ts`
- Modify: `packages/mission-control-client/src/index.ts`
- Modify: `scripts/orrery-tui.ts`
- Modify: `scripts/orrery-tui-standalone.ts`
- Create: `electron/mission-control-daemon-client.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/mission-ipc.ts`

**Interfaces:**
- Client methods mirror guarded operations: `proposeRepository`, `approveRepository`, `createMission`, `runMission`, `cancelMission`, `inspectMission`, and `promoteMission`.
- Electron main process owns the daemon TCP client/transport; preload exposes only validated operation DTOs and results through fixed channels.
- OpenTUI calls the same client methods and renders the same protocol snapshots/events; it never imports Electron or kernel modules.

- [ ] **Step 1: Write failing client tests for each method, response correlation, error-code preservation, durable replay acknowledgement, and no path-bearing payload except proposal.**
- [ ] **Step 2: Run `npx vitest run packages/mission-control-client/src/client.test.ts` and verify failure.**
- [ ] **Step 3: Implement typed client request builders and response guards using the existing transport-agnostic class.**
- [ ] **Step 4: Add the Electron main-process daemon connection and fixed preload API; remove the in-memory mission authority from ordinary production wiring.**
- [ ] **Step 5: Update OpenTUI launchers to use the same mutation-capable client while retaining renderer cleanup and standalone no-start/no-stop behavior.**
- [ ] **Step 6: Run client, Electron IPC, TUI view-model, and daemon lifecycle tests plus `npm run typecheck`; verify browser build graphs do not include OpenTUI or kernel services.**

### Task 9: Add End-To-End Authority Smoke And Documentation Verification

**Files:**
- Create: `scripts/authoritative-daemon-smoke.ts`
- Create: `scripts/authoritative-daemon-smoke.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- `npm run daemon:smoke` creates a disposable Git repository and private daemon runtime, drives proposal/approval/create/run/replay/cancel/inspect/promote through the authenticated client, restarts the authority, and removes all temporary state in `finally`.

- [ ] **Step 1: Write the failing smoke assertions for canonical approval, target immutability before promotion, durable event count/order after restart, active cancellation, and exact reviewed promotion.**
- [ ] **Step 2: Run `npx vitest run scripts/authoritative-daemon-smoke.test.ts` and verify failure.**
- [ ] **Step 3: Implement the disposable smoke using the existing real Git setup patterns from `scripts/real-mission-smoke.ts` and a temporary runtime directory.**
- [ ] **Step 4: Add `daemon:smoke` and document the authority boundary, proposal-only path rule, replay, cancellation ownership, and Electron/OpenTUI shared client.**
- [ ] **Step 5: Run the focused smoke and all repository gates: `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run desktop:build`, `npm run test:e2e`, `npm run mission:smoke`, `npm run daemon:smoke`, `npm audit --audit-level=high`, and `git diff --check`.**
- [ ] **Step 6: Review the complete diff for placeholders, contradictory lifecycle claims, raw-path leakage, non-durable acknowledgements, duplicate authority construction, and cancellation that changes state without aborting work.**

## Vertical Slice Order

Tasks 1 through 3 establish interfaces and persistence without changing launch behavior. Tasks 4 through 6 make one authenticated protocol path work end-to-end against injected authority dependencies. Task 7 replaces the empty launcher wiring with real services and restart recovery. Task 8 connects both clients, and Task 9 proves the complete disposable flow. Each task has a failing test before implementation and an independently runnable verification command; no task depends on a future UI redesign or remote service.

## Plan Self-Review

- Repository approval is covered by Tasks 1, 2, 4, 6, 7, and 9.
- Durable snapshots, append-only events, replay, and restart consistency are covered by Tasks 1, 3, 6, 7, and 9.
- Real runner, promotion, and active cancellation ownership is covered by Tasks 5, 7, and 9.
- Every guarded protocol operation and its no-raw-path rule is covered by Tasks 4, 6, and 8.
- Shared Electron/OpenTUI client use and bundle boundaries are covered by Task 8.
- No step uses placeholder wording, an unspecified interface, or a second execution/state-machine implementation.
