import { injectable } from "@theia/core/shared/inversify";
import type { McpRegisterInput, McpToolDecision } from "../common/mission-control-contracts";
import type { DesktopMissionApi, OrreryToolsService, OrreryToolsState } from "../common/mission-control-types";

const UNAVAILABLE = "Orrery Tools are unavailable in this window.";

/**
 * Renderer-side adapter for the MCP tool catalog.
 *
 * Reads only the narrow preload capability. Server commands, argument vectors, and
 * endpoint URLs never reach this process; the catalog carries a redacted origin only.
 * Registering, granting a permission, and invoking a tool each raise a native
 * confirmation in the main process, so this adapter cannot cause an effect on its own.
 */
@injectable()
export class OrreryToolsDesktopAdapter implements OrreryToolsService {
  private get api(): DesktopMissionApi | undefined { return window.orreryMissionControl; }

  async load(): Promise<OrreryToolsState> {
    const api = this.require();
    const [catalog, activity] = await Promise.all([api.listMcpCatalog(), api.listMcpActivity()]);
    return { servers: catalog.servers, tools: catalog.tools, activity: activity.entries };
  }

  async register(input: Omit<McpRegisterInput, "intentId">): Promise<OrreryToolsState> {
    const api = this.require();
    await api.registerMcpServer({ ...input, intentId: crypto.randomUUID() });
    return this.reload();
  }

  async remove(serverId: string): Promise<OrreryToolsState> {
    const api = this.require();
    await api.removeMcpServer({ intentId: crypto.randomUUID(), serverId });
    return this.reload();
  }

  async decide(serverId: string, name: string, decision: McpToolDecision): Promise<OrreryToolsState> {
    const api = this.require();
    await api.setMcpToolDecision({ intentId: crypto.randomUUID(), serverId, name, decision });
    return this.reload();
  }

  async invoke(serverId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<OrreryToolsState> {
    const api = this.require();
    const lastResult = await api.invokeMcpTool({ intentId: crypto.randomUUID(), serverId, name, args });
    // The tool has already run. A failure to refresh must not be reported as a failure to run,
    // or the user retries an effect that already happened.
    return { ...await this.reload(), lastResult };
  }

  /**
   * Reload after an effect has already landed.
   * Reports a stale view rather than rejecting, because the caller can no longer undo the effect.
   */
  private async reload(): Promise<OrreryToolsState> {
    try {
      return await this.load();
    } catch {
      return { servers: [], tools: [], activity: [], stale: true };
    }
  }

  private require(): DesktopMissionApi {
    const api = this.api;
    if (!api) throw new Error(UNAVAILABLE);
    return api;
  }
}
