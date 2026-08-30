import { describe, expect, it } from "vitest";
import { Container } from "@theia/core/shared/inversify";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import frontendModule from "./mission-control-frontend-module";

describe("mission control frontend container module", () => {
  it("resolves its widget factory without an unbound Object constructor dependency", () => {
    const container = new Container();
    container.load(frontendModule);
    expect(() => container.get<WidgetFactory>(WidgetFactory)).not.toThrow();
  });

  it("creates a fresh widget after the previous widget is disposed", async () => {
    const container = new Container();
    container.load(frontendModule);
    const factory = container.get<WidgetFactory>(WidgetFactory);
    const first = await factory.createWidget();
    first.dispose();
    const second = await factory.createWidget();
    expect(second).not.toBe(first);
    expect(second.isDisposed).toBe(false);
  });
});
