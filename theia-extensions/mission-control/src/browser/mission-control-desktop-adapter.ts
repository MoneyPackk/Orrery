import { injectable } from "@theia/core/shared/inversify";
import type { Mission, RepositoryIntakeInput, MissionCreateInput, MissionRunInput, MissionCancelInput } from "../common/mission-control-contracts";
import type { DesktopMissionApi, MissionControlService, MissionControlState } from "../common/mission-control-types";

@injectable()
export class MissionControlDesktopAdapter implements MissionControlService {
  private repository?: MissionControlState["repository"];
  private get api(): DesktopMissionApi | undefined { return window.orreryMissionControl; }

  async load(selectedId?: string): Promise<MissionControlState> {
    if (!this.api) return { missions: [], selectedId: undefined, selected: undefined, repository: this.repository };
    const missions = await this.api.list();
    const nextSelectedId = selectedId && missions.some(({ id }) => id === selectedId) ? selectedId : missions[0]?.id;
    const selected = nextSelectedId ? await this.getMission(nextSelectedId) : undefined;
    return { missions, selectedId: nextSelectedId, selected, repository: this.repository };
  }

  async getMission(missionId: string): Promise<Mission> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    return this.api.getSnapshot({ missionId });
  }

  async intakeRepository(input: RepositoryIntakeInput): Promise<MissionControlState> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    this.repository = await this.api.intakeRepository(input);
    return this.load();
  }
  async create(input: MissionCreateInput): Promise<MissionControlState> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    const mission = await this.api.create(input);
    return { ...await this.load(mission.id), selected: mission, selectedId: mission.id };
  }
  async run(input: MissionRunInput): Promise<MissionControlState> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    const result = await this.api.run(input);
    return { ...await this.load(result.mission.id), selected: result.mission, selectedId: result.mission.id };
  }
  async cancel(input: MissionCancelInput): Promise<MissionControlState> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    const result = await this.api.cancel(input);
    return { ...await this.load(result.mission.id), selected: result.mission, selectedId: result.mission.id };
  }

  async review(mission: Mission, decision: "accepted" | "rejected"): Promise<Mission> {
    if (!this.api) throw new Error("Orrery desktop mission service is unavailable.");
    const result = await this.api.reviewAndPromote({
      intentId: crypto.randomUUID(), missionId: mission.id, planRevisionId: mission.plan.id, decision,
    });
    return result.mission;
  }
}
