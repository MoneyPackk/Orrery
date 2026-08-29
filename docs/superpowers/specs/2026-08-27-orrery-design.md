# Orrery Product Design

## Summary

Orrery is an open-core, cross-platform desktop IDE for solo power users. It combines a familiar extensible workbench with a first-class control plane for planning, isolating, running, and reviewing coding-agent work.

The primary product claim is not "chat inside an editor." Orrery makes delegated work observable and reversible. A mission owns its goal, plan, worktree, permissions, event history, changes, verification evidence, and final review decision.

The desktop product will be independently branded and built on Eclipse Theia and Electron. It will use Monaco for editing and Open VSX for compatible extensions. It will not use Microsoft or Cursor binaries, trademarks, marketplace services, icons, or proprietary assets.

## Product Goals

1. Let a developer do normal editor work without learning a new mental model.
2. Let a developer delegate independent work without sharing a mutable checkout.
3. Make every agent action attributable, inspectable, interruptible, and reversible.
4. Make plans, permissions, context provenance, changes, and evidence visible outside chat.
5. Support direct provider keys and local models without a mandatory Orrery relay.
6. Keep intermediate checkpoints separate from intentional Git history.
7. Preserve a clean path to remote execution and team policy without requiring either in the first release.

## Non-Goals For The First Release

- Reimplementing every VS Code feature or guaranteeing every extension works.
- Cloud agents, shared team workspaces, billing, SSO, or organization administration.
- Realtime collaborative editing.
- A visual website builder or deployment platform.
- Autonomous production deployment.
- A proprietary extension marketplace.
- Supporting untrusted third-party agent plugins without capability isolation.

## Target User

The first release targets a solo power user who works across several repositories, uses more than one coding model, is comfortable with Git, and wants to delegate work without losing control of the workspace.

The user values:

- Local speed and privacy.
- Keyboard-first navigation.
- Provider and model choice.
- Concurrent work with conflict isolation.
- Concise plans rather than ceremonial documents for routine changes.
- Concrete proof that a task is complete.

## Product Principles

### Tasks, Not Transcripts

Chat is one view over a durable mission. The mission remains useful after the conversation is compacted, exported, or deleted.

### Isolation Before Parallelism

Every write-capable mission receives a Git worktree by default. Orrery does not allow two autonomous writers to mutate the same checkout.

### Evidence Before Completion

A mission cannot enter `ready_for_review` from agent prose alone. It needs an explicit completion reason and evidence records such as test results, diagnostics, command exit codes, screenshots, or an acknowledged absence of runnable verification.

### Permissions Are Capabilities

Permissions are separated into file read, file write, command execution, dependency installation, network access, browser control, secret use, destructive operations, and deployment. There is no generic "full auto" permission.

### Local First, Portable Always

Mission state uses documented local formats. Plans, events, evidence, provider configuration, and review state can be exported without a hosted account.

## Experience Architecture

### Workbench

The center remains a conventional editor workbench: explorer, tabs, Monaco editor, terminal, diagnostics, source control, debugger, and extensions. Existing developer muscle memory is preserved where it does not obstruct the mission model.

### Mission Control

Mission Control is the primary differentiator. It shows missions across the current project and exposes:

- Title and goal.
- Mode: Explore, Plan, Build, or Delegate.
- Status and current action.
- Worktree and branch.
- Agent and model.
- Effective capabilities.
- Dependencies and blockers.
- Changed files and conflict risk.
- Verification evidence.
- Elapsed time and provider-reported usage when available.

Mission Control is a compact navigator, not a card dashboard. Rows, grouping, whitespace, and semantic color communicate hierarchy.

### Plan Canvas

The Plan Canvas is an editable structured document containing scope, assumptions, steps, acceptance criteria, and open questions. Small work uses a concise plan. Risky or architectural work can expand into requirements, design decisions, and a dependency graph.

The plan is always user-editable. Agent execution references a specific plan revision.

### Review Studio

Review Studio combines:

