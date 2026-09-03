import { inject, injectable } from "@theia/core/shared/inversify";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import type { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { OrreryToolsCommands } from "../common/mission-control-commands";
import { ORRERY_TOOLS_WIDGET_ID, OrreryToolsWidget } from "./orrery-tools-widget";

export const OrreryToolsWidgetProvider = Symbol("OrreryToolsWidgetProvider");

@injectable()
export class OrreryToolsWidgetFactory implements WidgetFactory {
  readonly id = ORRERY_TOOLS_WIDGET_ID;
  constructor(@inject(OrreryToolsWidgetProvider) private readonly createWidgetInstance: () => OrreryToolsWidget) {}
  createWidget(): OrreryToolsWidget { return this.createWidgetInstance(); }
}

@injectable()
export class OrreryToolsContribution extends AbstractViewContribution<OrreryToolsWidget> {
  constructor() {
    super({
      widgetId: ORRERY_TOOLS_WIDGET_ID,
      widgetName: "Orrery Tools",
      defaultWidgetOptions: { area: "right", rank: 200 },
      toggleCommandId: OrreryToolsCommands.OPEN.id,
      toggleKeybinding: "ctrlcmd+shift+t",
    });
  }
}
