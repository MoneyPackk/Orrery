import * as React from "@theia/core/shared/react";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import type { McpRegisterInput, McpToolDecision } from "../common/mission-control-contracts";
import { OrreryToolsService, type OrreryToolsState } from "../common/mission-control-types";
import { OrreryToolsView } from "./orrery-tools-view";
import { ensureOrreryToolsStyle } from "./orrery-tools-style";

export const ORRERY_TOOLS_WIDGET_ID = "orrery-tools";

@injectable()
export class OrreryToolsWidget extends ReactWidget {
  protected state: OrreryToolsState = { servers: [], tools: [], activity: [], loading: true };
  private pending = false;

  @inject(OrreryToolsService)
  protected readonly service!: OrreryToolsService;

  @postConstruct()
  protected initialize(): void {
    this.id = ORRERY_TOOLS_WIDGET_ID;
    this.title.label = "Orrery Tools";
    this.title.caption = "Orrery Tools";
    this.title.closable = true;
    this.addClass("orrery-tools-widget");
    ensureOrreryToolsStyle();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.settle(() => this.service.load(), "Unable to load the tool catalog.");
  }

  async register(input: Omit<McpRegisterInput, "intentId">): Promise<boolean> {
    return this.settle(() => this.service.register(input), "Unable to add the server.", `Added ${input.label}.`);
  }

  async remove(serverId: string): Promise<void> {
    await this.settle(() => this.service.remove(serverId), "Unable to remove the server.", `Removed ${serverId}.`);
  }

  async decide(serverId: string, name: string, decision: McpToolDecision): Promise<void> {
    await this.settle(() => this.service.decide(serverId, name, decision), "Unable to change the permission.", `Permission for ${name} is now "${decision}".`);
  }

  async invoke(serverId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<void> {
    await this.settle(() => this.service.invoke(serverId, name, args), "The tool could not be run.");
  }

  /** Runs one operation at a time. Resolves true when the operation completed. */
  private async settle(operation: () => Promise<OrreryToolsState>, fallback: string, success?: string): Promise<boolean> {
    if (this.pending) {
      this.state = { ...this.state, notice: "A request is already in flight." };
      this.update();
      return false;
    }
    this.pending = true;
    this.state = { ...this.state, pending: true, error: undefined, notice: undefined };
    this.update();
    try {
      const next = await operation();
      this.state = {
        ...next,
        loading: false,
        pending: false,
        // A later operation must not wipe output the user is still reading.
        lastResult: next.lastResult ?? this.state.lastResult,
        ...(next.stale ? { notice: "The action completed, but the catalog could not be refreshed." } : success ? { notice: success } : {}),
      };
      return true;
    } catch (error) {
      this.state = { ...this.state, loading: false, pending: false, error: message(error, fallback) };
      return false;
    } finally {
      this.pending = false;
      this.update();
    }
  }

  protected render(): React.ReactNode {
    return <OrreryToolsView
      state={this.state}
      onRefresh={() => void this.refresh()}
      onRegister={input => this.register(input)}
      onRemove={serverId => void this.remove(serverId)}
      onDecide={(serverId, name, decision) => void this.decide(serverId, name, decision)}
      onInvoke={(serverId, name, args) => void this.invoke(serverId, name, args)}
    />;
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
