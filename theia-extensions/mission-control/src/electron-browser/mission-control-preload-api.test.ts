import { describe, expect, it, vi } from "vitest";
import {
  createMissionControlPreloadApi,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
  INTELLIGENCE_GET_SETTINGS_CHANNEL, INTELLIGENCE_SET_SETTINGS_CHANNEL, INTELLIGENCE_LIST_MESSAGES_CHANNEL, INTELLIGENCE_SEND_MESSAGE_CHANNEL, INTELLIGENCE_CLEAR_THREAD_CHANNEL,
} from "./mission-control-preload-api";

describe("Theia Mission Control preload API", () => {
  it("exposes only bounded mission operations over fixed channels", async () => {
    const call = vi.fn().mockResolvedValue({});
    const api = createMissionControlPreloadApi(call);
    expect(Object.keys(api)).toEqual([
      "intakeRepository", "create", "run", "cancel", "list", "getSnapshot", "inspect", "reviewAndPromote",
      "getIntelligenceSettings", "setIntelligenceSettings", "listIntelligenceMessages", "sendIntelligenceMessage", "clearIntelligenceThread", "getIntelligenceTurnStatus", "cancelIntelligenceTurn",
      "listMcpCatalog", "registerMcpServer", "removeMcpServer", "setMcpToolDecision", "invokeMcpTool", "listMcpActivity",
    ]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("approveRepository");

    await api.intakeRepository({ intentId: "repo-1", localPath: "C:/repo" });
    await api.create({ intentId: "create-1", repositoryId: "repository-1", title: "Title", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } });
    await api.run({ intentId: "run-1", missionId: "mission-1", planRevisionId: "plan-1" });
    await api.cancel({ intentId: "cancel-1", missionId: "mission-1", runId: "run-1" });
    await api.list();
    await api.getSnapshot({ missionId: "mission-1" });
    await api.inspect({ missionId: "mission-1", planRevisionId: "plan-1" });
    await api.reviewAndPromote({ intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    expect(call.mock.calls).toEqual([
      [MISSION_INTAKE_REPOSITORY_CHANNEL, { intentId: "repo-1", localPath: "C:/repo" }],
      [MISSION_CREATE_CHANNEL, { intentId: "create-1", repositoryId: "repository-1", title: "Title", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } }],
      [MISSION_RUN_CHANNEL, { intentId: "run-1", missionId: "mission-1", planRevisionId: "plan-1" }],
      [MISSION_CANCEL_CHANNEL, { intentId: "cancel-1", missionId: "mission-1", runId: "run-1" }],
      [MISSION_LIST_CHANNEL],
      [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: "mission-1" }],
      [MISSION_INSPECT_CHANNEL, { missionId: "mission-1", planRevisionId: "plan-1" }],
      [MISSION_REVIEW_CHANNEL, { intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
    ]);
  });

  it("routes Orrery Intelligence calls over fixed channels without exposing event or key APIs", async () => {
    const call = vi.fn().mockResolvedValue({});
    const api = createMissionControlPreloadApi(call);
    await api.getIntelligenceSettings();
    await api.setIntelligenceSettings({ intentId: "s-1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "user-key" });
    await api.listIntelligenceMessages({ threadId: "main" });
    await api.sendIntelligenceMessage({ intentId: "i-1", threadId: "main", text: "hello" });
    await api.clearIntelligenceThread({ intentId: "c-1", threadId: "main" });
    expect(call.mock.calls).toEqual([
      [INTELLIGENCE_GET_SETTINGS_CHANNEL],
      [INTELLIGENCE_SET_SETTINGS_CHANNEL, { intentId: "s-1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "user-key" }],
      [INTELLIGENCE_LIST_MESSAGES_CHANNEL, { threadId: "main" }],
      [INTELLIGENCE_SEND_MESSAGE_CHANNEL, { intentId: "i-1", threadId: "main", text: "hello" }],
      [INTELLIGENCE_CLEAR_THREAD_CHANNEL, { intentId: "c-1", threadId: "main" }],
    ]);
    expect(api).not.toHaveProperty("on");
    expect(api).not.toHaveProperty("readIntelligenceKey");
  });
});
