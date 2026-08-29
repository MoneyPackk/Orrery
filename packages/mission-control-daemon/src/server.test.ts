import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import { MAX_LINE_BYTES, decodeMessage, encodeMessage, type ProtocolMessage } from "@orrery/mission-control-protocol";
import { DaemonServer, MissionRegistry, type MissionEventSource } from "./index";
import type { MissionAuthority } from "./mission-authority";
import type { MissionSnapshot } from "./authority-types";

const mission: Mission = {
  id: "mission-1",
  title: "Secure local daemon",
  goal: "Expose immutable mission state",
  mode: "build",
  status: "running",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T01:00:00.000Z",
  targetBranch: "main",
  missionBranch: "orrery/mission-1",
  workspaceId: "workspace-1",
  activeRunId: "run-1",
  plan: {
    id: "plan-1",
    revision: 1,
    approved: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    scope: "daemon",
    actions: ["serve snapshots"],
    acceptanceCriteria: ["authenticated"],
  },
  events: [],
  changes: [],
  evidence: [],
};

class TestEventSource implements MissionEventSource {
  private readonly listeners = new Map<string, Set<(event: MissionEvent) => void>>();

  subscribe(missionId: string, listener: (event: MissionEvent) => void): () => void {
    const listeners = this.listeners.get(missionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(missionId, listeners);
    return () => listeners.delete(listener);
  }

  emit(event: MissionEvent): void {
    for (const listener of this.listeners.get(event.missionId) ?? []) listener(event);
  }
}

class SynchronousEventSource implements MissionEventSource {
  subscribe(_missionId: string, listener: (event: MissionEvent) => void): () => void {
    listener(event(1));
    return () => undefined;
  }
}

class DurableEventSource extends TestEventSource {
  constructor(private readonly history: MissionEvent[]) { super(); }

  async readAfter(missionId: string, sequence: number): Promise<readonly MissionEvent[]> {
    return this.history.filter((item) => item.missionId === missionId && item.sequence > sequence);
  }
}

class BoundedDurableEventSource extends TestEventSource {
  readonly calls: Array<{ after: number; through?: number }> = [];
  constructor(private readonly history: MissionEvent[], private readonly firstAvailableSequence = 1) { super(); }
  async highWaterMark(): Promise<number> { return this.history.at(-1)?.sequence ?? 0; }
  async readAfter(_missionId: string, sequence: number, throughSequence?: number) {
    this.calls.push({ after: sequence, through: throughSequence });
    return {
      events: this.history.filter((item) => item.sequence > sequence && item.sequence >= this.firstAvailableSequence && item.sequence <= (throughSequence ?? Number.MAX_SAFE_INTEGER)),
      cursor: Math.max(sequence, throughSequence ?? sequence),
      highWaterMark: throughSequence ?? 0,
      overflow: sequence < this.firstAvailableSequence - 1 ? { firstAvailableSequence: this.firstAvailableSequence } : undefined,
    };
  }
}

class TestConnection {
  private buffer = "";
  private readonly messages: ProtocolMessage[] = [];
  private readonly waiters: Array<(message: ProtocolMessage) => void> = [];

  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const message = decodeMessage(this.buffer.slice(0, newline + 1));
        this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  send(message: ProtocolMessage): void {
    this.socket.write(encodeMessage(message));
  }

