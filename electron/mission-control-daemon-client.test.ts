import { describe, expect, it, vi } from "vitest";
import { MissionControlDaemonClient } from "./mission-control-daemon-client";

const endpoint = { host: "127.0.0.1", port: 1234, protocol: "mission-control.v1", tokenPath: "token", pid: 1, instanceId: "daemon" } as const;
const review = { changes: [{ path: "src/a.ts", additions: 1, deletions: 0, binary: false, diff: "+x" }], evidence: [{ id: "e1", kind: "test", status: "passed", summary: "passed", planRevisionId: "plan-1", timestamp: "2026-08-29T10:00:00.000Z" }] };
const inspection = { mission: { id: "mission-1", plan: { id: "plan-1" } }, planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), review };

describe("MissionControlDaemonClient", () => {
  it("approves only the exact native-confirmed repository proposal", async () => {
    const client = sharedClient();
    const proposal = { proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64), expiresAt: "2026-09-01T01:00:00.000Z" };
    client.proposeRepository.mockResolvedValue(proposal);
    client.approveRepository.mockResolvedValue({ repositoryId: "repository-1", fingerprint: proposal.fingerprint });
    const confirmRepository = vi.fn(async () => true);
    const adapter = adapterFor(client, async () => true, true, { confirmRepository });
    await expect(adapter.intakeRepository({ intentId: "intent-1", localPath: "C:/repo" }, {} as never)).resolves.toEqual({ repositoryId: "repository-1", canonicalRoot: "C:/repo", fingerprint: proposal.fingerprint });
    expect(confirmRepository).toHaveBeenCalledWith(proposal, expect.anything());
    expect(client.approveRepository).toHaveBeenCalledWith({ intentId: "intent-1", proposalId: "proposal-1", fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
  });

  it("does not expose the approval nonce when repository confirmation is cancelled", async () => {
    const client = sharedClient();
    client.proposeRepository.mockResolvedValue({ proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64), expiresAt: "2026-09-01T01:00:00.000Z" });
    const adapter = adapterFor(client, async () => true, true, { confirmRepository: async () => false });
    await expect(adapter.intakeRepository({ intentId: "intent-1", localPath: "C:/repo" }, {} as never)).rejects.toThrow(/cancelled/i);
    expect(client.approveRepository).not.toHaveBeenCalled();
  });
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

describe("MissionControlDaemonClient Orrery Intelligence", () => {
  const store = () => {
    const messages: Array<{ id: string; threadId: string; sequence: number; role: "user" | "assistant"; text: string; createdAt: string }> = [];
    const intents: Array<{ intentId: string; requestId: string; replyId: string }> = [];
    return {
      messages,
      intents,
      credentials: undefined as undefined | { provider: "anthropic"; model: string; baseUrl: string; apiKey: string; updatedAt: string },
      readSettingsStatus: vi.fn(async function (this: { credentials?: { model: string } }) {
        return this.credentials ? { configured: true, hasCredential: true, provider: "anthropic" as const, model: this.credentials.model } : { configured: false, hasCredential: false };
      }),
      readCredentials: vi.fn(async function (this: { credentials?: unknown }) { return this.credentials; }),
      writeCredentials: vi.fn(async function (this: { credentials?: unknown }, input: { provider: "anthropic"; model: string; baseUrl: string; apiKey: string }) {
        this.credentials = { ...input, updatedAt: "now" };
        return { configured: true, hasCredential: true, provider: input.provider, model: input.model };
      }),
      readThread: vi.fn(async () => messages),
      findByIntent: vi.fn(async (_thread: string, intentId: string) => {
        const record = intents.find(entry => entry.intentId === intentId);
        if (!record) return undefined;
        const request = messages.find(entry => entry.id === record.requestId);
        const reply = messages.find(entry => entry.id === record.replyId);
        return request && reply ? { request, reply } : undefined;
      }),
      clearThread: vi.fn(async () => { messages.length = 0; return messages; }),
      appendExchange: vi.fn(async (input: { threadId: string; intentId: string; request: string; reply: string }) => {
        const request = { id: `u-${messages.length}`, threadId: input.threadId, sequence: messages.length + 1, role: "user" as const, text: input.request, createdAt: "now" };
        const reply = { id: `a-${messages.length}`, threadId: input.threadId, sequence: messages.length + 2, role: "assistant" as const, text: input.reply, createdAt: "now" };
        messages.push(request, reply);
        intents.push({ intentId: input.intentId, requestId: request.id, replyId: reply.id });
        return { request, reply, messages };
      }),
    };
  };

  it("refuses to send before the user configures a provider", async () => {
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => store() as never });
    await expect(adapter.sendIntelligenceMessage({ intentId: "i1", threadId: "main", text: "hello" })).rejects.toThrow(/not configured/);
  });

  it("stores BYOK settings and returns redacted status without the key", async () => {
    const backing = store();
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => backing as never });
    const status = await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "secret-key" });
    expect(JSON.stringify(status)).not.toContain("secret-key");
    expect(status.configured).toBe(true);
    expect((await adapter.getIntelligenceSettings()).model).toBe("claude-x");
  });

  it("rejects oversized credentials and messages before touching the provider", async () => {
    const provider = vi.fn(async () => "reply");
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => store() as never, requestIntelligenceReply: provider as never });
    await expect(adapter.setIntelligenceSettings({ intentId: "s", provider: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKey: "x".repeat(5_000) })).rejects.toThrow(/too long/);
    await expect(adapter.sendIntelligenceMessage({ intentId: "i", threadId: "main", text: "x".repeat(9_000) })).rejects.toThrow(/length/);
    expect(provider).not.toHaveBeenCalled();
  });

  it("sends the prompt with prior history and persists both turns", async () => {
    const backing = store();
    const provider = vi.fn(async () => "assistant answer");
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => backing as never, requestIntelligenceReply: provider as never });
    await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    const first = await adapter.sendIntelligenceMessage({ intentId: "i1", threadId: "main", text: "first question", missionId: "mission-1" });
    expect(first.request.text).toBe("first question");
    expect(first.reply.text).toBe("assistant answer");
    await adapter.sendIntelligenceMessage({ intentId: "i2", threadId: "main", text: "second question" });
    const secondCall = (provider as unknown as { mock: { calls: Array<[{ history: Array<{ text: string }> }]> } }).mock.calls[1];
    expect(secondCall[0].history.map(turn => turn.text)).toEqual(["first question", "assistant answer"]);
    const transcript = await adapter.listIntelligenceMessages({ threadId: "main" });
    expect(transcript.messages).toHaveLength(4);
  });

  it("replays a repeated intent without calling the provider twice", async () => {
    const backing = store();
    const provider = vi.fn(async () => "one reply");
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => backing as never, requestIntelligenceReply: provider as never });
    await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    const first = await adapter.sendIntelligenceMessage({ intentId: "same", threadId: "main", text: "question" });
    const repeated = await adapter.sendIntelligenceMessage({ intentId: "same", threadId: "main", text: "question" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(repeated.reply.id).toBe(first.reply.id);
  });

  it("clears a thread while preserving configured settings", async () => {
    const backing = store();
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => backing as never, requestIntelligenceReply: (async () => "reply") as never });
    await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    await adapter.sendIntelligenceMessage({ intentId: "i1", threadId: "main", text: "question" });
    const cleared = await adapter.clearIntelligenceThread({ intentId: "c1", threadId: "main" });
    expect(cleared.messages).toEqual([]);
    expect(cleared.settings.configured).toBe(true);
  });

  it("does not require a daemon connection for chat", async () => {
    const client = sharedClient();
    const adapter = adapterFor(client, async () => true, true, { createIntelligenceStore: () => store() as never, requestIntelligenceReply: (async () => "reply") as never });
    await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    await adapter.sendIntelligenceMessage({ intentId: "i1", threadId: "main", text: "question" });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("shares one store across concurrent cold starts so the write lock stays effective", async () => {
    const created: unknown[] = [];
    const adapter = adapterFor(sharedClient(), async () => true, true, {
      createIntelligenceStore: (() => { const instance = store(); created.push(instance); return instance; }) as never,
      requestIntelligenceReply: (async () => "reply") as never,
    });
    await Promise.all([
      adapter.listIntelligenceMessages({ threadId: "main" }),
      adapter.listIntelligenceMessages({ threadId: "main" }),
      adapter.getIntelligenceSettings(),
    ]);
    expect(created).toHaveLength(1);
  });

  it("rate limits provider spend from a compromised renderer", async () => {
    const provider = vi.fn(async () => "reply");
    const adapter = adapterFor(sharedClient(), async () => true, true, { createIntelligenceStore: () => store() as never, requestIntelligenceReply: provider as never });
    await adapter.setIntelligenceSettings({ intentId: "s1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    for (let index = 0; index < 20; index += 1) {
      await adapter.sendIntelligenceMessage({ intentId: `i-${index}`, threadId: "main", text: "question" });
    }
    await expect(adapter.sendIntelligenceMessage({ intentId: "i-overflow", threadId: "main", text: "question" })).rejects.toThrow(/Too many/);
    expect(provider).toHaveBeenCalledTimes(20);
  });
});
