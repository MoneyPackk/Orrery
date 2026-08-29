import type { Evidence, Mission, MissionEvent } from "@orrery/mission-control-domain";
import type { MissionListItem } from "@orrery/mission-control-protocol";
import type { SubscriptionState } from "@orrery/mission-control-client";

export type ConnectionState = "loading" | "connected" | "error";

export interface MissionControlTerminalView {
  connection: { state: ConnectionState; label: string };
  selectedMissionId?: string;
  missionRows: string[];
  detailLines: string[];
  eventLines: string[];
  evidenceLines: string[];
  subscribed: boolean;
  eventHistory: SubscriptionState;
}

export class MissionControlViewModel {
  private connectionState: ConnectionState = "loading";
  private errorMessage = "";
  private missions: ReadonlyArray<MissionListItem> = [];
  private selection = 0;
  private snapshot?: Mission;
  private events: MissionEvent[] = [];
  private gaps = new Map<number, number>();
  private isSubscribed = false;
  private eventHistory: SubscriptionState = { status: "live" };
  private readonly eventTailSize: number;

  constructor(options: { eventTailSize?: number } = {}) {
    this.eventTailSize = Math.max(1, options.eventTailSize ?? 8);
  }

  get selectedMissionId(): string | undefined {
    return this.missions[this.selection]?.id;
  }

  get subscribed(): boolean {
    return this.isSubscribed;
  }

  setLoading(): void {
    this.connectionState = "loading";
    this.errorMessage = "";
  }

  setMissions(missions: ReadonlyArray<MissionListItem>): void {
    const selectedId = this.selectedMissionId;
    this.missions = [...missions];
    const preserved = selectedId ? this.missions.findIndex((mission) => mission.id === selectedId) : -1;
    this.selection = preserved >= 0 ? preserved : Math.min(this.selection, Math.max(0, this.missions.length - 1));
    this.connectionState = "connected";
    this.errorMessage = "";
    if (this.snapshot?.id !== this.selectedMissionId) this.clearInspection();
  }

  setError(error: Error | string): void {
    this.connectionState = "error";
    this.errorMessage = error instanceof Error ? error.message : error;
    this.missions = [];
    this.selection = 0;
    this.clearInspection();
  }

  moveSelection(delta: number): boolean {
    const next = Math.max(0, Math.min(this.missions.length - 1, this.selection + delta));
    if (next === this.selection) return false;
    this.selection = next;
    this.clearInspection();
    return true;
  }

  setSnapshot(snapshot: Mission): void {
    this.snapshot = snapshot;
    this.events = [...snapshot.events].sort((left, right) => left.sequence - right.sequence);
    this.gaps.clear();
    this.recordGaps();
    this.eventHistory = { status: "live" };
  }

  appendEvent(event: MissionEvent): void {
    if (event.missionId !== this.selectedMissionId || this.events.some((item) => item.sequence === event.sequence)) return;
    this.events.push(event);
    this.events.sort((left, right) => left.sequence - right.sequence);
    this.gaps.clear();
    this.recordGaps();
  }

  setSubscribed(subscribed: boolean): void {
    this.isSubscribed = subscribed;
  }

  setEventHistoryState(state: SubscriptionState): void {
    this.eventHistory = state;
  }

  view(width: number): MissionControlTerminalView {
    const lineWidth = Math.max(1, width - 2);
    return {
      connection: this.connectionView(),
      selectedMissionId: this.selectedMissionId,
      missionRows: this.missionRows(lineWidth),
      detailLines: this.detailLines(lineWidth),
      eventLines: this.eventLines(lineWidth),
      evidenceLines: this.evidenceLines(lineWidth),
      subscribed: this.isSubscribed,
      eventHistory: this.eventHistory,
    };
  }

  private clearInspection(): void {
    this.snapshot = undefined;
    this.events = [];
    this.gaps.clear();
    this.isSubscribed = false;
    this.eventHistory = { status: "live" };
  }

  private connectionView(): MissionControlTerminalView["connection"] {
    if (this.connectionState === "loading") return { state: "loading", label: "LOADING missions" };
    if (this.connectionState === "error") return { state: "error", label: `ERROR ${this.errorMessage}` };
    return { state: "connected", label: `CONNECTED ${this.missions.length} missions` };
  }

  private missionRows(width: number): string[] {
    if (this.missions.length === 0) return [truncate("  No missions", width)];
    return this.missions.map((mission, index) => truncate(
      `${index === this.selection ? ">" : " "} ${mission.status}  ${mission.title}`,
      width,
    ));
  }

  private detailLines(width: number): string[] {
    if (!this.snapshot || this.snapshot.id !== this.selectedMissionId) {
      return [truncate(this.selectedMissionId ? "Press enter or i to inspect." : "Select a mission to inspect.", width)];
    }
    return [
      `Title: ${this.snapshot.title}`,
      `Status: ${this.snapshot.status}  Mode: ${this.snapshot.mode}`,
      `Goal: ${this.snapshot.goal}`,
      `Plan r${this.snapshot.plan.revision}: ${this.snapshot.plan.scope}`,
    ].map((line) => truncate(line, width));
  }

  private eventLines(width: number): string[] {
    const lines: string[] = [];
    if (this.eventHistory.status === "lost_history") {
      lines.push(`! RETAINED HISTORY: events #${this.eventHistory.fromSequence}-#${this.eventHistory.throughSequence} are no longer available; live at #${this.eventHistory.cursor}`);
    } else if (this.eventHistory.status !== "live") {
      const suffix = this.eventHistory.status === "invalid" ? ` (${this.eventHistory.reason})` : "; refreshing snapshot";
      lines.push(`! UNKNOWN HISTORY: expected #${this.eventHistory.expectedSequence}, received #${this.eventHistory.receivedSequence}${suffix}`);
    }
    for (const event of this.events) {
      const gapEnd = this.gaps.get(event.sequence);
      if (gapEnd !== undefined) lines.push(`! sequence gap: expected ${gapEnd}, received ${event.sequence}`);
      lines.push(`#${event.sequence} ${event.kind} ${event.title} - ${event.detail}`);
    }
    return (lines.length === 0 ? ["No events"] : lines.slice(-this.eventTailSize - this.gaps.size - (this.eventHistory.status === "live" ? 0 : 1)))
      .map((line) => truncate(line, width));
  }

  private evidenceLines(width: number): string[] {
    const evidence = this.snapshot?.evidence ?? [];
    if (evidence.length === 0) return ["No evidence"];
    const counts = countEvidence(evidence);
    return [
      `passed ${counts.passed}  failed ${counts.failed}  warning ${counts.warning}  info ${counts.informational}`,
      ...evidence.map((item) => `${evidenceLabel(item.status)} ${item.kind}: ${item.summary}`),
    ].map((line) => truncate(line, width));
  }

  private recordGaps(): void {
    let expected = this.events[0]?.sequence ?? 1;
    for (const event of this.events) {
      if (event.sequence > expected) this.gaps.set(event.sequence, expected);
      expected = event.sequence + 1;
    }
  }
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function countEvidence(evidence: ReadonlyArray<Evidence>): Record<Evidence["status"], number> {
  const counts: Record<Evidence["status"], number> = { passed: 0, failed: 0, warning: 0, informational: 0 };
  for (const item of evidence) counts[item.status] += 1;
  return counts;
}

function evidenceLabel(status: Evidence["status"]): string {
  return { passed: "PASS", failed: "FAIL", warning: "WARN", informational: "INFO" }[status];
}
