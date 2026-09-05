import { ContainerModule } from "@theia/core/shared/inversify";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { QuickAccessRegistry } from "@theia/core/lib/browser/quick-input/quick-access";
import { QuickInputService } from "@theia/core/lib/browser/quick-input/quick-input-service";
import { DefaultsPreferenceProvider } from "@theia/core/lib/common/preferences/defaults-preference-provider";
import { MenuModelRegistry } from "@theia/core/lib/common/menu";
import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import { PreferenceProvider } from "@theia/core/lib/common/preferences/preference-provider";
import { PreferenceScope } from "@theia/core/lib/common/preferences/preference-scope";
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
  // `@theia/core` declares these services but only heavier Theia packages ever *bind* them, and
  // this application deliberately depends on `@theia/core` alone. Three failures follow:
  //
  // - `AbstractViewContribution` injects `QuickViewService`, which needs `QuickAccessRegistry`
  //   (bound only by `@theia/monaco`). Without it, opening any view throws and every Orrery view
  //   is unreachable.
  // - `QuickCommandFrontendContribution` injects `QuickInputService` (also monaco-only). Without
  //   it, resolving the `CommandContribution` list throws, and Theia's
  //   `ContainerBasedContributionProvider` catches that and returns an empty list — so *every*
  //   command, keybinding and menu entry in the whole application silently disappears.
  // - Resolving any preference proxy needs an un-named `PreferenceProvider` (bound by
  //   `@theia/preferences` and friends). Without it, the preference service never becomes ready
  //   and every preference-gated UI element — the DOM menubar included — never populates.
  //
  // The quick-input services only power the quick-open palette, which this application has no UI
  // for, so no-ops satisfy the graph without pretending to provide the feature. Preferences are
  // Orrery product surface, owned by the daemon and exposed through its own channels; Theia's
  // preference machinery here only needs to resolve and answer schema defaults, which
  // `DefaultsPreferenceProvider` — Theia's own implementation — already does for the Default
  // scope. The symbols must come from Theia's own modules: inversify matches by identity, so a
  // locally-created symbol cannot match.
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

  // The Default and Session scopes already have providers from core. The User, Workspace and
  // Folder scopes normally get theirs from `@theia/preferences`/`@theia/workspace`, absent here.
  // Theia's own defaults provider serves each remaining scope: it answers schema defaults, which
  // is exactly what a preference-less application should see. Named bindings only — an un-named
  // binding would make every lookup of `PreferenceProvider` ambiguous against the scope-named
  // ones and fail resolution outright.
  for (const scope of [PreferenceScope.User, PreferenceScope.Workspace, PreferenceScope.Folder]) {
    bind(PreferenceProvider).to(DefaultsPreferenceProvider).inSingletonScope().whenTargetNamed(scope);
  }

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
      // Reports the View submenu's model labels. Lumino renders submenu popups only while open,
      // so the DOM cannot show them; the model is the renderer-side source of truth Theia builds
      // the submenu from. Stashed on the window so the smoke can read it without re-running the
      // opener or parsing logs.
      try {
        const menus = container.get(MenuModelRegistry);
        const viewMenu = menus.getMenu([...CommonMenus.VIEW, "2_views"]);
        const labels = (viewMenu?.children ?? []).map(child => (child as { label?: string }).label ?? "");
        (window as unknown as { __orreryViewModelLabels?: string[] }).__orreryViewModelLabels = labels;
      } catch {
        (window as unknown as { __orreryViewModelLabels?: string[] }).__orreryViewModelLabels = [];
      }
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

  // Publishes the opener on the window as soon as Theia resolves its contribution list. A hook
  // like `onStart` cannot be used on this binding: it is resolved too late for lifecycle methods
  // but the factory itself runs at resolution, which is early enough for the smoke. The factory
  // must stay synchronous — see the warning above about async poisoning.
  bind(FrontendApplicationContribution).toDynamicValue(({ container }) => {
    (window as unknown as { __orreryOpenViews?: () => Promise<string[]> }).__orreryOpenViews =
      () => container.get<{ open: () => Promise<string[]> }>(SmokeViewOpener).open();
    return {};
  }).inSingletonScope();
});