- Changed-file tree and unified or side-by-side diff.
- Semantic change summary linked to files.
- Commands and tool calls.
- Test and diagnostic results.
- Screenshots or recordings when UI behavior changed.
- Permission escalations and policy exceptions.
- Unresolved risks and warnings.
- Accept, request revision, reject, or retain worktree actions.

Accepting a mission promotes reviewed changes into the selected target through an explicit Git operation. It never silently mutates the primary branch.

### Composer

The composer provides four modes:

- `Explore`: read-only investigation.
- `Plan`: read-only investigation plus plan editing.
- `Build`: guarded edits and commands in an isolated worktree.
- `Delegate`: creates a separately tracked mission and chooses an execution environment.

Mode changes alter available capabilities visibly. They are not prompt hints.

## Visual Direction

Orrery uses a precise industrial-editorial language designed for dense daily work.

- Design variance: 6. Offset hierarchy and purposeful asymmetry without experimental navigation.
- Motion intensity: 4. Motion communicates focus, state transition, and task progress. Reduced motion is fully supported.
- Visual density: 8. Compact information with spacing and hairlines instead of nested cards.
- Typography: a self-hosted neutral grotesk for interface text and a coding font for source, commands, paths, and numerical data.
- Palette: cool graphite neutrals with one oxidized amber accent. Semantic error, warning, and success colors are reserved for real state.
- Shape system: 6px controls, 8px transient surfaces, square editor regions. Pills are limited to compact filters and status controls.
- Icons: one Phosphor family with a consistent weight.
- Theme: dark and light token sets with parity. System preference is the default and users can override it.

There are no decorative glows, fake status dots, generic glass panels, giant marketing typography, or gratuitous animation. Loading, empty, error, paused, blocked, disconnected, and conflict states are designed as primary states.

## Technical Architecture

### Platform Foundation

- Eclipse Theia desktop application.
- Electron runtime for Windows, macOS, and Linux.
- Monaco editor through Theia.
- xterm.js terminal through Theia.
- VS Code extension API compatibility through Theia and Open VSX.
- Product-specific features implemented as separate Theia extensions and backend services.

The first milestone is a standalone React reference implementation of Mission Control, Plan Canvas, and Review Studio. It validates product interactions and domain contracts before those packages are mounted into Theia. The reference shell is not a fake IDE replacement; it is an executable product specification for the differentiated surfaces.

### Package Boundaries

`domain`
: Owns mission, plan, capability, event, evidence, and review types plus state transitions. It has no Electron, Theia, React, provider, or Git dependencies.

`mission-store`
: Persists domain records and append-only events. The initial adapter uses local JSON and SQLite is the production target. Consumers depend on a repository interface.

`workspace-service`
: Opens repositories, checks workspace trust, creates worktrees, reserves branches, computes changes, and promotes accepted work.

`capability-broker`
: Evaluates requested tool capabilities against defaults, workspace trust, project policy, user policy, and mission overrides. It produces allow, deny, or prompt decisions with reasons.

`agent-runtime`
: Runs an agent behind an Orrery protocol. Provider and agent adapters translate model-specific messages into normalized events and tool requests.

`evidence-service`
: Captures command results, tests, diagnostics, images, logs, and manual evidence. It validates evidence references and retention.

`mission-ui`
: Renders Mission Control, Plan Canvas, composer, event timeline, permission prompts, and Review Studio using the domain interfaces.

`theia-integration`
: Registers commands, views, menus, workspace lifecycle hooks, editor context, diagnostics, terminal access, and extension contributions.

### Agent Boundary

The agent protocol is ACP-compatible where practical but wrapped in Orrery-owned interfaces. The UI does not depend on provider-specific response formats.

Normalized runtime events include:

- Agent message delta.
- Plan revision proposed.
- Tool requested, started, completed, or failed.
- Capability decision requested or resolved.
- File change observed.
- Evidence recorded.
- Mission paused, resumed, blocked, failed, cancelled, or completed.

Every event has a stable identifier, mission identifier, sequence, timestamp, source, and payload version.

### Mission State Machine

Valid states:

- `draft`
- `planning`
- `awaiting_approval`
- `queued`
- `running`
- `paused`
- `blocked`
- `ready_for_review`
- `revision_requested`
- `accepted`
- `rejected`
- `failed`
- `cancelled`

