import { describe, expect, it, vi } from "vitest";
import { MissionControlDaemonClient } from "./mission-control-daemon-client";

const endpoint = { host: "127.0.0.1", port: 1234, protocol: "mission-control.v1", tokenPath: "token", pid: 1, instanceId: "daemon" } as const;
const review = { changes: [{ path: "src/a.ts", additions: 1, deletions: 0, binary: false, diff: "+x" }], evidence: [{ id: "e1", kind: "test", status: "passed", summary: "passed", planRevisionId: "plan-1", timestamp: "2026-08-29T10:00:00.000Z" }] };
const inspection = { mission: { id: "mission-1", plan: { id: "plan-1" } }, planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), review };

describe("MissionControlDaemonClient", () => {
  it("displays exact daemon inspection content and signs its digest only after confirmation", async () => {
    const client = sharedClient();
    client.inspectMission.mockResolvedValue(inspection);
    client.promoteMission.mockResolvedValue({ result: "promoted" });
    const confirmReview = vi.fn(async () => true);
    const adapter = adapterFor(client, confirmReview);
    const input = { intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" as const };
    await expect(adapter.reviewAndPromote(input)).resolves.toEqual({ result: "promoted" });
    expect(confirmReview).toHaveBeenCalledWith({ ...input, changeRevision: "change-1", contentDigest: "a".repeat(64), review }, expect.anything());
    expect(client.promoteMission).toHaveBeenCalledWith(expect.objectContaining({ ...input, changeRevision: "change-1", contentDigest: "a".repeat(64), approvalCapability: expect.any(String) }));
  });

  it("does not sign or promote when trusted review is cancelled", async () => {
    const client = sharedClient();
    client.inspectMission.mockResolvedValue(inspection);
    const adapter = adapterFor(client, async () => false);
    await expect(adapter.reviewAndPromote({ intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" })).rejects.toThrow(/cancelled/i);
    expect(client.promoteMission).not.toHaveBeenCalled();
  });

  it("fails closed when another daemon already owns the runtime", async () => {
    const client = sharedClient();
    const adapter = adapterFor(client, async () => true, false);
    await expect(adapter.getSnapshot({ missionId: "mission-1" })).rejects.toThrow(/electron-owned|already active/i);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("connects once to its managed daemon and stops it on disconnect", async () => {
    const client = sharedClient();
    client.proposeRepository.mockResolvedValue({ proposalId: "p" });
    const adapter = adapterFor(client, async () => true);
    await adapter.proposeRepository({ intentId: "i1", localPath: "C:/repo" });
    await adapter.proposeRepository({ intentId: "i2", localPath: "C:/other" });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.proposeRepository).toHaveBeenCalledTimes(2);
    await adapter.disconnect();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("cancels and tears down an in-flight connection when disconnect begins", async () => {
    const client = sharedClient();
    const connectGate = deferred<void>();
    client.connect.mockImplementation(() => connectGate.promise);
    const stopDaemon = vi.fn(async (): Promise<void> => undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    const pending = adapter.getSnapshot({ missionId: "mission-1" });
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    const shutdown = adapter.disconnect();
    connectGate.resolve();

    await expect(pending).rejects.toThrow(/shutting down/i);
    await shutdown;
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("does not wait for a stalled client connection before stopping its daemon", async () => {
    const client = sharedClient();
    client.connect.mockImplementation(() => new Promise(() => undefined));
    const stopDaemon = vi.fn(async (): Promise<void> => undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    void adapter.getSnapshot({ missionId: "mission-1" }).catch(() => undefined);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());

    await expect(Promise.race([
      adapter.disconnect().then(() => "disconnected"),
      new Promise(resolve => setTimeout(() => resolve("timed-out"), 50)),
    ])).resolves.toBe("disconnected");
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("stops its daemon before waiting for a stalled transport disconnect", async () => {
    const client = sharedClient();
    client.getMission.mockResolvedValue({ id: "mission-1" });
    client.disconnect.mockImplementation(() => new Promise(() => undefined));
    const stopDaemon = vi.fn(async (): Promise<void> => undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    await adapter.getSnapshot({ missionId: "mission-1" });
    void adapter.disconnect();

    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalledOnce());
  });

  it("attempts owned daemon cleanup when client disconnect rejects", async () => {
    const client = sharedClient();
    client.getMission.mockResolvedValue({ id: "mission-1" });
    client.disconnect.mockRejectedValue(new Error("client disconnect failed"));
    const stopDaemon = vi.fn(async (): Promise<void> => undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    await adapter.getSnapshot({ missionId: "mission-1" });

    await expect(adapter.disconnect()).rejects.toThrow("client disconnect failed");
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("does not let a pending connect repopulate after disconnect", async () => {
    const client = sharedClient();
    const connectGate = deferred<void>();
    client.connect.mockImplementation(() => connectGate.promise);
    const stopDaemon = vi.fn(async (): Promise<void> => undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    const pending = adapter.getSnapshot({ missionId: "mission-1" });
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    const shutdown = adapter.disconnect();
    connectGate.resolve();

    await expect(pending).rejects.toThrow(/shutting down/i);
    await shutdown;
    await expect(adapter.getSnapshot({ missionId: "mission-1" })).rejects.toThrow(/shutting down/i);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("retains daemon ownership so failed cleanup can be retried", async () => {
    const client = sharedClient();
    client.getMission.mockResolvedValue({ id: "mission-1" });
    const stopDaemon = vi.fn()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValueOnce(undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    await adapter.getSnapshot({ missionId: "mission-1" });
    await expect(adapter.disconnect()).rejects.toThrow("stop failed");
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(stopDaemon).toHaveBeenCalledTimes(2);
  });

  it("retries a failed daemon stop even when the original transport disconnect stalls", async () => {
    const client = sharedClient();
    client.getMission.mockResolvedValue({ id: "mission-1" });
    client.disconnect.mockImplementation(() => new Promise(() => undefined));
    const stopDaemon = vi.fn()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValueOnce(undefined);
    const adapter = adapterFor(client, async () => true, true, { stopDaemon });

    await adapter.getSnapshot({ missionId: "mission-1" });
    await expect(adapter.disconnect()).rejects.toThrow("stop failed");
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(stopDaemon).toHaveBeenCalledTimes(2);
  });
});

function sharedClient() {
  return { connect: vi.fn<() => Promise<void>>(async () => undefined), disconnect: vi.fn(async () => undefined), proposeRepository: vi.fn(), approveRepository: vi.fn(), createMission: vi.fn(), runMission: vi.fn(), cancelMission: vi.fn(), getMission: vi.fn(), inspectMission: vi.fn(), promoteMission: vi.fn() };
}

function adapterFor(client: ReturnType<typeof sharedClient>, confirmReview: (input: never) => Promise<boolean>, owned = true, extra = {}) {
  return new MissionControlDaemonClient({
    createRuntimeDirectory: async () => "runtime",
    endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
    ensureDaemon: async () => ({ endpoint, owned, ...(owned ? { child: { kill: vi.fn(() => true) }, lock: { nonce: "lock", verify: async () => true, release: async () => undefined } } : {}) }),
    readToken: async () => "secret",
    createClient: () => client as never,
    confirmReview: confirmReview as never,
    parentWindow: () => ({}) as never,
    ...extra,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
