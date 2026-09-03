import { describe, expect, it } from "vitest";
import { Container } from "@theia/core/shared/inversify";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import frontendModule from "./mission-control-frontend-module";
import { MISSION_CONTROL_WIDGET_ID } from "./mission-control-widget";
import { ORRERY_INTELLIGENCE_WIDGET_ID } from "./orrery-intelligence-widget";
import { ORRERY_TOOLS_WIDGET_ID } from "./orrery-tools-widget";

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
});
