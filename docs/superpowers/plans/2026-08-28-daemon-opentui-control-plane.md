# Orrery Daemon And OpenTUI Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one authenticated local Orrery daemon and two OpenTUI launch modes, `orrery tui` and a standalone terminal client, sharing a read-mostly Mission Control protocol and views.

**Architecture:** The daemon owns the authoritative mission registry, protocol authentication, event snapshots, and lifecycle. The terminal client is transport-agnostic and renders only validated DTOs with OpenTUI Core and Keymap; `orrery tui` connects to the daemon or starts one local child, while the standalone launcher connects to an already-running daemon. No terminal client receives Git, filesystem, process, or provider primitives.

**Tech Stack:** TypeScript, Node.js 26.4+ with `--experimental-ffi` for native OpenTUI, `@opentui/core`, `@opentui/keymap`, newline-delimited JSON over a loopback TCP socket, Vitest

**Spec:** `docs/superpowers/specs/2026-08-28-real-isolated-mission-kernel-design.md` and the existing product specification.

## Global Constraints

- One daemon owns mission execution and durable state per local user session.
- Bind only to loopback; never listen on a public interface.
- Authenticate every client connection with a daemon-generated capability token stored with restrictive permissions.
- Treat all socket input as untrusted; validate message type, version, request ID, payload shape, and size before dispatch.
- Expose read-only mission snapshot/event operations in the first slice; do not expose raw filesystem, shell, Git, provider, or arbitrary IPC operations.
- Do not add SSH in this slice, but keep protocol messages independent of TCP so a later SSH adapter can reuse them.
- OpenTUI must be loaded only by the terminal entrypoints, never by browser or Electron renderer bundles.
- Preserve all existing browser, Electron, kernel, and Playwright behavior.

---

### Task 1: Define The Shared Mission Control Protocol

**Files:**
- Create: `packages/mission-control-protocol/package.json`
- Create: `packages/mission-control-protocol/src/types.ts`
- Create: `packages/mission-control-protocol/src/validation.ts`
- Create: `packages/mission-control-protocol/src/index.ts`
- Test: `packages/mission-control-protocol/src/validation.test.ts`
- Modify: `tsconfig.app.json`, `tsconfig.node.json`, `package.json`

**Interfaces:**
- `ProtocolVersion = "mission-control.v1"`.
- Client requests: `hello`, `list_missions`, `get_mission`, `subscribe_mission_events`, `unsubscribe_mission_events`, `ping`.
- Server responses: `hello_ack`, `mission_list`, `mission_snapshot`, `mission_event`, `subscribed`, `unsubscribed`, `pong`, `error`.
- `encodeMessage(message): string` and `decodeMessage(line): ProtocolMessage`.
- Maximum line size: 256 KiB; request IDs are nonempty bounded strings; unknown fields are rejected.

- [ ] **Step 1: Write failing tests for valid messages, unknown fields, wrong versions, oversized payloads, malformed JSON, and prototype-pollution-shaped keys.**
- [ ] **Step 2: Run the focused protocol tests and verify they fail before implementation.**
- [ ] **Step 3: Implement discriminated protocol types and runtime validation without adding a schema dependency.**
- [ ] **Step 4: Run focused tests, typecheck, and verify browser/Electron packages do not import OpenTUI.**

### Task 2: Implement The Authenticated Local Daemon

**Files:**
- Create: `packages/mission-control-daemon/package.json`
- Create: `packages/mission-control-daemon/src/auth.ts`
- Create: `packages/mission-control-daemon/src/server.ts`
- Create: `packages/mission-control-daemon/src/mission-registry.ts`
- Create: `packages/mission-control-daemon/src/index.ts`
- Test: `packages/mission-control-daemon/src/server.test.ts`
- Test: `packages/mission-control-daemon/src/auth.test.ts`

**Interfaces:**
- `DaemonServer.start(): Promise<DaemonEndpoint>` and `stop(): Promise<void>`.
- `DaemonEndpoint` contains loopback host, ephemeral port, protocol version, and token path, never the raw token in a response DTO.
- `MissionRegistry.list()` and `get(id)` return immutable protocol snapshots from an injected repository.
- `createDaemonToken()` and `verifyDaemonToken(candidate, expected)` use constant-time comparison.

- [ ] **Step 1: Write failing integration tests that connect to the TCP server, reject unauthenticated clients, reject non-loopback configuration, accept a valid hello, and return a mission list from an injected registry.**
- [ ] **Step 2: Run focused tests and verify failure before the daemon exists.**
- [ ] **Step 3: Implement a loopback-only NDJSON server with bounded buffering, one-request/one-response correlation, idle timeout, and clean connection teardown.**
- [ ] **Step 4: Add subscription fan-out for validated mission IDs and sequence-ordered events from an injected event source.**
- [ ] **Step 5: Add token-file creation with restrictive permissions and reject tokens with wrong length/encoding.**
- [ ] **Step 6: Run focused/full tests and typecheck.**

