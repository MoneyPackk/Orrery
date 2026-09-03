import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
}));

import { preload } from "./mission-control-preload";
import { MISSION_GET_SNAPSHOT_CHANNEL, MISSION_LIST_CHANNEL, MISSION_REVIEW_CHANNEL } from "./mission-control-preload-api";

describe("Theia Mission Control preload entry point", () => {
  beforeEach(() => {
    electron.invoke.mockClear();
  });

  it("has no import side effect and exposes the narrow API once when Theia invokes preload", async () => {
    expect(electron.exposeInMainWorld).not.toHaveBeenCalled();

    preload();
    preload();

    expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith("orreryMissionControl", expect.any(Object));
    const api = electron.exposeInMainWorld.mock.calls[0][1];
    expect(Object.keys(api)).toEqual([
      "intakeRepository", "create", "run", "cancel", "list", "getSnapshot", "inspect", "reviewAndPromote",
      "getIntelligenceSettings", "setIntelligenceSettings", "listIntelligenceMessages", "sendIntelligenceMessage", "clearIntelligenceThread",
      "listMcpCatalog", "registerMcpServer", "removeMcpServer", "setMcpToolDecision", "invokeMcpTool", "listMcpActivity",
    ]);

    await api.list();
    await api.getSnapshot({ missionId: "mission-1" });
    await api.reviewAndPromote({ intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    expect(electron.invoke.mock.calls).toEqual([
      ["mission:v1:host-ready"],
      [MISSION_LIST_CHANNEL],
      [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: "mission-1" }],
      [MISSION_REVIEW_CHANNEL, { intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
    ]);
  });

});
