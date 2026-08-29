import { describe, expect, it, vi } from "vitest";
import { MissionControlDaemonClient } from "./mission-control-daemon-client";

describe("MissionControlDaemonClient", () => {
  it("connects lazily once and delegates guarded operations to the shared client", async () => {
    const endpoint = { host: "127.0.0.1", port: 1234, protocol: "mission-control.v1", tokenPath: "token", pid: 1, instanceId: "daemon" } as const;
    const client = {
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      proposeRepository: vi.fn(async () => ({ proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64), expiresAt: "2026-08-28T01:00:00.000Z" })),
      approveRepository: vi.fn(), createMission: vi.fn(), runMission: vi.fn(), cancelMission: vi.fn(),
      getMission: vi.fn(), inspectMission: vi.fn(), promoteMission: vi.fn(),
    };
    const adapter = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => "runtime",
      endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
      readAndProbeDaemon: async () => endpoint,
      readToken: async () => "secret\n",
      createClient: () => client,
    });

    await adapter.proposeRepository({ intentId: "intent-1", localPath: "C:/repo" });
    await adapter.proposeRepository({ intentId: "intent-2", localPath: "C:/other" });

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledWith({ host: endpoint.host, port: endpoint.port, version: endpoint.protocol }, "secret");
    expect(client.proposeRepository).toHaveBeenCalledTimes(2);
    await adapter.disconnect();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("fails closed when no authenticated daemon is available", async () => {
    const adapter = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => "runtime",
      endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
      readAndProbeDaemon: async () => null,
    });
    await expect(adapter.getSnapshot({ missionId: "mission-1" })).rejects.toThrow(/daemon.*available/i);
  });

  it("clears a closed client and retries a mutation once with the same intent", async () => {
    const endpoint = { host: "127.0.0.1", port: 1234, protocol: "mission-control.v1", tokenPath: "token", pid: 1, instanceId: "daemon" } as const;
    const input = { intentId: "intent-1", localPath: "C:/repo" };
    const clients = [
      {
        connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
        proposeRepository: vi.fn(async () => { throw new Error("Transport disconnected."); }),
        approveRepository: vi.fn(), createMission: vi.fn(), runMission: vi.fn(), cancelMission: vi.fn(), getMission: vi.fn(), inspectMission: vi.fn(), promoteMission: vi.fn(),
      },
      {
        connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
        proposeRepository: vi.fn(async () => ({ proposalId: "proposal-1" })),
        approveRepository: vi.fn(), createMission: vi.fn(), runMission: vi.fn(), cancelMission: vi.fn(), getMission: vi.fn(), inspectMission: vi.fn(), promoteMission: vi.fn(),
      },
    ];
    let created = 0;
    const adapter = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => "runtime",
      endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
      readAndProbeDaemon: async () => endpoint,
      readToken: async () => "secret",
      createClient: () => clients[created++]!,
    });

    await expect(adapter.proposeRepository(input)).resolves.toEqual({ proposalId: "proposal-1" });

    expect(created).toBe(2);
    expect(clients[0].disconnect).toHaveBeenCalledOnce();
    expect(clients[0].proposeRepository).toHaveBeenCalledWith(input);
    expect(clients[1].proposeRepository).toHaveBeenCalledWith(input);
  });
});
