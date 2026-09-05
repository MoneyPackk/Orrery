import { injectable } from "@theia/core/shared/inversify";
import type { CommandRegistry } from "@theia/core/lib/common/command";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { MissionControlCommands } from "../common/mission-control-commands";
import { MISSION_CONTROL_WIDGET_ID, MissionControlWidget } from "./mission-control-widget";

@injectable()
export class MissionControlContribution extends AbstractViewContribution<MissionControlWidget> {
  constructor() {
    super({
      widgetId: MISSION_CONTROL_WIDGET_ID,
      widgetName: "Mission Control",
      defaultWidgetOptions: { area: "left", rank: 250 },
      toggleCommandId: MissionControlCommands.OPEN.id,
      toggleKeybinding: "ctrlcmd+shift+m",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(MissionControlCommands.REFRESH, { execute: async () => (await this.widget).refresh() });
    commands.registerCommand(MissionControlCommands.REVIEW, {
      execute: async (decision: "accepted" | "rejected" | "revision_requested") => (await this.widget).review(decision),
      isEnabled: (decision) => ["accepted", "rejected", "revision_requested"].includes(decision),
    });
  }
}
