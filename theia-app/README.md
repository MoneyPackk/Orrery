# Orrery Theia Electron Host

`@orrery/theia-app` is an isolated Eclipse Theia `1.75.0` Electron application. It assembles the reusable `@orrery/mission-control-theia` package with a host-only Electron-main module; it is not part of the root npm workspace or the existing Electron 44 shell.

## Dependency Boundary

All direct Theia packages are pinned to `1.75.0`, and Electron is pinned to `42.8.1`, the exact peer required by `@theia/electron@1.75.0`. The isolated lockfile resolves the sibling `@orrery/mission-control-theia` package directly. The installer performs clean lock-based installs for both graphs and builds the extension before installing the host, so a clean checkout cannot reuse stale generated declarations.

The host package declares only its `electronMain` composition module. That module:

- binds one singleton daemon client to the extension-local `MissionControlHostService` contract;
- obtains the canonical renderer URL from `ElectronMainApplicationGlobals.THEIA_FRONTEND_HTML_PATH` and returns the exact current Theia main-frame URL;
- selects the actual tracked Theia `BrowserWindow` as the trusted review parent;
- delegates only list, snapshot, and reviewed promotion operations;
- starts no browser-side privileged bridge and disconnects the host-owned daemon during Theia shutdown.

The extension preload remains the only Orrery renderer bridge. It exposes `list`, `getSnapshot`, and `reviewAndPromote`, not filesystem, process, shell, daemon, or generic desktop APIs.

## Commands

Run these from the repository root:

```bash
npm run theia-app:install
npm run theia-app:build
npm run theia-app:test
npm run theia-app:smoke
```

`theia-app:install` builds the extension and installs both isolated graphs with `npm ci --ignore-scripts`. This keeps dependency resolution reproducible on Windows Node `26.3.0`, where Theia's native `drivelist`/ffmpeg addon chain is not buildable. `theia-app:build` still uses installed `@theia/application-package` and `@theia/application-manager` generator APIs to emit the real `src-gen/backend/electron-main.js` and `src-gen/frontend/preload.js` composition metadata.

`theia-app:smoke` first attempts Theia's full native build and Electron launch. If Node 26.3 on Windows cannot prepare the native Theia addons, it prints the exact failure class and falls back explicitly to generated application metadata, preload/main wiring, DI resolution, renderer identity, singleton, and cleanup validation. A fallback is not reported as a real Electron launch.

Generated `node_modules/`, `host/lib/`, `src-gen/`, `lib/`, and `out/` files are ignored. `package-lock.json` is tracked.