  next(): Promise<ProtocolMessage> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const servers: DaemonServer[] = [];
const sockets: Socket[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function start(options: { idleTimeoutMs?: number; eventSource?: MissionEventSource; authority?: MissionAuthority; mission?: Mission } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-server-"));
  directories.push(directory);
  const repository = {
    list: async () => [options.mission ?? mission],
    get: async (id: string) => id === (options.mission ?? mission).id ? (options.mission ?? mission) : null,
  };
  const server = new DaemonServer({
    registry: new MissionRegistry(repository),
    tokenPath: join(directory, "daemon.token"),
    idleTimeoutMs: options.idleTimeoutMs,
    eventSource: options.eventSource,
    authority: options.authority,
  });
  servers.push(server);
  const endpoint = await server.start();
  return { server, endpoint, token: await import("node:fs/promises").then(({ readFile }) => readFile(endpoint.tokenPath, "utf8")) };
}

async function open(port: number, host = "127.0.0.1"): Promise<TestConnection> {
  const socket = connect({ port, host });
  sockets.push(socket);
  await once(socket, "connect");
  return new TestConnection(socket);
}

async function authenticate(connection: TestConnection, token: string, requestId = "hello-1") {
  connection.send({ type: "hello", version: "mission-control.v1", requestId, token });
  return connection.next();
}

function event(sequence: number): MissionEvent {
  return {
    id: `event-${sequence}`,
    missionId: mission.id,
    runId: "run-1",
    sequence,
    timestamp: `2026-08-28T01:00:0${sequence}.000Z`,
    kind: "execution",
    title: `Event ${sequence}`,
    detail: `Sequence ${sequence}`,
  };
}

describe("DaemonServer", () => {
  it("dispatches every guarded authority request and rejects raw paths before authority dispatch", async () => {
    const snapshot = structuredClone(mission) as MissionSnapshot;
    const proposal = { proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint: "f".repeat(64), gitIdentity: "identity", approvalNonce: "a".repeat(64), expiresAt: "2026-08-28T02:00:00.000Z", payloadVersion: 1 as const };
    const authority = {
      proposeRepository: vi.fn(async () => proposal),
      approveRepository: vi.fn(async () => ({ repositoryId: "repository-1", fingerprint: proposal.fingerprint })),
      create: vi.fn(async () => snapshot),
      run: vi.fn(async () => ({ mission: snapshot, runId: "run-1", status: "running", workspace: {}, changeSnapshot: {} })),
      cancel: vi.fn(async () => snapshot),
      inspect: vi.fn(async () => ({ mission: snapshot, workspace: {}, changeSnapshot: {}, planRevisionId: "plan-1" })),
      promote: vi.fn(async () => ({ mission: snapshot, result: { status: "promoted", revision: "target-2" }, reviewerId: "trusted-reviewer" })),
    } as unknown as MissionAuthority;
    const { endpoint, token } = await start({ authority, eventSource: new DurableEventSource([]) });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "propose_repository", version: "mission-control.v1", requestId: "proposal", intentId: "proposal-intent", localPath: "C:/repo" });
    await expect(connection.next()).resolves.toMatchObject({ type: "repository_proposal", proposalId: "proposal-1" });
    connection.send({ type: "approve_repository", version: "mission-control.v1", requestId: "approval", intentId: "approval-intent", proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
    await expect(connection.next()).resolves.toMatchObject({ type: "repository_approved", repositoryId: "repository-1" });
    const createRequest = { type: "create_mission" as const, version: "mission-control.v1" as const, requestId: "create", intentId: "create-intent", repositoryId: "repository-1", title: "Mission", goal: "Goal", mode: "build" as const, plan: { scope: "scope", actions: ["run"], acceptanceCriteria: ["pass"] } };
    connection.send(createRequest);
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_created", mission: { id: mission.id } });
    connection.send({ type: "create_mission", version: "mission-control.v1", requestId: "create-retry", intentId: createRequest.intentId, repositoryId: createRequest.repositoryId, title: createRequest.title, goal: createRequest.goal, mode: createRequest.mode, plan: createRequest.plan });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_created", mission: { id: mission.id } });
    connection.send({ type: "run_mission", version: "mission-control.v1", requestId: "run", intentId: "run-intent", missionId: mission.id, planRevisionId: mission.plan.id });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_run_accepted", runId: "run-1" });
    connection.send({ type: "cancel_mission", version: "mission-control.v1", requestId: "cancel", intentId: "cancel-intent", missionId: mission.id, runId: "run-1" });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_cancelled", runId: "run-1" });
    connection.send({ type: "inspect_mission", version: "mission-control.v1", requestId: "inspect", missionId: mission.id, planRevisionId: mission.plan.id });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_inspection", planRevisionId: mission.plan.id });
    connection.send({ type: "promote_mission", version: "mission-control.v1", requestId: "promote", intentId: "promote-intent", missionId: mission.id, planRevisionId: mission.plan.id, changeRevision: "change-1", decision: "accepted", approvalCapability: "capability-1" });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_promotion", result: "promoted" });
    expect(authority.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ intentId: "create-intent" }));

    const rejected = await open(endpoint.port);
    await authenticate(rejected, token, "hello-raw");
    rejected.socket.write(`${JSON.stringify({ ...createRequest, requestId: "raw-path", repositoryRoot: "C:/repo" })}\n`);
    await once(rejected.socket, "close");
    expect(authority.create).toHaveBeenCalledTimes(2);
  });

  it("replays durable events after the cursor before live events emitted during replay", async () => {
    const durable = event(2);
    let releaseReplay: (() => void) | undefined;
    const source = new DurableEventSource([event(1), durable]);
    const original = source.readAfter.bind(source);
    source.readAfter = async (...args) => {
      await new Promise<void>((resolve) => { releaseReplay = resolve; });
      return original(...args);
    };
    const { endpoint, token } = await start({ eventSource: source });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "replay", subscriptionId: "sub", missionId: mission.id, afterSequence: 1 });
    while (!releaseReplay) await new Promise((resolve) => setTimeout(resolve, 0));
    source.emit(event(3));
    releaseReplay?.();
    await expect(connection.next()).resolves.toMatchObject({ type: "subscribed", replay: "durable" });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_event", event: { sequence: 2 } });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_event", event: { sequence: 3 } });
  });
  it("captures a replay high-water mark and acknowledges a structured cursor", async () => {
    const source = new BoundedDurableEventSource([event(1), event(2)]);
    const { endpoint, token } = await start({ eventSource: source });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);

    connection.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "bounded-replay", subscriptionId: "sub", missionId: mission.id, afterSequence: 0 });

    await expect(connection.next()).resolves.toMatchObject({ type: "subscribed", replay: "durable", cursor: 2, highWaterMark: 2 });
    expect(source.calls).toEqual([{ after: 0, through: 2 }]);
  });

  it("returns structured replay overflow instead of disconnecting on retained-history gaps", async () => {
    const source = new BoundedDurableEventSource([event(2), event(3)], 2);
    const { endpoint, token } = await start({ eventSource: source });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);

    connection.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "overflow", subscriptionId: "sub", missionId: mission.id, afterSequence: 0 });

    await expect(connection.next()).resolves.toMatchObject({ type: "subscribed", replay: "durable", cursor: 3, highWaterMark: 3, overflow: { firstAvailableSequence: 2 } });
    expect(connection.socket.destroyed).toBe(false);
  });
  it("rejects a non-loopback bind configuration before creating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-public-"));
    directories.push(directory);
    const tokenPath = join(directory, "daemon.token");
    const server = new DaemonServer({
      host: "0.0.0.0",
      tokenPath,
      registry: new MissionRegistry({ list: async () => [], get: async () => null }),
    });
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/loopback/i);
    await expect(access(tokenPath)).rejects.toThrow();
  });

  it("requires a valid hello before handling requests", async () => {
    const { endpoint } = await start();
    const unauthenticated = await open(endpoint.port);
    unauthenticated.send({ type: "list_missions", version: "mission-control.v1", requestId: "list-early" });

    await expect(unauthenticated.next()).resolves.toMatchObject({ type: "error", requestId: "list-early", code: "authentication_required" });
    await once(unauthenticated.socket, "close");

    const invalid = await open(endpoint.port);
    invalid.send({ type: "hello", version: "mission-control.v1", requestId: "bad-hello", token: "0".repeat(64) });
    await expect(invalid.next()).resolves.toMatchObject({ type: "error", requestId: "bad-hello", code: "authentication_failed" });
    await once(invalid.socket, "close");
  });

  it("returns secret-free endpoint metadata and correlates hello, list, get, and ping responses", async () => {
    const { endpoint, token } = await start();
    expect(endpoint).toEqual({ host: "127.0.0.1", port: expect.any(Number), version: "mission-control.v1", tokenPath: expect.any(String) });
    expect(JSON.stringify(endpoint)).not.toContain(token);
    const connection = await open(endpoint.port);

    await expect(authenticate(connection, token, "hello-correlation")).resolves.toEqual({ type: "hello_ack", version: "mission-control.v1", requestId: "hello-correlation" });
    connection.send({ type: "list_missions", version: "mission-control.v1", requestId: "list-correlation" });
    await expect(connection.next()).resolves.toEqual({
      type: "mission_list",
      version: "mission-control.v1",
      requestId: "list-correlation",
      missions: [{ id: mission.id, title: mission.title, status: mission.status, updatedAt: mission.updatedAt }],
    });
    connection.send({ type: "get_mission", version: "mission-control.v1", requestId: "get-correlation", missionId: mission.id });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_snapshot", requestId: "get-correlation", mission });
    connection.send({ type: "ping", version: "mission-control.v1", requestId: "ping-correlation" });
    await expect(connection.next()).resolves.toEqual({ type: "pong", version: "mission-control.v1", requestId: "ping-correlation" });
  });

  it("strips durable operations and kernel-only binary metadata from public mission snapshots", async () => {
    const internalMission = {
      ...mission,
      changes: [{ path: "image.bin", additions: 0, deletions: 0, binary: true, diff: "GIT binary patch" }],
      operations: { "run-intent": { operation: "run", requestDigest: "digest", state: "in_progress", runId: "run-1" } },
    } as unknown as Mission;
    const { endpoint, token } = await start({ mission: internalMission });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);

    connection.send({ type: "get_mission", version: "mission-control.v1", requestId: "get-public", missionId: mission.id });

    await expect(connection.next()).resolves.toEqual(expect.objectContaining({
      type: "mission_snapshot",
      mission: expect.objectContaining({
        changes: [{ path: "image.bin", additions: 0, deletions: 0, diff: "GIT binary patch" }],
      }),
    }));
    const response = await (async () => {
      connection.send({ type: "get_mission", version: "mission-control.v1", requestId: "get-public-again", missionId: mission.id });
      return connection.next();
    })();
    expect(JSON.stringify(response)).not.toContain("operations");
    expect((response as Extract<ProtocolMessage, { type: "mission_snapshot" }>).mission.changes[0]).not.toHaveProperty("binary");
  });

  it("rejects duplicate request IDs on one connection", async () => {
    const { endpoint, token } = await start();
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "ping", version: "mission-control.v1", requestId: "duplicate" });
    connection.send({ type: "ping", version: "mission-control.v1", requestId: "duplicate" });

    await expect(connection.next()).resolves.toMatchObject({ type: "pong", requestId: "duplicate" });
    await expect(connection.next()).resolves.toMatchObject({ type: "error", requestId: "duplicate", code: "duplicate_request_id" });
  });

  it("closes the connection when its bounded request ID history is exhausted", async () => {
    const { endpoint, token } = await start();
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    for (let index = 1; index < 4_096; index += 1) {
      connection.send({ type: "ping", version: "mission-control.v1", requestId: `bounded-${index}` });
      await expect(connection.next()).resolves.toMatchObject({ type: "pong", requestId: `bounded-${index}` });
    }
    const closed = once(connection.socket, "close");

    connection.send({ type: "ping", version: "mission-control.v1", requestId: "bounded-overflow" });

    await expect(connection.next()).resolves.toMatchObject({
      type: "error",
      requestId: "bounded-overflow",
      code: "request_id_history_exhausted",
    });
    await closed;
  });

  it("serializes pipelined hello and requests while bounding only incomplete lines", async () => {
    const { endpoint, token } = await start();
    const connection = await open(endpoint.port);
    const hello = encodeMessage({ type: "hello", version: "mission-control.v1", requestId: "hello-pipeline", token });
    const pings = Array.from({ length: 4_000 }, (_, index) => encodeMessage({
      type: "ping" as const,
      version: "mission-control.v1" as const,
      requestId: `ping-${index}`,
    })).join("");
    expect(Buffer.byteLength(pings, "utf8")).toBeGreaterThan(MAX_LINE_BYTES);

    connection.socket.write(hello + pings);

    await expect(connection.next()).resolves.toMatchObject({ type: "hello_ack", requestId: "hello-pipeline" });
    await expect(connection.next()).resolves.toMatchObject({ type: "pong", requestId: "ping-0" });
    for (let index = 1; index < 4_000; index += 1) await connection.next();
    expect(connection.socket.destroyed).toBe(false);
  });

  it("closes a connection when queued complete frames exceed the input budget", async () => {
    let releaseList: (() => void) | undefined;
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-queue-"));
    directories.push(directory);
    const server = new DaemonServer({
      registry: new MissionRegistry({
        list: () => new Promise((resolve) => { releaseList = () => resolve([]); }),
        get: async () => null,
      }),
      tokenPath: join(directory, "daemon.token"),
    });
    servers.push(server);
    const endpoint = await server.start();
    const token = await import("node:fs/promises").then(({ readFile }) => readFile(endpoint.tokenPath, "utf8"));
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "list_missions", version: "mission-control.v1", requestId: "blocked-list" });
    const flood = Array.from({ length: 12_000 }, (_, index) => encodeMessage({ type: "ping" as const, version: "mission-control.v1" as const, requestId: `queued-${index}` })).join("");

    connection.socket.write(flood);

    connection.socket.once("error", () => undefined);
    await new Promise<void>((resolve) => connection.socket.once("close", () => resolve()));
    releaseList?.();
  });

  it("returns immutable registry snapshots and a correlated not-found error", async () => {
    const repositoryMission = structuredClone(mission);
    const registry = new MissionRegistry({ list: async () => [repositoryMission], get: async () => repositoryMission });
    const listed = await registry.list();
    const loaded = await registry.get(mission.id);
    repositoryMission.title = "mutated after read";

    expect(listed[0]?.title).toBe("Secure local daemon");
    expect(loaded?.title).toBe("Secure local daemon");

    const { endpoint, token } = await start();
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "get_mission", version: "mission-control.v1", requestId: "missing", missionId: "missing" });
    await expect(connection.next()).resolves.toMatchObject({ type: "error", requestId: "missing", code: "mission_not_found" });
  });

  it("closes connections that exceed the line buffer limit or remain idle", async () => {
    const { endpoint } = await start({ idleTimeoutMs: 30 });
    const oversized = await open(endpoint.port);
    oversized.socket.write("x".repeat(MAX_LINE_BYTES + 1));
    await once(oversized.socket, "close");

    const idle = await open(endpoint.port);
    await once(idle.socket, "close");
  });

  it("fans out sequence-ordered mission events and stops after unsubscribe", async () => {
    const eventSource = new TestEventSource();
    const { endpoint, token } = await start({ eventSource });
    const first = await open(endpoint.port);
    const second = await open(endpoint.port);
    await authenticate(first, token, "hello-first");
    await authenticate(second, token, "hello-second");
    first.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "sub-first", subscriptionId: "subscription-first", missionId: mission.id, afterSequence: 1 });
    second.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "sub-second", subscriptionId: "subscription-second", missionId: mission.id });
    await expect(first.next()).resolves.toMatchObject({ type: "subscribed", requestId: "sub-first", subscriptionId: "subscription-first", replay: "live_only" });
    await expect(second.next()).resolves.toMatchObject({ type: "subscribed", requestId: "sub-second", subscriptionId: "subscription-second", replay: "live_only" });

    eventSource.emit(event(2));
    eventSource.emit(event(2));
    eventSource.emit(event(1));
    eventSource.emit(event(3));

    await expect(first.next()).resolves.toMatchObject({ type: "mission_event", requestId: "sub-first", event: { sequence: 2 } });
    await expect(first.next()).resolves.toMatchObject({ type: "mission_event", requestId: "sub-first", event: { sequence: 3 } });
    await expect(second.next()).resolves.toMatchObject({ type: "mission_event", requestId: "sub-second", event: { sequence: 2 } });
    await expect(second.next()).resolves.toMatchObject({ type: "mission_event", requestId: "sub-second", event: { sequence: 3 } });

    first.send({ type: "unsubscribe_mission_events", version: "mission-control.v1", requestId: "unsub-first", subscriptionId: "subscription-first" });
    await expect(first.next()).resolves.toMatchObject({ type: "unsubscribed", requestId: "unsub-first" });
    eventSource.emit(event(4));
    await expect(second.next()).resolves.toMatchObject({ type: "mission_event", event: { sequence: 4 } });
  });

  it("acknowledges a subscription before delivering synchronously emitted events", async () => {
    const { endpoint, token } = await start({ eventSource: new SynchronousEventSource() });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);

    connection.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "sub-sync", subscriptionId: "subscription-sync", missionId: mission.id });

    await expect(connection.next()).resolves.toMatchObject({ type: "subscribed", subscriptionId: "subscription-sync" });
    await expect(connection.next()).resolves.toMatchObject({ type: "mission_event", subscriptionId: "subscription-sync", event: { sequence: 1 } });
  });

  it("tears down active sockets, subscriptions, and its token file on stop", async () => {
    const eventSource = new TestEventSource();
    const { server, endpoint, token } = await start({ eventSource });
    const connection = await open(endpoint.port);
    await authenticate(connection, token);
    connection.send({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "sub-stop", subscriptionId: "subscription-stop", missionId: mission.id });
    await connection.next();
    const closed = once(connection.socket, "close");

    await server.stop();

    await closed;
    await expect(access(endpoint.tokenPath)).rejects.toThrow();
    await expect(open(endpoint.port)).rejects.toThrow();
  });
});
