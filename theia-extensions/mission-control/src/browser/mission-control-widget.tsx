import * as React from "@theia/core/shared/react";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import type { ReviewDecision, MissionCreateInput } from "../common/mission-control-contracts";
import { MissionControlService, type MissionControlState } from "../common/mission-control-types";
import { MissionControlView } from "./mission-control-view";

export const MISSION_CONTROL_WIDGET_ID = "orrery-mission-control";

@injectable()
export class MissionControlWidget extends ReactWidget {
  protected state: MissionControlState = { missions: [], loading: true };
  private requestGeneration = 0;
  private reviewPending = false;
  private actionPending = false;

  @inject(MissionControlService)
  protected readonly service!: MissionControlService;

  @postConstruct()
  protected initialize(): void {
    this.id = MISSION_CONTROL_WIDGET_ID;
    this.title.label = "Mission Control";
    this.title.caption = "Orrery Mission Control";
    this.title.closable = true;
    this.addClass("orrery-mission-control-widget");
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.requestGeneration;
    this.state = { ...this.state, loading: true, pendingReview: this.reviewPending, error: undefined };
    this.update();
    try {
      const state = await this.service.load(this.state.selectedId);
      if (generation !== this.requestGeneration) return;
      this.state = { ...state, pendingReview: this.reviewPending };
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : "Unable to load missions." };
    }
    this.update();
  }

  async selectMission(missionId: string): Promise<void> {
    const generation = ++this.requestGeneration;
    try {
      const selected = await this.service.getMission(missionId);
      if (generation !== this.requestGeneration) return;
      this.state = { ...this.state, loading: false, selectedId: missionId, selected, pendingReview: this.reviewPending, error: undefined };
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : "Unable to load mission." };
    }
    this.update();
  }

  async review(decision: ReviewDecision): Promise<void> {
    const mission = this.state.selected;
    if (!mission || this.reviewPending) return;
    if (decision === "revision_requested") {
      this.state = { ...this.state, error: "Revision requests are not yet available through the trusted desktop mission API." };
      this.update();
      return;
    }
    const reviewKey = `${mission.id}:${mission.plan.id}`;
    this.reviewPending = true;
    this.state = { ...this.state, pendingReview: true, error: undefined };
    this.update();
    try {
      await this.service.review(mission, decision);
      if (this.state.selected && `${this.state.selected.id}:${this.state.selected.plan.id}` === reviewKey) {
        const generation = ++this.requestGeneration;
        const state = await this.service.load(mission.id);
        if (generation === this.requestGeneration) this.state = { ...state, pendingReview: true };
      }
    } catch (error) {
      this.state = { ...this.state, error: error instanceof Error ? error.message : "Unable to review mission." };
    } finally {
      this.reviewPending = false;
      this.state = { ...this.state, pendingReview: false };
    }
    this.update();
  }

  async intakeRepository(localPath: string): Promise<void> { await this.action(() => this.service.intakeRepository({ intentId: crypto.randomUUID(), localPath })); }
  async createMission(input: Omit<MissionCreateInput, "intentId">): Promise<void> { await this.action(() => this.service.create({ ...input, intentId: crypto.randomUUID() })); }
  async runMission(): Promise<void> { const mission = this.state.selected; if (mission) await this.action(() => this.service.run({ intentId: crypto.randomUUID(), missionId: mission.id, planRevisionId: mission.plan.id })); }
  async cancelMission(): Promise<void> { const mission = this.state.selected; if (mission?.activeRunId) await this.action(() => this.service.cancel({ intentId: crypto.randomUUID(), missionId: mission.id, runId: mission.activeRunId! })); }
  private async action(operation: () => Promise<MissionControlState>): Promise<void> {
    if (this.actionPending) return;
    this.actionPending = true; this.state = { ...this.state, loading: true, pendingAction: "Working...", error: undefined }; this.update();
    try { this.state = await operation(); } catch (error) { this.state = { ...this.state, error: error instanceof Error ? error.message : "Mission action failed." }; }
    finally { this.actionPending = false; this.state = { ...this.state, loading: false, pendingAction: undefined }; this.update(); }
  }

  protected render(): React.ReactNode {
    return <MissionControlView state={this.state} onSelect={(id) => void this.selectMission(id)} onRefresh={() => void this.refresh()} onReview={(decision) => void this.review(decision)} onIntake={(path) => void this.intakeRepository(path)} onCreate={(input) => void this.createMission(input)} onRun={() => void this.runMission()} onCancel={() => void this.cancelMission()} />;
  }
}
