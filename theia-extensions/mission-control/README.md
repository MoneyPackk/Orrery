# Mission Control Theia Extension

`@orrery/mission-control-theia` is a composable Eclipse Theia `1.75.0` extension. It contributes a Mission Control frontend view, a narrow Electron preload, and an Electron-main contribution. It is an extension package, not a standalone application or distribution.

## Package Boundary

The package is self-contained and publishable. Its public mission DTOs live in `src/common/mission-control-contracts.ts`; they intentionally duplicate only the narrow serialized list, snapshot, and promotion shapes needed at the extension boundary. The package has no runtime dependency on Orrery's root packages and no `file:` dependencies.

All consumed Theia packages are pinned exactly:

```json
{
  "dependencies": {
    "@theia/core": "1.75.0",
    "@theia/electron": "1.75.0"
  }
}
```

The extension's isolated Electron dev dependency is `42.8.1`, matching `@theia/electron@1.75.0`'s peer contract. The root Orrery desktop remains independent.

## Integration Points

Theia `1.75.0`'s installed `@theia/application-package` declares `electronMain` and discovers it through `ApplicationPackage.electronMainModules`. This package declares all three integration points:

- `frontend`: renders the workbench Mission Control view.
- `preload`: exposes only `window.orreryMissionControl.list`, `getSnapshot`, and `reviewAndPromote` over fixed channels.
- `electronMain`: registers only those three handlers during `ElectronMainApplicationContribution.onStart`.

Browser code imports no Electron, daemon, kernel, filesystem, process, command, or Git implementation. Electron-main code depends only on Electron IPC, Theia's lifecycle, and the extension-local `MissionControlHostService` contract. It does not import root Electron files or expose generic IPC.

## Assembled Host Adapter

The assembled Orrery Theia application must bind `MissionControlHostService` before Electron-main startup. Missing injection causes startup to fail explicitly rather than leaving a misleading partial tracer:

```ts
import { ContainerModule } from "@theia/core/shared/inversify";
import { MissionControlHostService } from "@orrery/mission-control-theia";

export default new ContainerModule((bind) => {
  bind(MissionControlHostService).toConstantValue({
    getTrustedRendererUrl: () => assembledTheiaWindow.webContents.mainFrame.url,
    list: () => daemonClient.list(),
    getSnapshot: ({ missionId }) => daemonClient.getSnapshot({ missionId }),
    reviewAndPromote: (input) => daemonClient.reviewAndPromote(input),
  });
});
```

`daemonClient` should be one constructed or reused `MissionControlDaemonClient` owned by the assembled Orrery host. The adapter belongs in that host, where daemon lifecycle and the actual Theia `BrowserWindow` are available. The trusted URL resolver must return the exact current main-frame URL after Theia loads it; requests from nested frames or any other URL are rejected. Only validated list/get/review values are delegated.

The existing root Electron host remains the current product path. A future assembled Theia host can reuse its daemon client through this adapter seam without coupling this extension package to root source layout.

## Verification

```bash
npm run theia:install
npm run theia:typecheck
npm run theia:test
npm run theia:build
```

The extension is excluded from the root npm workspace and uses its own lockfile. Tests verify Theia metadata discovery, strict IPC behavior, browser privilege boundaries, package structure, and installation of an `npm pack` tarball from an unrelated temporary consumer.
