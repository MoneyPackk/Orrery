# Electron Desktop Foundation Implementation Plan

**Goal:** Wrap the verified Mission Control renderer in a secure, packaged Electron desktop shell while preserving the standalone browser build.

**Architecture:** Electron main owns window lifecycle, navigation policy, and IPC registration. A sandbox-compatible preload exposes only a versioned readiness API. The existing React renderer remains browser-only and receives no Node or Electron imports. Production loads packaged assets; development loads only a validated loopback Vite URL.

**Packaging decision:** Electron-builder `26.15.7` is the accepted packaging system for this milestone. Forge `7.11.2` was evaluated but rejected because its dependency tree retained audited archive traversal vulnerabilities and stalled on the available host runtime. The builder configuration is the single release path.

**Tech Stack:** Electron 44, TypeScript, Vite, React 19, Electron-builder 26.15.7, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-27-orrery-design.md`

## Global Constraints

- Main, preload, and renderer are separate trust zones.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`, and `webSecurity: true` are mandatory.
- Renderer receives no direct filesystem, shell, process, credential, or arbitrary IPC access.
- Validate every IPC sender and payload in the main process.
- Production CSP uses same-origin connections only; anti-framing requires a response header at deployment time.
- Development URLs must be loopback-only and never be honored when `app.isPackaged` is true.
- Theia integration remains a separate compile-time extension boundary and is not replaced by Electron glue.
- Do not add signing, notarization, auto-update, or external network services before the desktop shell is exercised.

## File Structure

- `electron/main.ts`: secure BrowserWindow lifecycle and navigation policy.
- `electron/preload.ts`: narrow contextBridge API.
- `electron/ipc.ts`: typed IPC channel and sender validation.
- `electron/electron-env.d.ts`: renderer typing for the exposed API.
- `electron/main.test.ts`: secure window and navigation policy tests.
- `electron/preload.test.ts`: exposed API shape tests.
- `electron-builder.config.cjs`: electron-builder packaging targets and application metadata.
- `vite.main.config.ts`: main-process bundling configuration.
- `vite.preload.config.ts`: preload bundling configuration.
- `src/desktop.test.tsx`: renderer fallback behavior when desktop API is absent/present.
- `package.json`: desktop scripts and exact Electron/electron-builder dependencies.
- `README.md`: desktop development and packaging instructions.

## Tasks

### Task 1: Electron Contracts And Secure Main

- [ ] Add failing tests for secure BrowserWindow options, loopback-only dev URL validation, blocked navigation, denied popups, and trusted sender checks.
- [ ] Add exact Electron and Electron-builder dependencies.
- [ ] Implement `electron/ipc.ts` with fixed channel names, sender-origin validation, and a minimal `desktop:get-runtime` handler.
- [ ] Implement `electron/main.ts` with explicit secure `webPreferences`, hidden-until-ready window, strict navigation and popup policy, and packaged-vs-development loading.
- [ ] Verify targeted Electron tests.

### Task 2: Sandboxed Preload And Renderer Contract

- [ ] Add failing tests asserting only the typed runtime method is exposed and no raw IPC primitives are exposed.
- [ ] Implement sandbox-compatible `electron/preload.ts` using `contextBridge` and `ipcRenderer.invoke` on a fixed channel.
- [ ] Add `electron/electron-env.d.ts` and a renderer-safe helper that treats the desktop API as optional.
- [ ] Verify preload and renderer tests.

### Task 3: Electron-builder Packaging And Development Workflow

- [ ] Add Electron-builder configuration for main, preload, and renderer outputs with `base: './'`.
- [ ] Add Windows/Linux/macOS targets without signing credentials or publishing configuration.
- [ ] Add `desktop:dev`, `desktop:package`, and `desktop:make` scripts.
- [ ] Keep browser `dev`, `build`, and Playwright commands working.
- [ ] Add package metadata with original Orrery identifiers and no Microsoft/Cursor branding.

### Task 4: Desktop Smoke Coverage

- [ ] Add a desktop smoke script that launches the desktop shell and confirms the renderer loads, desktop runtime is available, and no Node globals are visible in the renderer.
- [ ] Verify production build and desktop package output.
- [ ] Run dependency audit and diff review.

### Task 5: Theia Migration Seam

- [ ] Add `theia-extensions/mission-control/README.md` describing the future `ReactWidget`, `WidgetFactory`, `AbstractViewContribution`, and `common/browser/node` boundaries.
- [ ] Add `packages/mission-control-domain/README.md` documenting the intended extraction from the current `src/domain` module.
- [ ] Document that the standalone shell remains the regression oracle until the Theia view covers equivalent flows.
