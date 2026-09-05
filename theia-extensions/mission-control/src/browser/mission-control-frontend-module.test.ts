import { describe, expect, it } from "vitest";
import { Container } from "@theia/core/shared/inversify";
import { WidgetFactory, WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { QuickAccessRegistry } from "@theia/core/lib/browser/quick-input/quick-access";

// Theia's quick-input module runs browser feature detection at import time, and jsdom does not
// implement the legacy `document.queryCommandSupported`. Stubbing it lets this suite import the
// real module graph rather than a mock, so the bindings under test are the shipped ones.
if (typeof document !== "undefined" && !document.queryCommandSupported) {
  (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
}

const { default: frontendModule } = await import("./mission-control-frontend-module");
const { MISSION_CONTROL_WIDGET_ID } = await import("./mission-control-widget");
const { ORRERY_INTELLIGENCE_WIDGET_ID } = await import("./orrery-intelligence-widget");
const { ORRERY_TOOLS_WIDGET_ID } = await import("./orrery-tools-widget");
const { MissionControlContribution } = await import("./mission-control-contribution");
const { OrreryIntelligenceContribution } = await import("./orrery-intelligence-contribution");
const { OrreryToolsContribution } = await import("./orrery-tools-contribution");

const factories = () => {
  const container = new Container();
  container.load(frontendModule);
  return container.getAll<WidgetFactory>(WidgetFactory);
};

describe("mission control frontend container module", () => {
  it("registers one widget factory per view without unbound constructor dependencies", () => {
    expect(() => factories()).not.toThrow();
    expect(factories().map(factory => factory.id).sort()).toEqual([ORRERY_INTELLIGENCE_WIDGET_ID, ORRERY_TOOLS_WIDGET_ID, MISSION_CONTROL_WIDGET_ID].sort());
  });

  it.each([MISSION_CONTROL_WIDGET_ID, ORRERY_INTELLIGENCE_WIDGET_ID, ORRERY_TOOLS_WIDGET_ID])("creates a fresh %s widget after the previous widget is disposed", async (id) => {
    const factory = factories().find(candidate => candidate.id === id)!;
    const first = await factory.createWidget();
    first.dispose();
    const second = await factory.createWidget();
    expect(second).not.toBe(first);
    expect(second.isDisposed).toBe(false);
  });

  it("binds QuickAccessRegistry, without which QuickViewService cannot resolve", async () => {
    // `AbstractViewContribution` injects `QuickViewService`, which injects `QuickAccessRegistry`.
    // That symbol is declared in `@theia/core` but only bound by `@theia/monaco`, which this
    // application does not depend on. Constructing a contribution does not expose the gap,
    // because `quickView` is an `@optional()` injection — the failure only appears when the
    // service is actually resolved, which is what shipped broken until the real-renderer smoke
    // caught it: every view failed to open and the entire UI was unreachable.
    const container = new Container();
    container.load(frontendModule);
    container.bind(WidgetManager).toConstantValue({} as never);
    container.bind(ApplicationShell).toConstantValue({} as never);
    for (const contribution of [MissionControlContribution, OrreryIntelligenceContribution, OrreryToolsContribution]) {
      expect(() => container.get(contribution)).not.toThrow();
    }
    // Resolving the registry is the assertion that fails without the binding. `QuickViewService`
    // itself is bound by the application, not by this module, so it cannot be asserted here.
    expect(() => container.get(QuickAccessRegistry)).not.toThrow();
  });
});