Transitions are implemented and tested in the domain package. UI components cannot assign status directly.

Important invariants:

- A write-capable mission must have an isolated workspace before entering `running`.
- A mission cannot enter `ready_for_review` without a completion summary and evidence assessment.
- Only `ready_for_review` can become `accepted` or `rejected`.
- A permission denial does not imply failure; the mission can become `blocked` or continue with an alternative.
- Cancellation is terminal for a run but preserves the mission, events, and worktree until the user chooses cleanup.

## Data Model

### Mission

- ID, project ID, title, goal, mode, status.
- Created and updated timestamps.
- Target branch, worktree path, mission branch.
- Agent adapter, model identifier, execution environment.
- Current plan revision.
- Capability profile and overrides.
- Dependencies and blockers.
- Completion summary and review decision.

### Plan Revision

- Revision ID and parent revision.
- Scope, assumptions, ordered actions, acceptance criteria, open questions.
- Author and timestamp.
- Approval state.

### Capability Decision

- Capability and requested scope.
- Request source and reason.
- Effective policy sources.
- Decision: allow once, allow mission, allow project, deny once, deny policy.
- Decider and timestamp.

### Evidence

- Kind: command, test, diagnostic, screenshot, recording, log, manual note.
- Status: passed, failed, warning, informational.
- Source tool and timestamp.
- Structured summary and artifact reference.
- Relevant files or acceptance criteria.

### Review

- Decision and reviewer.
- Reviewed plan revision and change snapshot.
- Comments and requested revisions.
- Promotion method and resulting commit references.

## Guarded Autonomy Policy

Default allowed inside a trusted isolated worktree:

- Read project files except configured sensitive paths.
- Search symbols and text.
- Create and modify files within mission scope.
- Run allowlisted read, build, lint, type-check, and test commands.
- Read diagnostics and Git status.

Default prompt:

- Network access to a new origin.
- Package installation or lockfile regeneration not named in the plan.
- Browser control outside a local preview.
- Access to a named secret.
- Commands outside the worktree.
- Database migrations or container operations.
- Changes to CI, release, authentication, authorization, or security policy.

Default denied without explicit policy change:

- Destructive Git commands against user branches.
- Reading generic credential stores or unrelated home-directory secrets.
- Publishing packages, pushing branches, creating releases, or deploying.
- Disabling verification hooks or security controls.
- Mutating another active mission's worktree.

## Security And Privacy

- Electron renderers use context isolation, sandboxing where compatible, strict CSP, and narrow typed IPC.
- Agents never receive raw secret values in transcript events. Secret use occurs through scoped handles where provider APIs permit it.
- Tool requests are validated in backend processes, not trusted from renderer state.
- Paths are canonicalized and checked against mission workspace boundaries.
- Shell commands are represented as executable plus argument arrays where possible. Display strings are not execution strings.
- Provider adapters declare data destinations and retention behavior.
- Source transmission is visible per provider and can be disabled globally.
- Optional telemetry defaults to off and never includes source, prompts, paths, terminal output, or repository URLs.
- Mission logs are local by default and have explicit retention controls.

## Error Handling

Errors are typed by boundary:

- User-correctable: invalid workspace, missing Git, unapproved plan, denied capability.
- Retryable: provider timeout, temporary network failure, extension registry failure.
- Conflict: branch changed, worktree dirty, file changed after snapshot.
- Policy: command or resource denied.
- Internal: invariant violation, corrupted event sequence, adapter bug.

The UI shows the failed operation, retained state, safe actions, and diagnostic identifier. It never replaces actionable errors with a generic toast.

Agent and provider failures do not discard the worktree. Event persistence precedes visible state changes so a crash can recover the latest committed state.

## Extension And Licensing Strategy

