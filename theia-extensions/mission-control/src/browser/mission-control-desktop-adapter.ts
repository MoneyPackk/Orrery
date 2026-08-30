import { injectable } from "@theia/core/shared/inversify";
import type { Mission } from "../common/mission-control-contracts";
import type { DesktopMissionApi, MissionControlService, MissionControlState } from "../common/mission-control-types";

@injectable()
export class MissionControlDesktopAdapter implements MissionControlService {
  private get api(): DesktopMissionApi | undefined { return window.orreryMissionControl; }

  async load(selectedId?: string): Promise<MissionControlState> {
    if (!this.api) return { missions: [], selectedId: undefined, selected: undefined };
    const missions = await this.api.list();
    const nextSelectedId = selectedId && missions.some(({ id }) => id === selectedId) ? selectedId : missions[0]?.id;
    const selected = nextSelectedId ? await this.getMission(nextSelectedId) : undefined;
    return { missions, selectedId: nextSelectedId, selected };
  }

  async getMission(missionId: string): Promise<Mission> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    return this.api.getSnapshot({ missionId });
  }

  async review(mission: Mission, decision: "accepted" | "rejected"): Promise<Mission> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    const result = await this.api.reviewAndPromote({
      intentId: crypto.randomUUID(), missionId: mission.id, planRevisionId: mission.plan.id, decision,
    });
    return result.mission;
  }
}
