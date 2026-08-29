# Real Isolated Mission Kernel

## Scope

The real kernel is a Node-side, dependency-injected execution path for a local build mission. It replaces fixture execution only at the kernel boundary; the existing React/Electron fixture flow remains the browser regression oracle.

## Lifecycle

1. A queued, approved build mission is given a UUID-derived mission branch and a Git worktree under an Orrery-owned private runtime root outside the repository. The Node-side service securely creates and validates this injected `workspaceRoot`; repository metadata may remain under `.orrery`.
2. `MissionRunner` writes `orrery-mission.txt` in that worktree using the mission title and an injected timestamp.
3. `GitWorkspaceService.inspectChanges` captures changed paths, line counts, binary state, unified diff, and a content-derived revision.
4. An allowlisted verification command runs with executable and argument arrays, `shell: false`, a canonical worktree-contained working directory, bounded output, cancellation, and timeout handling.
5. `MissionRunner` appends immutable diff and command evidence, persists every state transition before emitting its event, and returns `ready_for_review` only with a summary and current-plan evidence.
6. `PromotionService` requires review-ready state, the matching plan revision and exact change snapshot, and a non-empty reviewer identity. An accepted decision commits in the mission worktree and cherry-picks that reviewed commit onto a clean, unchanged, checked-out target branch.

## Disposable Repository Smoke

`npm run mission:smoke` runs `scripts/real-mission-smoke.ts` through `vite-node`. It creates a temporary Git repository, configures an isolated test identity, commits a fixture, runs the real workspace and command adapters plus filesystem-backed evidence and mission repositories, and removes the repository in `finally`. The smoke asserts that the target branch and working tree are unchanged before review, that exactly `orrery-mission.txt` is changed, that both evidence records and the review-ready mission are persisted, and that promotion adds only that reviewed path.

## Trust Boundaries

Commands are allowlisted exact tuples and never passed through shell interpolation. Git and filesystem operations are Node-side services; the renderer is not given raw paths, shell access, process access, or Git primitives. Repository roots are canonicalized and must be Git roots. Promotion refuses dirty or moved targets and does not silently promote rejected decisions.

Trusted repository binding is deferred. This milestone does not yet provide a user-approved repository picker, durable trusted-root registry, repository identity verification, or an IPC acceptance flow for selecting a repository. The smoke therefore uses a test-created repository supplied directly to the Node-side kernel.

## Daemon Control-Plane Boundary

The local daemon and OpenTUI control plane are a separate Node-side boundary
around the kernel. In the current slice, the daemon receives an injected
read-only `MissionRegistry` whose launcher implementation is empty; it is not
yet backed by the kernel's `MissionRepository`, and it does not start
`MissionRunner` or `PromotionService`. This prevents the terminal protocol
from implying that execution or promotion is available before the necessary
authorization and persistence wiring exists.

When that integration is added, the daemon may expose kernel-backed snapshots
and ordered events through validated protocol DTOs, but it must continue to
keep repository roots, worktrees, commands, evidence stores, and promotion
primitives behind the Node-side kernel. The first control-plane slice remains
read-mostly and its event subscription is live-only with no replay; a client
that detects a sequence gap must refresh a snapshot rather than reconstructing
history. SSH is outside this milestone.

## Evidence And Artifacts

Evidence is append-only, sequence-numbered, linked to the plan revision, and bounded by the evidence store. Command evidence contains pass/fail status and a summary; diff evidence binds review to the inspected snapshot. Packaged desktop artifacts are unsigned and are not release credentials, installers for publication, or proof of code signing. Network execution, provider APIs, deployment, auto-update, and remote repositories are outside this milestone.
