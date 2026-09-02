import { ContainerModule } from "@theia/core/shared/inversify";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { MissionControlService, OrreryIntelligenceService } from "../common/mission-control-types";
import { MissionControlContribution } from "./mission-control-contribution";
import { MissionControlDesktopAdapter } from "./mission-control-desktop-adapter";
import { MissionControlWidget } from "./mission-control-widget";
import { MissionControlWidgetFactory, MissionControlWidgetProvider } from "./mission-control-widget-factory";
import { OrreryIntelligenceDesktopAdapter } from "./orrery-intelligence-adapter";
import { OrreryIntelligenceWidget } from "./orrery-intelligence-widget";
import { OrreryIntelligenceContribution, OrreryIntelligenceWidgetFactory, OrreryIntelligenceWidgetProvider } from "./orrery-intelligence-contribution";

export default new ContainerModule((bind) => {
  bind(MissionControlDesktopAdapter).toSelf().inSingletonScope();
  bind(MissionControlService).toService(MissionControlDesktopAdapter);
  bind(MissionControlWidget).toSelf().inTransientScope();
  bind<() => MissionControlWidget>(MissionControlWidgetProvider).toFactory(({ container }) => () => container.get(MissionControlWidget));
  bind(MissionControlWidgetFactory).toSelf().inSingletonScope();
  bind(WidgetFactory).toService(MissionControlWidgetFactory);
  bindViewContribution(bind, MissionControlContribution);

  bind(OrreryIntelligenceDesktopAdapter).toSelf().inSingletonScope();
  bind(OrreryIntelligenceService).toService(OrreryIntelligenceDesktopAdapter);
  bind(OrreryIntelligenceWidget).toSelf().inTransientScope();
  bind<() => OrreryIntelligenceWidget>(OrreryIntelligenceWidgetProvider).toFactory(({ container }) => () => container.get(OrreryIntelligenceWidget));
  bind(OrreryIntelligenceWidgetFactory).toSelf().inSingletonScope();
  bind(WidgetFactory).toService(OrreryIntelligenceWidgetFactory);
  bindViewContribution(bind, OrreryIntelligenceContribution);
});
