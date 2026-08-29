import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionEvent } from "@orrery/mission-control-domain";
import { PROTOCOL_VERSION, type ClientRequest, type ServerResponse } from "@orrery/mission-control-protocol";
import { MissionControlClient, MissionControlError, type LineTransport } from "./index";

const endpoint = { host: "127.0.0.1", port: 1234, version: PROTOCOL_VERSION } as const;
const listItem = { id: "m1", title: "Mission", status: "running" as const, updatedAt: "2026-08-28T00:00:00.000Z" };
const fingerprint = "a".repeat(64);
const approvalNonce = "b".repeat(64);
const mission = {
  id: "m1", title: "Mission", goal: "Ship guarded mutations", mode: "build" as const, status: "awaiting_approval" as const,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z", targetBranch: "main",
  plan: { id: "plan-1", revision: 1, approved: false, createdAt: "2026-08-28T00:00:00.000Z", scope: "Guard mutations", actions: ["Test"], acceptanceCriteria: ["Safe"] },
  events: [], changes: [], evidence: [],
};

class FakeTransport implements LineTransport {
  readonly sent: ClientRequest[] = [];
  connectCount = 0;
  connected = false;
  private messageListener: ((message: unknown) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;

  async connect(): Promise<void> { this.connectCount += 1; this.connected = true; }
  async send(message: ClientRequest): Promise<void> { if (!this.connected) throw new Error("Fake transport is disconnected."); this.sent.push(structuredClone(message)); }
  onMessage(listener: (message: unknown) => void): () => void { this.messageListener = listener; return () => { if (this.messageListener === listener) this.messageListener = undefined; }; }
  onClose(listener: (error?: Error) => void): () => void { this.closeListener = listener; return () => { if (this.closeListener === listener) this.closeListener = undefined; }; }
  async disconnect(): Promise<void> { this.connected = false; }
  receive(message: unknown): void { this.messageListener?.(message); }
  close(error?: Error): void { this.connected = false; this.closeListener?.(error); }
}

function event(sequence: number, overrides: Partial<MissionEvent> = {}): MissionEvent {
  return {
    id: `event-${sequence}`,
    missionId: "m1",
    runId: "run-1",
    sequence,
    timestamp: `2026-08-28T00:00:0${sequence}.000Z`,
    kind: "execution",
    title: `Event ${sequence}`,
    detail: `Sequence ${sequence}`,
    ...overrides,
  };
}

async function connectClient(transport: FakeTransport, client = new MissionControlClient(transport)): Promise<MissionControlClient> {
  const connecting = client.connect(endpoint, "secret");
  await Promise.resolve();
  const hello = transport.sent.at(-1);
  if (!hello || hello.type !== "hello") throw new Error("Expected hello request.");
  transport.receive({ type: "hello_ack", version: PROTOCOL_VERSION, requestId: hello.requestId });
  await connecting;
  return client;
}

describe("MissionControlClient", () => {
  afterEach(() => vi.useRealTimers());

  it("authenticates first and correlates concurrent responses by request ID", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);

    const first = client.listMissions();
    const second = client.listMissions();
    await Promise.resolve();
    const [firstRequest, secondRequest] = transport.sent.slice(-2);
    transport.receive({ type: "mission_list", version: PROTOCOL_VERSION, requestId: secondRequest!.requestId, missions: [] });
    transport.receive({ type: "mission_list", version: PROTOCOL_VERSION, requestId: firstRequest!.requestId, missions: [listItem] });

    await expect(first).resolves.toEqual([listItem]);
    await expect(second).resolves.toEqual([]);
    expect(transport.sent.map((request) => request.type)).toEqual(["hello", "list_missions", "list_missions"]);
  });

