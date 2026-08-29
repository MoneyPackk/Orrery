# Orrery Mission Control

Milestone 1 is a standalone executable product specification for Orrery's differentiated mission workflow, with a deterministic packaged Electron smoke test and an explicit Eclipse Theia migration seam. It proves a complete local create, plan, approve, isolated fixture run, guarded permission, evidence, and review loop before these surfaces are mounted into Theia.

The reference shell includes:

- A framework-independent mission domain with validated transitions and review-readiness invariants.
- A deterministic fixture runtime with ordered durable events and a scoped network capability request.
- Versioned local persistence under `orrery.missions.v1`.
- Compact Mission Control, editable Plan Canvas, Runtime Timeline, and Review Studio surfaces.
- Accept, reject, and request-revision decisions through domain transitions.
- Dark, light, and system themes; responsive layouts; keyboard focus; and reduced-motion support.

The browser regression flow remains fixture-backed, while the Node-side mission kernel now executes a deterministic local task in a real isolated Git worktree, records diff and command evidence, and promotes only an explicitly accepted reviewed change. Mission and temporary promotion worktrees live under an Orrery-owned private runtime root outside repository-controlled `.orrery` paths; callers can inject `workspaceRoot` into `GitWorkspaceService` and `MissionRunner`. Repository metadata such as promotion retry records may remain under `.orrery`. Trusted repository binding is deferred: the current kernel accepts a repository root from its trusted Node-side caller rather than exposing repository selection through the renderer.

## Source Documents

- [Product design](docs/superpowers/specs/2026-08-27-orrery-design.md)
- [Mission Control implementation plan](docs/superpowers/plans/2026-08-27-mission-control-slice.md)
- [Theia extension seam](theia-extensions/mission-control/README.md)
- [Real isolated mission kernel design](docs/superpowers/specs/2026-08-28-real-isolated-mission-kernel-design.md)
- [Daemon and OpenTUI control-plane design](docs/superpowers/specs/2026-08-28-daemon-opentui-control-plane-design.md)
- [Authoritative mission daemon design](docs/superpowers/specs/2026-08-28-authoritative-mission-daemon-design.md)

## Requirements

- Node.js 24 LTS for the browser and Electron toolchain.
- Node.js 26.4.0+ with `--experimental-ffi` for native OpenTUI commands.
- npm 10+

## Development

```bash
npm install
npm run dev
```

Vite prints the local URL. Mission and theme state persist in the browser's local storage. Use **Reset local demo** to clear mission records.

## Desktop Development

The Electron shell uses the same Vite renderer. Its preload exposes only the versioned runtime-readiness API; the renderer retains browser behavior when that API is absent.

```bash
# Run Vite and the electron-builder-compatible Electron shell
npm run desktop:dev

# Create an unpacked Windows application under release/win-unpacked/
npm run desktop:package

# Launch and validate the packaged executable, then clean its repo-local profile
npm run desktop:smoke

# Create configured installers/archives under release/
npm run desktop:make
```

Desktop development accepts only an HTTP loopback Vite URL. Packaged applications load `dist/index.html` from the application bundle. Navigation and popups are blocked, and no signing, publishing, updating, or external services are configured. Builder targets are Windows NSIS, portable, and zip; macOS dmg and zip; and Linux AppImage and deb.

The packaged smoke mode is enabled only by `ORRERY_SMOKE_TEST=1`. The launcher supplies a fixed result path and `--user-data-dir` beneath `.tmp/desktop-smoke`; the main process accepts readiness only from the trusted renderer main frame. The smoke-only preload method reports that the desktop runtime exists and that renderer `process` and `require` are both undefined. No generic IPC surface is exposed.

## Verification

