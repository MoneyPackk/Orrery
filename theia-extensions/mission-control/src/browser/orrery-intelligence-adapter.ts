import { injectable } from "@theia/core/shared/inversify";
import type { IntelligenceSettingsInput, IntelligenceTurnStatus } from "../common/mission-control-contracts";
import type { DesktopMissionApi, OrreryIntelligenceService, OrreryIntelligenceState } from "../common/mission-control-types";

const UNAVAILABLE = "Orrery Intelligence is unavailable in this window.";

/**
 * Renderer-side adapter for Orrery Intelligence.
 * Reads only the narrow preload capability; never handles keys, endpoints, or transports.
 */
@injectable()
export class OrreryIntelligenceDesktopAdapter implements OrreryIntelligenceService {
  private get api(): DesktopMissionApi | undefined { return window.orreryMissionControl; }

  async load(threadId: string): Promise<OrreryIntelligenceState> {
    const api = this.require();
    const transcript = await api.listIntelligenceMessages({ threadId });
    return { threadId, messages: transcript.messages, settings: transcript.settings };
  }

  async send(threadId: string, text: string, missionId?: string): Promise<OrreryIntelligenceState> {
    const api = this.require();
    await api.sendIntelligenceMessage({ intentId: crypto.randomUUID(), threadId, text, ...(missionId ? { missionId } : {}) });
    return this.load(threadId);
  }

  async clear(threadId: string): Promise<OrreryIntelligenceState> {
    const api = this.require();
    const transcript = await api.clearIntelligenceThread({ intentId: crypto.randomUUID(), threadId });
    return { threadId, messages: transcript.messages, settings: transcript.settings };
  }

  async turnStatus(threadId: string): Promise<IntelligenceTurnStatus> {
    return this.require().getIntelligenceTurnStatus({ threadId });
  }

  async configure(input: Omit<IntelligenceSettingsInput, "intentId">): Promise<OrreryIntelligenceState> {
    const api = this.require();
    await api.setIntelligenceSettings({ ...input, intentId: crypto.randomUUID() });
    return this.load("main");
  }

  private require(): DesktopMissionApi {
    const api = this.api;
    if (!api) throw new Error(UNAVAILABLE);
    return api;
  }
}