  it("rejects strict response mismatches and daemon errors", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const listed = client.listMissions();
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    transport.receive({ type: "pong", version: PROTOCOL_VERSION, requestId: request.requestId });
    await expect(listed).rejects.toThrow(/expected mission_list.*received pong/i);

    const loaded = client.getMission("missing");
    await Promise.resolve();
    const get = transport.sent.at(-1)!;
    transport.receive({ type: "error", version: PROTOCOL_VERSION, requestId: get.requestId, code: "mission_not_found", message: "Mission not found." });
    await expect(loaded).rejects.toEqual(new MissionControlError("mission_not_found", "Mission not found."));
  });

  it("builds every guarded mutation request and returns its correlated result", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const exchange = async <T>(operation: Promise<T>, response: (request: ClientRequest) => ServerResponse): Promise<T> => {
      await Promise.resolve();
      const request = transport.sent.at(-1)!;
      transport.receive(response(request));
      return operation;
    };

    await expect(exchange(
      client.proposeRepository({ intentId: "intent-propose", localPath: "C:/repo" }),
      (request) => ({ type: "repository_proposal", version: PROTOCOL_VERSION, requestId: request.requestId, proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint, approvalNonce, expiresAt: "2026-08-28T01:00:00.000Z" }),
    )).resolves.toMatchObject({ proposalId: "proposal-1", fingerprint });
    await expect(exchange(
      client.approveRepository({ intentId: "intent-approve", proposalId: "proposal-1", fingerprint, approvalNonce }),
      (request) => ({ type: "repository_approved", version: PROTOCOL_VERSION, requestId: request.requestId, repositoryId: "repository-1", fingerprint }),
    )).resolves.toEqual({ repositoryId: "repository-1", fingerprint });
    await expect(exchange(
      client.createMission({ intentId: "intent-create", repositoryId: "repository-1", title: mission.title, goal: mission.goal, mode: mission.mode, plan: { scope: mission.plan.scope, actions: mission.plan.actions, acceptanceCriteria: mission.plan.acceptanceCriteria } }),
      (request) => ({ type: "mission_created", version: PROTOCOL_VERSION, requestId: request.requestId, mission }),
    )).resolves.toEqual(mission);
    await expect(exchange(
      client.runMission({ intentId: "intent-run", missionId: "m1", planRevisionId: "plan-1" }),
      (request) => ({ type: "mission_run_accepted", version: PROTOCOL_VERSION, requestId: request.requestId, mission: { ...mission, status: "running" }, runId: "run-1" }),
    )).resolves.toMatchObject({ mission: { id: "m1" }, runId: "run-1" });
    await expect(exchange(
      client.cancelMission({ intentId: "intent-cancel", missionId: "m1", runId: "run-1" }),
      (request) => ({ type: "mission_cancelled", version: PROTOCOL_VERSION, requestId: request.requestId, mission: { ...mission, status: "cancelled" }, runId: "run-1" }),
    )).resolves.toMatchObject({ mission: { status: "cancelled" }, runId: "run-1" });
    await expect(exchange(
      client.inspectMission({ missionId: "m1", planRevisionId: "plan-1" }),
      (request) => ({ type: "mission_inspection", version: PROTOCOL_VERSION, requestId: request.requestId, mission, planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), review: { changes: [], evidence: [] } }),
    )).resolves.toEqual({ mission, planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), review: { changes: [], evidence: [] } });
    await expect(exchange(
      client.promoteMission({ intentId: "intent-promote", missionId: "m1", planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), decision: "accepted", approvalCapability: "capability-1" }),
      (request) => ({ type: "mission_promotion", version: PROTOCOL_VERSION, requestId: request.requestId, mission: { ...mission, status: "accepted" }, planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted", reviewerId: "reviewer-1", result: "promoted" }),
    )).resolves.toMatchObject({ result: "promoted", changeRevision: "change-1" });

    expect(transport.sent.slice(1).map(({ type }) => type)).toEqual([
      "propose_repository", "approve_repository", "create_mission", "run_mission", "cancel_mission", "inspect_mission", "promote_mission",
    ]);
    expect(transport.sent.filter((request) => "localPath" in request)).toEqual([
      expect.objectContaining({ type: "propose_repository", localPath: "C:/repo" }),
    ]);
    for (const request of transport.sent.filter((item) => item.type !== "propose_repository")) {
      expect(request).not.toHaveProperty("repositoryRoot");
      expect(request).not.toHaveProperty("worktreePath");
      expect(request).not.toHaveProperty("cwd");
      expect(request).not.toHaveProperty("localPath");
    }
  });

  it("rejects operation responses whose guarded bindings do not match the request", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const creating = client.createMission({ intentId: "intent-create", repositoryId: "repository-1", title: mission.title, goal: mission.goal, mode: mission.mode, plan: { scope: mission.plan.scope, actions: mission.plan.actions, acceptanceCriteria: mission.plan.acceptanceCriteria } });
    await Promise.resolve();
    const createRequest = transport.sent.at(-1)!;
    transport.receive({ type: "mission_created", version: PROTOCOL_VERSION, requestId: createRequest.requestId, mission: { ...mission, title: "Different mission" } });
    await expect(creating).rejects.toThrow(/does not match/i);

    const running = client.runMission({ intentId: "intent-run", missionId: "m1", planRevisionId: "plan-1" });
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    transport.receive({ type: "mission_run_accepted", version: PROTOCOL_VERSION, requestId: request.requestId, mission: { ...mission, id: "m2" }, runId: "run-1" });
    await expect(running).rejects.toThrow(/does not match/i);

    const promoting = client.promoteMission({ intentId: "intent-promote", missionId: "m1", planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), decision: "accepted", approvalCapability: "capability-1" });
    await Promise.resolve();
    const promoteRequest = transport.sent.at(-1)!;
    transport.receive({ type: "mission_promotion", version: PROTOCOL_VERSION, requestId: promoteRequest.requestId, mission: { ...mission, status: "accepted" }, planRevisionId: "plan-1", changeRevision: "change-2", decision: "accepted", reviewerId: "reviewer-1", result: "promoted" });
    await expect(promoting).rejects.toThrow(/does not match/i);
  });

  it("preserves daemon mutation error codes and messages", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const approving = client.approveRepository({ intentId: "intent-approve", proposalId: "proposal-1", fingerprint, approvalNonce });
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    transport.receive({ type: "error", version: PROTOCOL_VERSION, requestId: request.requestId, code: "proposal_expired", message: "The repository proposal expired." });
    await expect(approving).rejects.toMatchObject({ name: "MissionControlError", code: "proposal_expired", message: "The repository proposal expired." });
  });

  it("rejects pending work and disconnects on malformed or uncorrelated server messages", async () => {
    for (const invalid of [
      { type: "mission_list", version: PROTOCOL_VERSION, requestId: "request-999", missions: [] },
      { type: "mission_list", version: PROTOCOL_VERSION, requestId: "request-2", missions: [{ ...listItem, status: "launching" }] },
    ]) {
      const transport = new FakeTransport();
      const client = await connectClient(transport);
      const pending = client.listMissions();
      await Promise.resolve();
      transport.receive(invalid);
      await expect(pending).rejects.toThrow(/unexpected response request id|mission status/i);
      await expect(client.listMissions()).rejects.toThrow(/not connected/i);
    }
  });

  it("buffers out-of-order events, drops duplicates, and isolates subscriptions by ID", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const firstEvents: number[] = [];
    const secondEvents: number[] = [];
    const first = client.subscribe("m1", (received) => firstEvents.push(received.sequence));
    await Promise.resolve();
    const firstRequest = transport.sent.at(-1)!;
    if (firstRequest.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: firstRequest.requestId, subscriptionId: firstRequest.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: firstRequest.requestId, subscriptionId: firstRequest.subscriptionId, event: event(2) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: firstRequest.requestId, subscriptionId: firstRequest.subscriptionId, event: event(1) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: firstRequest.requestId, subscriptionId: firstRequest.subscriptionId, event: event(2) });
    await first;

    const second = client.subscribe("m1", (received) => secondEvents.push(received.sequence), undefined, 2);
    await Promise.resolve();
    const secondRequest = transport.sent.at(-1)!;
    if (secondRequest.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    expect(secondRequest.subscriptionId).not.toBe(firstRequest.subscriptionId);
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: secondRequest.requestId, subscriptionId: secondRequest.subscriptionId, missionId: "m1", afterSequence: 2, replay: "durable" });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: secondRequest.requestId, subscriptionId: secondRequest.subscriptionId, event: event(3) });
    await second;

    expect(firstEvents).toEqual([1, 2]);
    expect(secondEvents).toEqual([3]);
  });

  it("exposes and reports a sequence gap after receiving sequence 1 then 3", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const events: number[] = [];
    const changes: unknown[] = [];
    const subscribing = client.subscribe("m1", (received) => events.push(received.sequence), (change) => changes.push(change));
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    await subscribing;

    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(1) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(3) });

    expect(events).toEqual([1]);
    expect(client.getSubscriptionState("m1")).toEqual({ status: "gap", expectedSequence: 2, receivedSequence: 3 });
    expect(changes).toEqual([{ status: "gap", expectedSequence: 2, receivedSequence: 3 }]);
  });

  it("recovers an eventual missing event before the gap deadline", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = await connectClient(transport, new MissionControlClient(transport, { gapTimeoutMs: 50 }));
    const events: number[] = [];
    const changes: unknown[] = [];
    const subscribing = client.subscribe("m1", (received) => events.push(received.sequence), (change) => changes.push(change));
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    await subscribing;

    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(1) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(3) });
    await vi.advanceTimersByTimeAsync(49);
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(2) });
    await vi.advanceTimersByTimeAsync(1);

    expect(events).toEqual([1, 2, 3]);
    expect(client.getSubscriptionState("m1")).toEqual({ status: "live" });
    expect(changes).toEqual([
      { status: "gap", expectedSequence: 2, receivedSequence: 3 },
      { status: "live" },
    ]);
  });

  it("invalidates a missing sequence after bounded time or buffered count", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = await connectClient(transport, new MissionControlClient(transport, { gapTimeoutMs: 50, maxBufferedEvents: 2 }));
    const changes: unknown[] = [];
    const subscribing = client.subscribe("m1", () => undefined, (change) => changes.push(change));
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    await subscribing;

    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(1) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(3) });
    await vi.advanceTimersByTimeAsync(50);

    expect(client.getSubscriptionState("m1")).toEqual({ status: "invalid", expectedSequence: 2, receivedSequence: 3, reason: "timeout" });
    expect(changes.at(-1)).toEqual({ status: "invalid", expectedSequence: 2, receivedSequence: 3, reason: "timeout" });

    const secondChanges: unknown[] = [];
    const second = client.subscribe("m1", () => undefined, (change) => secondChanges.push(change));
    await Promise.resolve();
    const secondRequest = transport.sent.at(-1)!;
    if (secondRequest.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: secondRequest.requestId, subscriptionId: secondRequest.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    await second;
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: secondRequest.requestId, subscriptionId: secondRequest.subscriptionId, event: event(2) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: secondRequest.requestId, subscriptionId: secondRequest.subscriptionId, event: event(3) });

    expect(secondChanges.at(-1)).toEqual({ status: "invalid", expectedSequence: 1, receivedSequence: 2, reason: "buffer_limit" });
  });

  it("uses subscription IDs to unsubscribe exactly one listener", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const subscribing = client.subscribe("m1", () => undefined);
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 0, replay: "durable" });
    const unsubscribe = await subscribing;

    const unsubscribing = unsubscribe();
    await Promise.resolve();
    const unsubscribeRequest = transport.sent.at(-1)!;
    expect(unsubscribeRequest).toMatchObject({ type: "unsubscribe_mission_events", subscriptionId: request.subscriptionId });
    transport.receive({ type: "unsubscribed", version: PROTOCOL_VERSION, requestId: unsubscribeRequest.requestId, subscriptionId: request.subscriptionId });
    await expect(unsubscribing).resolves.toBeUndefined();
  });

  it("starts durable replay after a refreshed final sequence", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const events: number[] = [];
    const subscribing = client.subscribe("m1", (received) => events.push(received.sequence), undefined, 3);
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    expect(request).toMatchObject({ type: "subscribe_mission_events", missionId: "m1", afterSequence: 3 });
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 3, replay: "durable" });
    await subscribing;

    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(4) });

    expect(events).toEqual([4]);
    expect(client.getSubscriptionState("m1")).toEqual({ status: "live" });
  });

  it("reports old-cursor overflow and consumes retained replay followed by live events", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const events: number[] = [];
    const changes: unknown[] = [];
    const subscribing = client.subscribe("m1", (received) => events.push(received.sequence), (change) => changes.push(change), 1);
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");

    transport.receive({
      type: "subscribed",
      version: PROTOCOL_VERSION,
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      missionId: "m1",
      afterSequence: 1,
      replay: "durable",
      cursor: 5,
      highWaterMark: 5,
      overflow: { firstAvailableSequence: 4 },
    });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(4) });
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(5) });
    await subscribing;
    transport.receive({ type: "mission_event", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, event: event(6) });

    expect(events).toEqual([4, 5, 6]);
    expect(client.getSubscriptionState("m1")).toEqual({ status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 6, highWaterMark: 6 });
    expect(changes).toEqual([
      { status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 3, highWaterMark: 5 },
      { status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 4, highWaterMark: 5 },
      { status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 5, highWaterMark: 5 },
      { status: "lost_history", fromSequence: 2, throughSequence: 3, cursor: 6, highWaterMark: 6 },
    ]);
  });

  it("rejects a subscription acknowledgement that is not durable", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const subscribing = client.subscribe("m1", () => undefined, undefined, 2);
    await Promise.resolve();
    const request = transport.sent.at(-1)!;
    if (request.type !== "subscribe_mission_events") throw new Error("Expected subscription request.");
    transport.receive({ type: "subscribed", version: PROTOCOL_VERSION, requestId: request.requestId, subscriptionId: request.subscriptionId, missionId: "m1", afterSequence: 2, replay: "live_only" });
    await expect(subscribing).rejects.toThrow(/durable replay/i);
  });

  it("rejects pending requests on close and reconnects only when explicitly requested", async () => {
    const transport = new FakeTransport();
    const client = await connectClient(transport);
    const pending = client.listMissions();
    await Promise.resolve();
    transport.close(new Error("socket lost"));
    await expect(pending).rejects.toThrow("socket lost");
    await expect(client.listMissions()).rejects.toThrow(/not connected/i);
    expect(transport.connectCount).toBe(1);

    const reconnecting = client.connect(endpoint, "secret");
    await Promise.resolve();
    const hello = transport.sent.at(-1)!;
    expect(hello).toMatchObject({ type: "hello", requestId: "request-4" });
    transport.receive({ type: "hello_ack", version: PROTOCOL_VERSION, requestId: hello.requestId });
    await reconnecting;
    expect(transport.connectCount).toBe(2);
    await client.disconnect();
  });
});