```bash
# TypeScript project references
npm run typecheck

# Unit and component tests
npm test -- --run

# Production bundle
npm run build

# Electron bundles, unpacked package, and packaged-runtime smoke
npm run desktop:build
npm run desktop:package
npm run desktop:smoke

# Install Chromium once, then run the complete browser flow
npx playwright install chromium
npm run test:e2e

# Run the real Git/worktree/evidence/promotion kernel smoke
npm run mission:smoke

# Run the authenticated, restart-safe daemon authority smoke
npm run daemon:smoke
```

## Local Daemon And Clients

The authenticated loopback daemon is the sole authority for repository trust, mission execution and cancellation, durable snapshots and ordered events, inspection, and promotion. Electron and OpenTUI use the same `MissionControlClient` mutation and replay contracts; neither client receives Git, filesystem, process, command, or mission-kernel primitives. The companion TUI launcher reuses a ready daemon or starts one private child and stops only that child when the TUI exits. The standalone launcher requires an already-running daemon and never starts or stops one.

```bash
# Start the daemon explicitly.
npm run daemon

# Reuse or start a companion daemon for the terminal view.
npm run tui

# Connect only to an existing daemon.
npm run tui:standalone
```

Endpoint metadata, the capability token, the approved-repository registry, mission snapshots, append-only events, and the startup lock are stored under the OS-local Orrery runtime directory with restrictive permissions. The daemon binds only to numeric loopback and requires a fresh capability token for every daemon instance. A raw local path is accepted only by `propose_repository`; approval uses the returned canonical fingerprint and one-time nonce, and every ordinary mission request uses opaque repository and mission IDs plus exact revisions. Event subscriptions replay durable, per-mission sequence order after a cursor and reconnect. Active cancellation is daemon-owned: it aborts the real runner process and acknowledges only after cancellation is durable. OpenTUI is dynamically loaded only by the terminal package and requires Node.js 26.4+ with `--experimental-ffi`; browser and Electron bundles do not import it. SSH transport is deferred. Native OpenTUI is not required for protocol, lifecycle, or authority smoke tests.

The desktop artifacts are currently unsigned and are intended for local validation, not publication or proof of signing. See the [daemon and OpenTUI control-plane design](docs/superpowers/specs/2026-08-28-daemon-opentui-control-plane-design.md) for the trust model, endpoint/token lifecycle, event-gap behavior, and ownership boundaries.

The browser test creates and approves a mission, starts the fixture runtime, denies network access, inspects the resulting change and evidence, accepts the mission, reloads, and verifies persistence. The real mission smoke creates and removes its own disposable repository under repo-local `.tmp/real-mission-smoke` and a separate private worktree runtime under the operating-system temporary directory. The daemon authority smoke creates a disposable Git repository and private runtime under the operating-system temporary directory, exercises authenticated proposal through exact promotion plus active cancellation and restart replay, and removes both in `finally`; generated repository/worktree state is never used as the project checkout.

Production hosting must send `Content-Security-Policy: frame-ancestors 'none'` as an HTTP response header. Browsers ignore `frame-ancestors` in a meta-delivered policy, so the standalone shell deliberately omits that ineffective directive.

## Structure

- `src/domain`: mission contracts, reducer, invariants, and deterministic runtime.
- `src/state`: intent-level React provider and local persistence adapter.
- `src/components`: Mission Control, Plan Canvas, timeline, dialog, and Review Studio.
- `src/styles.css`: native tokenized dark/light and responsive design system.
- `electron`: secure main-process policy, fixed IPC contract, and sandboxed preload.
- `scripts/desktop-smoke.mjs`: deterministic packaged Windows smoke launcher.
- `scripts/real-mission-smoke.ts`: disposable real Git/worktree kernel smoke.
- `scripts/authoritative-daemon-smoke.ts`: disposable authenticated authority, replay, cancellation, restart, and promotion smoke.
- `theia-extensions/mission-control`: Theia 1.75.0 browser/common/Node migration boundary.
- `packages/mission-control-domain`: framework-free domain extraction boundary.
- `e2e`: Chromium acceptance flow.
