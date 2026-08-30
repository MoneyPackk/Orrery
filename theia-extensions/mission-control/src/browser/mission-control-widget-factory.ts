import { inject, injectable } from "@theia/core/shared/inversify";
import type { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MISSION_CONTROL_WIDGET_ID, MissionControlWidget } from "./mission-control-widget";

export const MissionControlWidgetProvider = Symbol("MissionControlWidgetProvider");

@injectable()
export class MissionControlWidgetFactory implements WidgetFactory {
  readonly id = MISSION_CONTROL_WIDGET_ID;
  constructor(@inject(MissionControlWidgetProvider) private readonly createMissionControlWidget: () => MissionControlWidget) {}
  createWidget(): MissionControlWidget { return this.createMissionControlWidget(); }
}