- The product uses Open VSX or an Orrery-controlled registry configuration, not the Visual Studio Marketplace.
- Bundled extensions require explicit redistribution rights and an extension bill of materials.
- Compatibility claims are qualified and tested against an explicit extension list.
- Theia EPL-covered source and modifications are published for each distributed build.
- Proprietary hosted services remain separate from EPL-covered packages.
- Product naming, iconography, bundle identifiers, update service, telemetry, and signing are original.
- Required MIT, EPL, Electron, Chromium, Node.js, FFmpeg, extension, font, and asset notices ship with releases.

## Testing Strategy

### Domain Tests

- Every mission transition and rejected transition.
- Capability policy precedence and scope.
- Plan revision immutability.
- Evidence requirements for review readiness.
- Event ordering, replay, and migration.

### Service Integration Tests

- Repository opening and trust evaluation.
- Worktree creation, collision handling, cleanup, and promotion.
- Command boundary and path escape attempts.
- Runtime cancellation, pause, resume, timeout, and crash recovery.
- Provider adapter contract fixtures.

### UI Tests

- Keyboard navigation and focus restoration.
- Empty, loading, error, blocked, conflict, and interrupted states.
- Plan editing and revision approval.
- Capability prompt decisions.
- Review acceptance and revision request.
- Dark, light, high-contrast, and reduced-motion modes.

### Desktop End-To-End Tests

- Launch and reopen a workspace.
- Create a mission and isolated worktree.
- Run a deterministic fixture agent.
- Observe events and evidence.
- Review and promote changes.
- Crash and recover an active mission.

## Milestones

### Milestone 0: Executable Product Specification

Build the standalone domain and Mission Control reference shell with fixture data and deterministic runtime simulation. Validate state transitions, information architecture, accessibility, responsive behavior, and the complete create-plan-run-review loop.

### Milestone 1: Theia Desktop Foundation

Create the branded Theia/Electron application, register Mission Control and Review Studio views, configure Open VSX, add local persistence, and integrate real workspace lifecycle events.

### Milestone 2: Isolated Local Agent

Implement Git worktrees, capability broker, one direct provider adapter, one local model adapter, streaming events, guarded command execution, cancellation, and evidence capture.

### Milestone 3: Daily-Driver Readiness

Harden extension compatibility, terminal and diagnostics integration, updater, signing, crash recovery, import/export, onboarding, performance, accessibility, and release automation.

### Milestone 4: Parallel Missions

Add dependencies, conflict prediction, multiple concurrent runtimes, resource budgets, and a unified project-level navigator.

### Milestone 5: Optional Hosted Execution

Add portable remote environments and paid cloud execution behind the same mission protocol. Local operation remains complete without an account.

## Initial Acceptance Criteria

The first executable slice is complete when:

1. A user can create a mission with title, goal, mode, and plan.
2. The domain rejects invalid mission transitions.
3. Starting a fixture build records a distinct isolated-workspace identifier.
4. Runtime activity appears as ordered durable events.
5. A guarded capability request can be allowed or denied and visibly affects execution.
6. Changed files and at least one evidence record appear in Review Studio.
7. Review can accept, reject, or request revision through valid transitions.
8. Refreshing restores mission state from local persistence.
9. Keyboard navigation, reduced motion, light mode, and dark mode work.
10. Unit tests, type checking, production build, and browser-level smoke tests pass.

## Research Basis

Primary references informing the design:

- Eclipse Theia architecture and AI framework: https://theia-ide.org/docs/architecture/ and https://theia-ide.org/docs/theia_ai/
- Code-OSS source and distribution differences: https://github.com/microsoft/vscode and https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code
- Open VSX: https://open-vsx.org/ and https://www.eclipse.org/legal/open-vsx-registry-faq/
- Agent Client Protocol: https://agentclientprotocol.com/overview/introduction
- Zed parallel agents: https://zed.dev/docs/ai/parallel-agents
- Cursor agent and cloud-agent concepts: https://cursor.com/docs/agent/overview and https://cursor.com/docs/cloud-agent
- Kiro specs, hooks, and checkpoints: https://kiro.dev/docs/specs/ and https://kiro.dev/docs/hooks/
- Cline checkpoints: https://docs.cline.bot/features/checkpoints
- Aider repository map and Git workflow: https://aider.chat/docs/repomap.html and https://aider.chat/docs/git.html