### Task 3: Build The Transport-Agnostic Terminal Client

**Files:**
- Create: `packages/mission-control-client/package.json`
- Create: `packages/mission-control-client/src/transport.ts`
- Create: `packages/mission-control-client/src/client.ts`
- Create: `packages/mission-control-client/src/index.ts`
- Test: `packages/mission-control-client/src/client.test.ts`

**Interfaces:**
- `MissionControlClient.connect(endpoint, token): Promise<void>`.
- `listMissions(): Promise<ReadonlyArray<MissionListItem>>`.
- `getMission(id): Promise<MissionSnapshot>`.
- `subscribe(id, listener): Promise<Unsubscribe>`.
- `disconnect(): Promise<void>`.
- The client reconnects only when explicitly requested, preserves request IDs, rejects unexpected response types, and never executes received strings as commands.

- [ ] **Step 1: Write failing fake-transport tests for hello authentication, request correlation, malformed server messages, event ordering, duplicate events, and disconnect behavior.**
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement the typed client over an injected `LineTransport`; keep TCP implementation separate from client logic.**
- [ ] **Step 4: Run focused/full tests and typecheck.**

### Task 4: Add The OpenTUI Mission Control View

**Files:**
- Create: `packages/mission-control-tui/package.json`
- Create: `packages/mission-control-tui/src/view-model.ts`
- Create: `packages/mission-control-tui/src/view-model.test.ts`
- Create: `packages/mission-control-tui/src/render.ts`
- Create: `packages/mission-control-tui/src/keymap.ts`
- Create: `packages/mission-control-tui/src/index.ts`
- Modify: `package.json`

**Interfaces:**
- `MissionControlViewModel` consumes only client DTOs and produces terminal rows/panels: mission list, selected mission, event tail, evidence summary, and connection status.
- `runTui(client, options): Promise<void>` owns `createCliRenderer`, renderables, keymap, resize handling, and guaranteed renderer destruction.
- Initial commands: up/down selection, refresh, inspect, subscribe/unsubscribe, quit. No mutation commands in this first view.

- [ ] **Step 1: Write failing view-model tests for empty/loading/error/connected states, selection boundaries, event sequence gaps, and long text truncation.**
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement compact terminal layout with no browser card styling or panel gaps, using OpenTUI Core text/box/input primitives only from public entrypoints.**
- [ ] **Step 4: Implement layered key handling through `@opentui/keymap` where available, with a minimal local fallback for testability.**
- [ ] **Step 5: Add terminal resize and shutdown cleanup tests using injected renderer lifecycle seams.**
- [ ] **Step 6: Run focused tests and verify OpenTUI is absent from browser/Electron build graphs.**

### Task 5: Add Local And Standalone Launchers

**Files:**
- Create: `scripts/orrery-daemon.ts`
- Create: `scripts/orrery-tui.ts`
- Create: `scripts/orrery-tui-standalone.ts`
- Create: `scripts/daemon-lifecycle.ts`
- Test: `scripts/daemon-lifecycle.test.ts`
- Modify: `package.json`, `.gitignore`, `README.md`

**Interfaces:**
- `orrery daemon` starts the daemon and writes endpoint metadata under an Orrery-owned runtime directory.
- `orrery tui` reads endpoint metadata, starts one daemon child when absent, waits for readiness, and shuts down only a daemon it owns.
- `orrery tui --standalone` requires an existing endpoint and never starts or stops the daemon.
- Both launchers call the same `MissionControlClient` and `runTui`.

- [ ] **Step 1: Write failing lifecycle tests for owned-daemon startup, existing-daemon reuse, standalone refusal when absent, stale endpoint cleanup, and shutdown ownership.**
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement runtime metadata and token paths under a private OS runtime directory with atomic writes and bounded stale cleanup.**
- [ ] **Step 4: Implement launcher process lifecycle with signal handling and no duplicate daemons.**
- [ ] **Step 5: Add npm scripts using `vite-node` and keep OpenTUI imports outside Vite browser configs.**
- [ ] **Step 6: Run launcher tests and a noninteractive protocol smoke using a fake terminal renderer.**

### Task 6: Add Daemon/TUI Documentation And Release Gates

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-daemon-opentui-control-plane-design.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-28-real-isolated-mission-kernel-design.md`

- [ ] **Step 1: Document the local daemon trust model, endpoint/token lifecycle, protocol versioning, standalone versus companion launch modes, and SSH deferral.**
- [ ] **Step 2: Document that the first TUI is read-mostly and that guarded mutation commands are a subsequent slice.**
- [ ] **Step 3: Run `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run desktop:build`, `npm run test:e2e`, `npm run mission:smoke`, `npm audit --audit-level=high`, and `git diff --check`.**
- [ ] **Step 4: Run a final review focused on loopback binding, token permissions, parser limits, event ordering, renderer cleanup, and browser bundle isolation.**
