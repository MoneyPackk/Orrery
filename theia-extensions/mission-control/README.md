# Mission Control Theia Extension Seam

This directory reserves the future Theia extension package `@orrery/mission-control-theia`. Milestone 1 adds the boundary only; it does not add Theia to the running product.

## Version Contract

The extension will pin, without ranges, every Theia package it consumes:

```json
{
  "dependencies": {
    "@orrery/mission-control-domain": "workspace:*",
    "@theia/core": "1.75.0"
  },
  "devDependencies": {
    "@theia/electron": "1.75.0"
  }
}
```

No `^`, `~`, or mixed Theia versions are permitted. The target platform is Eclipse Theia `1.75.0`.

## Planned Boundaries

- `common/`: Theia-neutral extension symbols and typed commands only. Mission entities, transitions, runtime events, and invariants come from `@orrery/mission-control-domain`; they are not redefined here.
- `browser/mission-control-widget.tsx`: `MissionControlWidget extends ReactWidget`, importing `ReactWidget` from `@theia/core/lib/browser/widgets/react-widget`. It adapts Theia lifecycle and shell services to the existing React mission surfaces.
- `browser/mission-control-widget-factory.ts`: a `WidgetFactory` implementation imported from `@theia/core/lib/browser/widget-manager`. It owns the stable widget ID and creates `MissionControlWidget`; it contains no mission behavior.
- `browser/mission-control-contribution.ts`: `MissionControlContribution extends AbstractViewContribution<MissionControlWidget>`, importing `AbstractViewContribution` from `@theia/core/lib/browser/shell/view-contribution`. It registers the view command, menu, keybinding, and shell placement.
- `browser/mission-control-frontend-module.ts`: the browser Inversify container module. It binds the widget, `WidgetFactory`, `AbstractViewContribution`, command/menu/keybinding contributions, and browser-side adapters.
- `node/mission-control-backend-module.ts`: the Node Inversify container module. It binds future workspace/runtime adapters only; it must not import React, browser widgets, or renderer state.

The dependency direction is `common <- browser` and `common <- node`. Browser and Node modules never import each other. Both may depend on `@orrery/mission-control-domain`, while the domain package never depends on this extension or any `@theia/*` package.
