import { inject, injectable } from "@theia/core/shared/inversify";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { CommonMenus } from "@theia/core/lib/browser/common-frontend-contribution";
import type { MenuModelRegistry } from "@theia/core/lib/common/menu";
import type { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { OrreryIntelligenceCommands } from "../common/mission-control-commands";
import { ORRERY_INTELLIGENCE_WIDGET_ID, OrreryIntelligenceWidget } from "./orrery-intelligence-widget";

export const OrreryIntelligenceWidgetProvider = Symbol("OrreryIntelligenceWidgetProvider");

@injectable()
export class OrreryIntelligenceWidgetFactory implements WidgetFactory {
  readonly id = ORRERY_INTELLIGENCE_WIDGET_ID;
  constructor(@inject(OrreryIntelligenceWidgetProvider) private readonly createWidgetInstance: () => OrreryIntelligenceWidget) {}
  createWidget(): OrreryIntelligenceWidget { return this.createWidgetInstance(); }
}

@injectable()
export class OrreryIntelligenceContribution extends AbstractViewContribution<OrreryIntelligenceWidget> {
  constructor() {
    super({
      widgetId: ORRERY_INTELLIGENCE_WIDGET_ID,
      widgetName: "Orrery Intelligence",
      defaultWidgetOptions: { area: "right", rank: 100 },
      toggleCommandId: OrreryIntelligenceCommands.OPEN.id,
      toggleKeybinding: "ctrlcmd+shift+i",
    });
  }

  /** See {@link MissionControlContribution.registerMenus}: `@theia/core` has no "Open View...". */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: OrreryIntelligenceCommands.OPEN.id,
      label: "Orrery Intelligence",
      order: "2",
    });
  }
}
