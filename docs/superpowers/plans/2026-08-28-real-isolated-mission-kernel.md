# Real Isolated Mission Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one deterministic Mission Control task perform real Git work in an isolated worktree, capture command and diff evidence, and promote only explicitly accepted changes.

**Architecture:** Keep the existing React/Electron shell as the regression oracle while replacing the fixture runtime behind a narrow mission execution service. A framework-free domain package defines the contracts; Node-side adapters own Git, filesystem, process execution, and JSON persistence. The renderer receives structured mission snapshots and intent-level commands through validated IPC, never raw shell or filesystem access.

**Tech Stack:** TypeScript, Electron 44, React 19, Node.js 24 LTS, Git CLI, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-27-orrery-design.md`

## Global Constraints

- Every write-capable mission receives an isolated Git worktree before execution.
- The renderer receives no direct filesystem, shell, process, credential, or arbitrary IPC access.
- Shell commands are represented as executable plus argument arrays where possible; display strings are not execution strings.
- Validate every IPC sender and payload in the main process.
- A mission cannot enter `ready_for_review` without a completion summary and evidence assessment.
- Accepting a mission promotes reviewed changes through an explicit Git operation and never silently mutates the primary branch.
- The deterministic task is local-only and must not access network, credentials, arbitrary paths, or destructive Git operations.
- Existing browser development, production build, unit tests, and Playwright flows must remain working.
- Do not add provider APIs, remote execution, deployment, signing, or auto-update in this milestone.

---

### Task 1: Extract The Framework-Free Mission Domain

**Files:**
- Create: `packages/mission-control-domain/package.json`
- Create: `packages/mission-control-domain/src/index.ts`
- Modify: `src/domain/*.ts` only as needed to re-export or consume the extracted contracts
- Test: `packages/mission-control-domain/src/index.test.ts`
- Modify: `tsconfig.json`, `package.json`

**Interfaces:**
- Produces `Mission`, `PlanRevision`, `MissionEvent`, `Evidence`, `ReviewDecision`, `MissionStatus`, and pure transition/invariant functions through `@orrery/mission-control-domain`.
- The package must not import Electron, Theia, React, DOM APIs, Node filesystem/process APIs, or provider SDKs.

- [ ] **Step 1: Write failing boundary tests** asserting the package exports the existing mission transitions and that its source contains no forbidden runtime imports.
- [ ] **Step 2: Run `npm test -- --run packages/mission-control-domain/src/index.test.ts` and verify the boundary fails because the package entry does not exist.**
- [ ] **Step 3: Move or re-export the pure domain contracts and behaviors without changing semantics.** Keep browser-facing imports working through one compatibility import path only where the existing renderer requires it.
- [ ] **Step 4: Run the focused test, then `npm run typecheck`, and verify the extracted package and existing consumers pass.**
- [ ] **Step 5: Run `npm test -- --run` and `git diff --check`.**

### Task 2: Define Workspace And Execution Ports

**Files:**
- Create: `packages/mission-kernel/src/ports.ts`
- Create: `packages/mission-kernel/src/types.ts`
- Create: `packages/mission-kernel/src/ports.test.ts`
- Modify: `packages/mission-control-domain/src/index.ts`

**Interfaces:**
- `WorkspaceService.createMissionWorkspace(input: CreateWorkspaceInput): Promise<MissionWorkspace>`
- `WorkspaceService.inspectChanges(workspace: MissionWorkspace): Promise<ChangeSnapshot>`
- `WorkspaceService.promote(workspace: MissionWorkspace, targetBranch: string): Promise<PromotionResult>`
- `CommandRunner.run(input: CommandInput): Promise<CommandResult>`
- `EvidenceStore.append(evidence: EvidenceInput): Promise<Evidence>`
- `MissionRepository.save(snapshot: MissionSnapshot): Promise<void>` and `load(missionId: string): Promise<MissionSnapshot | null>`
- Ports are dependency-injection boundaries; this task contains no child-process or filesystem implementation.

- [ ] **Step 1: Write failing contract tests for worktree, command, evidence, and promotion inputs, including rejection of empty mission IDs, absolute out-of-scope command working directories, and non-array command arguments.**
- [ ] **Step 2: Run the focused test and verify it fails because the port types and validators are absent.**
- [ ] **Step 3: Add the smallest typed ports and boundary validators needed by later adapters.**
- [ ] **Step 4: Run the focused test and `npm run typecheck`.**
- [ ] **Step 5: Run the full unit suite to ensure no domain regression.**

### Task 3: Implement Git Worktree Isolation

**Files:**
- Create: `packages/mission-kernel/src/git-workspace-service.ts`
- Create: `packages/mission-kernel/src/git-workspace-service.test.ts`
- Create: `scripts/fixtures/isolated-repo/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Implements `WorkspaceService` using an injected `GitCommand` function so tests can use a real temporary repository without mocking Git semantics.
- Creates a mission branch named from a validated UUID-derived handle, never from arbitrary title text.
- Returns canonical primary root, worktree path, target branch, mission branch, and initial revision.

- [ ] **Step 1: Write failing integration tests that initialize a temporary Git repository, create a committed fixture file, create a mission worktree, and assert the worktree is separate, on a separate branch, and starts at the target HEAD.**
- [ ] **Step 2: Run the focused test and verify failure due to the missing service.**
- [ ] **Step 3: Implement Git command execution with argument arrays, canonical path checks, branch-name validation, and clear errors for non-Git roots or dirty promotion targets.**
- [ ] **Step 4: Add tests for path escape attempts, branch collisions, missing Git, and cleanup after failed creation.**
- [ ] **Step 5: Run the focused integration tests and full typecheck.**

### Task 4: Implement Allowlisted Command Execution And Evidence

**Files:**
- Create: `packages/mission-kernel/src/command-runner.ts`
- Create: `packages/mission-kernel/src/evidence-store.ts`
- Create: `packages/mission-kernel/src/command-runner.test.ts`
- Create: `packages/mission-kernel/src/evidence-store.test.ts`

**Interfaces:**
- `AllowlistedCommandRunner` accepts only configured executable/argument tuples and a worktree-contained cwd.
- `CommandResult` records executable, args, cwd handle, start/end timestamps, exit code, signal, stdout, stderr, and truncation status.
- `EvidenceStore` appends immutable command, test, and diff evidence with bounded output sizes and stable sequence IDs.

- [ ] **Step 1: Write failing tests for an allowlisted command that succeeds, a command that exits nonzero, output truncation, an unallowlisted executable, and a cwd outside the mission worktree.**
- [ ] **Step 2: Run focused tests and verify they fail before implementation.**
- [ ] **Step 3: Implement the runner with `child_process.spawn`, no shell interpolation, bounded stdout/stderr collection, cancellation support, and deterministic timeout errors.**
- [ ] **Step 4: Implement append-only evidence validation and persistence through an injected storage port.**
- [ ] **Step 5: Run focused tests, full unit tests, and audit that no raw command string reaches `spawn`.**

### Task 5: Build The Deterministic Real Mission Runner

**Files:**
- Create: `packages/mission-kernel/src/mission-runner.ts`
- Create: `packages/mission-kernel/src/mission-runner.test.ts`
- Modify: `src/domain/fixture-runtime.ts` only after the new runner is green

**Interfaces:**
- `MissionRunner.run(input: RunMissionInput): Promise<RunMissionResult>`.
- The built-in task is exactly: create or update `orrery-mission.txt` in the isolated worktree with the mission title and a timestamp supplied by an injected clock, then run the configured verification command `node --check scripts/desktop-smoke.mjs` from the repository root only when that command is present and allowlisted.
- The runner emits normalized events for workspace creation, file change, command started/completed, evidence recorded, and completion.

- [ ] **Step 1: Write failing tests against a real temporary repository asserting the task changes only the mission worktree, records a diff, captures command evidence, and returns a revision-bound completion result.**
- [ ] **Step 2: Run the focused test and verify failure before the runner exists.**
- [ ] **Step 3: Implement orchestration over the workspace, command, evidence, and repository ports.** Ensure every visible state transition is persisted before the next event is emitted.
- [ ] **Step 4: Add tests for command failure, cancellation, persistence failure, and rerunning the same mission revision.**
- [ ] **Step 5: Replace the UI’s fixture-only execution call with the runner behind an adapter while preserving the existing deterministic browser fixture fallback.**
- [ ] **Step 6: Run all unit tests and browser E2E tests.**

### Task 6: Capture Real Diffs And Explicit Promotion

**Files:**
- Modify: `packages/mission-kernel/src/git-workspace-service.ts`
- Create: `packages/mission-kernel/src/promotion-service.ts`
- Create: `packages/mission-kernel/src/promotion-service.test.ts`

**Interfaces:**
- `inspectChanges` returns changed paths, additions, deletions, binary status, and unified diff from the mission worktree.
- `promote` requires a `ready_for_review` mission, matching plan revision, matching change snapshot, clean target branch, and explicit reviewer identity; it creates a promotion commit or returns a typed conflict result.

- [ ] **Step 1: Write failing tests for an accepted clean promotion, rejected mission, stale snapshot, dirty target, and conflict.**
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement diff inspection and promotion using explicit Git argument arrays and fast-forward-safe checks.**
- [ ] **Step 4: Verify the primary branch is unchanged until promotion and that rejection retains the worktree.**
- [ ] **Step 5: Run all kernel tests.**

### Task 7: Add Main-Process Mission IPC And Desktop Acceptance Flow

**Files:**
- Create: `electron/mission-ipc.ts`
- Create: `electron/mission-ipc.test.ts`
- Modify: `electron/main.ts`, `electron/preload.ts`, `electron/preload-api.ts`, `electron/contract.ts`
- Modify: `src/state/mission-context.tsx`, `src/components/*`
- Modify: `e2e/mission-flow.spec.ts`

**Interfaces:**
- Add only intent-level channels: `mission:v1:create`, `mission:v1:run`, `mission:v1:get-snapshot`, `mission:v1:inspect-changes`, and `mission:v1:promote`.
- Every channel validates exact payload schemas and trusted main-frame sender; no command, path, or Git primitive is exposed to the renderer.

- [ ] **Step 1: Write failing IPC tests for valid intents, malformed payloads, untrusted senders, stale revision IDs, and promotion without review.**
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Register handlers over injected kernel services and expose typed preload methods only.**
- [ ] **Step 4: Add an Electron acceptance flow that creates a real mission from a selected disposable repository and renders real command/diff evidence.**
- [ ] **Step 5: Run browser E2E and packaged desktop smoke with repository-contained fixture data.**

### Task 8: Document, Audit, And Release-Gate The Kernel

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-08-28-real-isolated-mission-kernel-design.md`
- Create: `scripts/real-mission-smoke.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Document the real mission lifecycle, disposable repository setup, command allowlist, evidence format, promotion semantics, and known unsigned-artifact limitations.**
- [ ] **Step 2: Add a smoke script that creates a disposable repository, launches the kernel path, asserts isolated mutation, checks evidence, promotes the change, and verifies the target branch receives only the reviewed commit.**
- [ ] **Step 3: Run `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run desktop:build`, `npm run test:e2e`, `npm audit --audit-level=high`, `npm run desktop:package`, `npm run desktop:smoke`, `node scripts/real-mission-smoke.mjs`, and `git diff --check`.**
- [ ] **Step 4: Review the final diff for secret exposure, shell interpolation, path traversal, unsafe Git mutation, and renderer privilege expansion.**
