import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { QuickAccessRegistry } from "@theia/core/lib/browser/quick-input/quick-access";
import { QuickInputService } from "@theia/core/lib/browser/quick-input/quick-input-service";

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

/** Smoke-only opener, kept off the contribution identifiers so it cannot poison their resolution. */
export const SmokeViewOpener = Symbol("SmokeViewOpener");

export default new ContainerModule((bind) => {
  // `@theia/core` declares the quick-input services but only `@theia/monaco` ever *binds* them,
  // and this application does not depend on monaco. Two separate failures follow:
  //
  // - `AbstractViewContribution` injects `QuickViewService`, which needs `QuickAccessRegistry`.
  //   Without it, opening any view throws and every Orrery view is unreachable.
  // - `QuickCommandFrontendContribution` injects `QuickInputService`. Without it, resolving the
  //   `CommandContribution` list throws, and Theia's `ContainerBasedContributionProvider` catches
  //   that and returns an empty list — so *every* command, keybinding and menu entry in the whole
  //   application silently disappears, including Theia's own.
  //
  // Both only power the quick-open palette, which this application has no UI for, so no-ops
  // satisfy the graph without pretending to provide the feature. The symbols must come from
  // Theia's own modules: inversify matches by identity, so a locally-created symbol cannot match.
  bind(QuickAccessRegistry).toConstantValue({
    registerQuickAccessProvider: () => ({ dispose: () => undefined }),
    getQuickAccessProviders: () => [],
    getQuickAccessProvider: () => undefined,
  } as never);

  bind(QuickInputService).toConstantValue({
    open: () => undefined,
    createInputBox: () => ({ dispose: () => undefined }),
    createQuickPick: () => ({ dispose: () => undefined }),
    input: async () => undefined,
    pick: async () => undefined,
    showQuickPick: async () => undefined,
    hide: () => undefined,
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
  // function it can invoke on demand sidesteps the lifecycle entirely.
  //
  // Deliberately NOT bound as a `FrontendApplicationContribution`: inversify treats a binding
  // whose factory is asynchronous as an async dependency, and Theia resolves contribution lists
  // synchronously. A single async binding makes `container.getAll` throw, and
  // `ContainerBasedContributionProvider.getContributions` swallows that in a `catch` that only
  // logs — silently discarding *every* contribution for that identifier. Binding this opener as a
  // contribution therefore wiped out all commands, keybindings and menus in the application.
  bind(SmokeViewOpener).toDynamicValue(({ container }) => ({
    open: async (): Promise<string[]> => {
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
    },
  })).inSingletonScope();

  // Publishes the opener on the window at module load. A `FrontendApplicationContribution` hook
  // cannot be used: contribution lists are resolved before this module is loaded, so a hook bound
  // here never fires. The module body, by contrast, is guaranteed to run.
  //
  // `bind` cannot resolve during module loading, so the opener closes over the container lazily
  // through the factory below, which is only invoked once the smoke calls it.
  bind(FrontendApplicationContribution).toDynamicValue(({ container }) => {
    (window as unknown as { __orreryOpenViews?: () => Promise<string[]> }).__orreryOpenViews =
      () => container.get<{ open: () => Promise<string[]> }>(SmokeViewOpener).open();
    return {};
  }).inSingletonScope();
});
