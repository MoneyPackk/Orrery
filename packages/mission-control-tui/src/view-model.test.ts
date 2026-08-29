import { describe, expect, test } from "vitest";
import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import type { MissionListItem } from "@orrery/mission-control-protocol";
import { MissionControlViewModel } from "./view-model";

const missions: MissionListItem[] = [
  { id: "mission-1", title: "First mission", status: "running", updatedAt: "2026-08-28T10:00:00.000Z" },
  { id: "mission-2", title: "Second mission", status: "queued", updatedAt: "2026-08-28T11:00:00.000Z" },
];

function event(sequence: number, detail = `detail ${sequence}`): MissionEvent {
  return {
    id: `event-${sequence}`,
    missionId: "mission-1",
    runId: "run-1",
    sequence,
    timestamp: "2026-08-28T10:00:00.000Z",
    kind: "execution",
    title: `Event ${sequence}`,
    detail,
  };
}

function snapshot(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    title: "First mission",
    goal: "Keep the operator informed",
    mode: "build",
    status: "running",
    createdAt: "2026-08-28T09:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    targetBranch: "main",
    plan: {
      id: "plan-1",
      revision: 1,
      approved: true,
      createdAt: "2026-08-28T09:00:00.000Z",
      scope: "Terminal status",
      actions: ["Render state"],
      acceptanceCriteria: ["State is legible"],
    },
    events: [],
    changes: [],
    evidence: [],
    ...overrides,
  };
}

describe("MissionControlViewModel", () => {
  test("distinguishes loading, empty, connected, and error states", () => {
    const model = new MissionControlViewModel();
    expect(model.view(80).connection).toEqual({ state: "loading", label: "LOADING missions" });

    model.setMissions([]);
    expect(model.view(80)).toMatchObject({
      connection: { state: "connected", label: "CONNECTED 0 missions" },
      missionRows: ["  No missions"],
      detailLines: ["Select a mission to inspect."],
    });

    model.setMissions(missions);
    expect(model.view(80)).toMatchObject({
      connection: { state: "connected", label: "CONNECTED 2 missions" },
      selectedMissionId: "mission-1",
    });

    model.setError(new Error("daemon unavailable"));
    expect(model.view(80)).toMatchObject({
      connection: { state: "error", label: "ERROR daemon unavailable" },
      missionRows: ["  No missions"],
    });
  });

  test("keeps selection within list boundaries and preserves it across refresh", () => {
    const model = new MissionControlViewModel();
    model.setMissions(missions);

    model.moveSelection(-1);
    expect(model.selectedMissionId).toBe("mission-1");
    model.moveSelection(1);
    model.moveSelection(1);
    expect(model.selectedMissionId).toBe("mission-2");

    model.setMissions([missions[1], missions[0]]);
    expect(model.selectedMissionId).toBe("mission-2");
    model.setMissions([missions[0]]);
    expect(model.selectedMissionId).toBe("mission-1");
  });

  test("reports an event sequence gap without discarding the event tail", () => {
    const model = new MissionControlViewModel();
    model.setMissions(missions);
    model.setSnapshot(snapshot({ events: [event(1)] }));
    model.appendEvent(event(3));

    const view = model.view(80);
    expect(view.eventLines).toEqual([
      "#1 execution Event 1 - detail 1",
      "! sequence gap: expected 2, received 3",
      "#3 execution Event 3 - detail 3",
    ]);
  });

  test("exposes unknown live-only history until a refreshed snapshot recovers it", () => {
    const model = new MissionControlViewModel();
    model.setMissions(missions);
    model.setSnapshot(snapshot({ events: [event(1)] }));

    model.setEventHistoryState({ status: "gap", expectedSequence: 2, receivedSequence: 3 });
    expect(model.view(80)).toMatchObject({
      eventHistory: { status: "gap", expectedSequence: 2, receivedSequence: 3 },
      eventLines: ["! UNKNOWN HISTORY: expected #2, received #3; refreshing snapshot", "#1 execution Event 1 - detail 1"],
    });

    model.setSnapshot(snapshot({ events: [event(1), event(2), event(3)] }));
    expect(model.view(80).eventHistory).toEqual({ status: "live" });
  });

  test("renders a retained-history interval without treating the subscription as invalid", () => {
    const model = new MissionControlViewModel();
    model.setMissions(missions);
    model.setSnapshot(snapshot({ events: [event(4), event(5)] }));
    model.setEventHistoryState({ status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 5, highWaterMark: 5 });

    expect(model.view(80).eventLines[0]).toBe("! RETAINED HISTORY: events #2-#3 are no longer available; live at #5");
  });

  test("truncates long text to terminal width", () => {
    const model = new MissionControlViewModel();
    model.setMissions([{ ...missions[0], title: "A title that cannot fit in a narrow terminal" }]);
    model.setSnapshot(snapshot({ goal: "A goal that is much too long for the available terminal width" }));

    const view = model.view(24);
    expect(view.missionRows[0]).toBe("> running  A title th…");
    expect(view.detailLines).toContain("Goal: A goal that is …");
    expect(view.missionRows.every((line) => line.length <= 22)).toBe(true);
    expect(view.detailLines.every((line) => line.length <= 22)).toBe(true);
  });

  test("summarizes evidence and limits the event tail", () => {
    const model = new MissionControlViewModel({ eventTailSize: 2 });
    model.setMissions(missions);
    model.setSnapshot(snapshot({
      events: [event(1), event(2), event(3)],
      evidence: [
        { id: "e-1", kind: "test", status: "passed", summary: "unit tests", planRevisionId: "plan-1", timestamp: "2026-08-28T10:00:00.000Z" },
        { id: "e-2", kind: "diagnostic", status: "warning", summary: "slow", planRevisionId: "plan-1", timestamp: "2026-08-28T10:01:00.000Z" },
      ],
    }));

    expect(model.view(80)).toMatchObject({
      evidenceLines: ["passed 1  failed 0  warning 1  info 0", "PASS test: unit tests", "WARN diagnostic: slow"],
      eventLines: ["#2 execution Event 2 - detail 2", "#3 execution Event 3 - detail 3"],
    });
  });
});
