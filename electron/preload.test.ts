import { describe, expect, it, vi } from "vitest";
import { DESKTOP_GET_RUNTIME_CHANNEL } from "./ipc";
import { isValidRuntimeRequest } from "./ipc";
import { createDesktopApi } from "./preload-api";
import { DESKTOP_SMOKE_READY_CHANNEL } from "./channels";
import {
  MISSION_APPROVE_REPOSITORY_CHANNEL,
  MISSION_CANCEL_CHANNEL,
  MISSION_CREATE_CHANNEL,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_INSPECT_CHANNEL,
  MISSION_PROPOSE_REPOSITORY_CHANNEL,
  MISSION_PROMOTE_CHANNEL,
  MISSION_RUN_CHANNEL,
} from "./mission-ipc";

describe("sandboxed preload API", () => {
  it("does not expose direct repository approval or promotion capabilities to the renderer", () => {
    const api = createDesktopApi(vi.fn());
    expect(api.missions).not.toHaveProperty("approveRepository");
    expect(api.missions).not.toHaveProperty("promote");
  });
  it("rejects payload arguments on the fixed runtime channel", () => {
    expect(isValidRuntimeRequest([])).toBe(true);
    expect(isValidRuntimeRequest(["unexpected"])).toBe(false);
  });

  it("exposes only getRuntime and invokes its fixed channel", async () => {
    const runtime = {
      platform: "win32",
      versions: { chrome: "128.0.0", electron: "44.0.0" },
    } as const;
    const invoke = vi.fn().mockResolvedValue(runtime);
    const api = createDesktopApi(invoke);

    expect(Object.keys(api)).toEqual(["getRuntime", "missions"]);
    await expect(api.getRuntime()).resolves.toEqual(runtime);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_GET_RUNTIME_CHANNEL);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("ipcRenderer");
  });

  it("adds only the fixed readiness method when smoke mode is enabled", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const api = createDesktopApi(invoke, true);
    const readiness = {
      desktopRuntimeExists: true,
      processType: "undefined",
      requireType: "undefined",
    } as const;

    expect(Object.keys(api)).toEqual(["getRuntime", "missions", "reportSmokeReadiness"]);
    await expect(api.reportSmokeReadiness?.(readiness)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(DESKTOP_SMOKE_READY_CHANNEL, readiness);
  });

  it("exposes fixed mission intent methods without generic IPC or raw system primitives", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const api = createDesktopApi(invoke);
    const revisionIntent = { intentId: "intent-run", missionId: "mission-1", planRevisionId: "plan-1" };

    await api.missions.proposeRepository({ intentId: "intent-propose", localPath: "C:/repo" });
    await api.missions.create({ intentId: "intent-create", repositoryId: "repository-1", title: "Mission", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } });
    await api.missions.run(revisionIntent);
    await api.missions.cancel({ intentId: "intent-cancel", missionId: "mission-1", runId: "run-1" });
    await api.missions.getSnapshot({ missionId: "mission-1" });
    await api.missions.inspect({ missionId: "mission-1", planRevisionId: "plan-1" });
    await api.missions.reviewAndPromote({ intentId: "intent-review", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });

    expect(invoke.mock.calls).toEqual([
      [MISSION_PROPOSE_REPOSITORY_CHANNEL, { intentId: "intent-propose", localPath: "C:/repo" }],
      [MISSION_CREATE_CHANNEL, { intentId: "intent-create", repositoryId: "repository-1", title: "Mission", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } }],
      [MISSION_RUN_CHANNEL, revisionIntent],
      [MISSION_CANCEL_CHANNEL, { intentId: "intent-cancel", missionId: "mission-1", runId: "run-1" }],
      [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: "mission-1" }],
      [MISSION_INSPECT_CHANNEL, { missionId: "mission-1", planRevisionId: "plan-1" }],
      [MISSION_PROMOTE_CHANNEL, { intentId: "intent-review", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
    ]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("shell");
    expect(api).not.toHaveProperty("fs");
    expect(api).not.toHaveProperty("git");
  });
});
