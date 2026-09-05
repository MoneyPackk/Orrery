import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { QuickAccessRegistry } from "@theia/core/lib/browser/quick-input/quick-access";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { MissionControlService, OrreryIntelligenceService, OrreryToolsService } from "../common/mission-control-types";
import { MissionControlContribution } from "./mission-control-contribution";
import { MissionControlDesktopAdapter } from "./mission-control-desktop-adapter";
import { MissionControlWidget } from "./mission-control-widget";
import { MissionControlWidgetFactory, MissionControlWidgetProvider } from "./mission-control-widget-factory";
import { OrreryIntelligenceDesktopAdapter } from "./orrery-intelligence-adapter";
import { OrreryIntelligenceWidget } from "./orrery-intelligence-widget";
import { OrreryIntelligenceContribution, OrreryIntelligenceWidgetFactory, OrreryIntelligenceWidgetProvider } from "./orrery-intelligence-contribution";
import { OrreryToolsDesktopAdapter } from "./orrery-tools-adapter";
import { OrreryToolsWidget } from "./orrery-tools-widget";
import { OrreryToolsContribution, OrreryToolsWidgetFactory, OrreryToolsWidgetProvider } from "./orrery-tools-contribution";

export default new ContainerModule((bind) => {
  // `AbstractViewContribution` injects `QuickViewService`, which requires `QuickAccessRegistry`.
  // That symbol is declared in `@theia/core` but only ever *bound* by `@theia/monaco`, which this
  // application does not depend on. Without a binding, resolving any view contribution throws
  // "No matching bindings found for serviceIdentifier: Symbol(QuickAccessRegistry)" and every
  // Orrery view fails to open.
  //
  // The registry only powers the quick-open palette, which this application has no UI for, so a
  // no-op satisfies the graph without pretending to provide the feature. The symbol must come
  // from Theia's own module: inversify matches by identity, and Theia creates it with
  // `Symbol('QuickAccessRegistry')`, which no locally-created symbol can equal.
  bind(QuickAccessRegistry).toConstantValue({
    registerQuickAccessProvider: () => ({ dispose: () => undefined }),
    getQuickAccessProviders: () => [],
    getQuickAccessProvider: () => undefined,
  } as never);
  // Identifies which inversify realization produced this module. If the app bundles a second
  // copy, the ContainerModule class here is not the one `container.load` understands, and every
  // binding lands in a registry nothing reads.
  (window as unknown as { __orreryInversifyId?: string }).__orreryInversifyId =
    String((ContainerModule as unknown as { name?: string }).name) + ":" + String(FrontendApplicationContribution.toString());
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

  bind(OrreryToolsDesktopAdapter).toSelf().inSingletonScope();
  bind(OrreryToolsService).toService(OrreryToolsDesktopAdapter);
  bind(OrreryToolsWidget).toSelf().inTransientScope();
  bind<() => OrreryToolsWidget>(OrreryToolsWidgetProvider).toFactory(({ container }) => () => container.get(OrreryToolsWidget));
  bind(OrreryToolsWidgetFactory).toSelf().inSingletonScope();
  bind(WidgetFactory).toService(OrreryToolsWidgetFactory);
  bindViewContribution(bind, OrreryToolsContribution);

  // Exposes a smoke-only opener on the window.
  //
  // The application's lifecycle hooks have already fired by the time the smoke can drive the
  // renderer, so a contribution bound here is resolved but never called. Handing the smoke a
  // function it can invoke on demand sidesteps the lifecycle entirely. It is created lazily from
  // the same container the application uses, so it exercises the real widget factories.
  bind(FrontendApplicationContribution).toDynamicValue(({ container }) => {
    (window as unknown as { __orreryOpenViews?: () => Promise<string[]> }).__orreryOpenViews = async () => {
      const log: string[] = [];
      for (const contribution of [MissionControlContribution, OrreryIntelligenceContribution, OrreryToolsContribution]) {
        try {
          const widget = await container.get(contribution).openView({ activate: false, reveal: true });
          log.push(`${contribution.name}: id=${widget?.id} attached=${String(widget?.isAttached)}`);
        } catch (error) {
          log.push(`${contribution.name}: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
      return log;
    };
    return {};
  }).inSingletonScope();
});
