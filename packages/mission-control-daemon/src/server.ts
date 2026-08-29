import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import {
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ClientRequest,
  type ServerResponse,
} from "@orrery/mission-control-protocol";
import { createDaemonTokenFile, verifyDaemonToken } from "./auth";
import type { ApprovedRepository, MissionEventRecord, MissionInspectionResult, MissionPromotionResult, MissionSnapshot, RepositoryProposalResult } from "./authority-types";
import type { CancelMissionAuthorityInput, CreateMissionAuthorityInput, InspectMissionAuthorityInput, PromoteMissionAuthorityInput, RunMissionAuthorityInput } from "./authority-types";
import type { MissionRegistry } from "./mission-registry";
import { publicMission } from "./public-mission";
import { reviewContent } from "./review-content";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTBOUND_BYTES = 1024 * 1024;
const MAX_PENDING_SUBSCRIPTION_EVENTS = 256;
const MAX_REQUEST_IDS_PER_CONNECTION = 4_096;

export interface DaemonEndpoint {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly version: typeof PROTOCOL_VERSION;
  readonly tokenPath: string;
}

export interface MissionEventSource {
  subscribe(missionId: string, listener: (event: MissionEvent) => void): (() => void) | { unsubscribe(): void };
  highWaterMark?(missionId: string): Promise<number>;
  readAfter?(missionId: string, sequence: number, throughSequence?: number): Promise<readonly (MissionEvent | MissionEventRecord)[] | { events: readonly (MissionEvent | MissionEventRecord)[]; cursor: number; highWaterMark: number; overflow?: { firstAvailableSequence: number } }>;
}

export interface DaemonMissionAuthority {
  proposeRepository?(input: { intentId: string; localPath: string }): Promise<RepositoryProposalResult>;
  approveRepository?(input: { intentId: string; proposalId: string; fingerprint: string; approvalNonce: string }): Promise<ApprovedRepository>;
  create(input: CreateMissionAuthorityInput): Promise<MissionSnapshot>;
  run(input: RunMissionAuthorityInput): Promise<{ mission: Mission; runId: string }>;
  cancel(input: CancelMissionAuthorityInput): Promise<MissionSnapshot>;
  inspect(input: InspectMissionAuthorityInput): Promise<MissionInspectionResult>;
  promote(input: PromoteMissionAuthorityInput): Promise<MissionPromotionResult>;
}

export interface DaemonServerOptions {
  registry: MissionRegistry;
  tokenPath: string;
  authority?: DaemonMissionAuthority;
  eventSource?: MissionEventSource;
  recoverOnStartup?: () => Promise<void>;
  host?: "127.0.0.1" | "::1" | string;
  idleTimeoutMs?: number;
}

interface Subscription {
  subscriptionId: string;
  missionId: string;
  requestId: string;
  lastSequence: number;
  unsubscribe: () => void;
}

interface ConnectionState {
  authenticated: boolean;
  buffer: string;
  queuedBytes: number;
  processing: Promise<void>;
  subscriptions: Map<string, Subscription>;
  requestIds: Set<string>;
  output: string[];
  outputBytes: number;
  writing: boolean;
}

function isClientRequest(message: { type: string }): message is ClientRequest {
  return [
    "hello",
    "list_missions",
    "get_mission",
    "subscribe_mission_events",
    "unsubscribe_mission_events",
    "ping",
    "propose_repository",
    "approve_repository",
    "create_mission",
    "run_mission",
    "cancel_mission",
    "inspect_mission",
    "promote_mission",
  ].includes(message.type);
}

export class DaemonServer {
  private server: Server | null = null;
  private token: string | null = null;
  private endpoint: DaemonEndpoint | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: DaemonServerOptions) {}

  async start(): Promise<DaemonEndpoint> {
    if (this.endpoint) return this.endpoint;
    const host = this.options.host ?? DEFAULT_HOST;
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Daemon must bind to a numeric loopback host.");
    }

    this.token = await createDaemonTokenFile(this.options.tokenPath);
    try {
      await this.options.recoverOnStartup?.();
    } catch (error) {
      this.token = null;
      await rm(this.options.tokenPath, { force: true });
      throw error;
    }
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host, port: 0, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Daemon did not receive a TCP address.");
      this.endpoint = Object.freeze({ host, port: address.port, version: PROTOCOL_VERSION, tokenPath: this.options.tokenPath });
      return this.endpoint;
    } catch (error) {
      server.close();
      this.server = null;
      this.token = null;
      await rm(this.options.tokenPath, { force: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    this.token = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await rm(this.options.tokenPath, { force: true });
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    const state: ConnectionState = { authenticated: false, buffer: "", queuedBytes: 0, processing: Promise.resolve(), subscriptions: new Map(), requestIds: new Set(), output: [], outputBytes: 0, writing: false };
    const cleanup = () => {
      for (const subscription of state.subscriptions.values()) subscription.unsubscribe();
      state.subscriptions.clear();
      this.sockets.delete(socket);
      this.states.delete(socket);
    };
    this.states.set(socket, state);
    socket.once("close", cleanup);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      state.buffer += chunk;
      let newline = state.buffer.indexOf("\n");
      while (newline >= 0 && !socket.destroyed) {
        const line = state.buffer.slice(0, newline + 1);
        state.buffer = state.buffer.slice(newline + 1);
        const lineBytes = Buffer.byteLength(line, "utf8");
        state.queuedBytes += lineBytes;
        if (state.queuedBytes > MAX_LINE_BYTES) {
          socket.destroy();
          return;
        }
        state.processing = state.processing
          .then(() => this.handleLine(socket, state, line))
          .finally(() => { state.queuedBytes -= lineBytes; });
        newline = state.buffer.indexOf("\n");
      }
      if (Buffer.byteLength(state.buffer, "utf8") > MAX_LINE_BYTES) socket.destroy();
    });
  }

  private async handleLine(socket: Socket, state: ConnectionState, line: string): Promise<void> {
    let message: ReturnType<typeof decodeMessage>;
    try {
      message = decodeMessage(line);
    } catch {
      socket.destroy();
      return;
    }
    if (!isClientRequest(message)) {
      this.sendError(socket, message.requestId, "invalid_request", "Only client requests are accepted.");
      return;
    }
    if (state.requestIds.has(message.requestId)) {
      this.sendError(socket, message.requestId, "duplicate_request_id", "Request IDs must be unique per connection.");
      return;
    }
    if (state.requestIds.size >= MAX_REQUEST_IDS_PER_CONNECTION) {
      this.sendError(socket, message.requestId, "request_id_history_exhausted", "Request ID history is full; reconnect before sending more requests.");
      socket.end();
      return;
    }
    state.requestIds.add(message.requestId);
    if (!state.authenticated) {
      if (message.type !== "hello") {
        this.sendError(socket, message.requestId, "authentication_required", "Authenticate with hello before sending requests.");
        socket.end();
        return;
      }
      if (this.token === null || !verifyDaemonToken(message.token, this.token)) {
        this.sendError(socket, message.requestId, "authentication_failed", "Invalid daemon capability token.");
        socket.end();
        return;
      }
      state.authenticated = true;
      this.send(socket, { type: "hello_ack", version: PROTOCOL_VERSION, requestId: message.requestId });
      return;
    }

    if (message.type === "hello") {
      this.sendError(socket, message.requestId, "already_authenticated", "The connection is already authenticated.");
      return;
    }

    try {
      await this.dispatch(socket, state, message);
    } catch (error) {
      const code = error instanceof AuthorityError ? error.code : stableErrorCode(error);
      this.sendError(socket, message.requestId, code, stableErrorMessage(code));
    }
  }

  private async dispatch(socket: Socket, state: ConnectionState, message: Exclude<ClientRequest, { type: "hello" }>): Promise<void> {
    switch (message.type) {
      case "list_missions":
        this.send(socket, { type: "mission_list", version: PROTOCOL_VERSION, requestId: message.requestId, missions: await this.options.registry.list() });
        return;
      case "get_mission": {
        const mission = await this.options.registry.get(message.missionId);
        if (mission === null) this.sendError(socket, message.requestId, "mission_not_found", "Mission not found.");
        else this.send(socket, { type: "mission_snapshot", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(mission as MissionSnapshot) });
        return;
      }
      case "ping":
        this.send(socket, { type: "pong", version: PROTOCOL_VERSION, requestId: message.requestId });
        return;
      case "propose_repository": {
        const result = await (this.options.authority?.proposeRepository
          ? this.options.authority.proposeRepository({ intentId: message.intentId, localPath: message.localPath })
          : this.options.registry.propose(message.localPath));
        if (!result) throw new AuthorityError("authority_unavailable");
        const { gitIdentity: _gitIdentity, payloadVersion: _payloadVersion, ...proposal } = result;
        this.send(socket, { type: "repository_proposal", version: PROTOCOL_VERSION, requestId: message.requestId, ...proposal });
        return;
      }
      case "approve_repository": {
        const result = await (this.options.authority?.approveRepository
          ? this.options.authority.approveRepository({ intentId: message.intentId, proposalId: message.proposalId, fingerprint: message.fingerprint, approvalNonce: message.approvalNonce })
          : this.options.registry.approve({ proposalId: message.proposalId, fingerprint: message.fingerprint, approvalNonce: message.approvalNonce }));
        if (!result) throw new AuthorityError("authority_unavailable");
        this.send(socket, { type: "repository_approved", version: PROTOCOL_VERSION, requestId: message.requestId, repositoryId: result.repositoryId, fingerprint: result.fingerprint });
        return;
      }
      case "create_mission": {
        const mission = await this.requireAuthority().create({ ...message, plan: { ...message.plan, actions: [...message.plan.actions], acceptanceCriteria: [...message.plan.acceptanceCriteria] } });
        this.send(socket, { type: "mission_created", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(mission) });
        return;
      }
      case "run_mission": {
        const result = await this.requireAuthority().run(message);
         this.send(socket, { type: "mission_run_accepted", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(result.mission as MissionSnapshot), runId: result.runId });
        return;
      }
      case "cancel_mission": {
        const mission = await this.requireAuthority().cancel(message);
        this.send(socket, { type: "mission_cancelled", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(mission), runId: message.runId });
        return;
      }
      case "inspect_mission": {
        const result = await this.requireAuthority().inspect(message);
        this.send(socket, { type: "mission_inspection", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(result.mission), planRevisionId: result.planRevisionId, changeRevision: result.changeSnapshot.revision, ...reviewContent(result) });
        return;
      }
      case "promote_mission": {
        const result = await this.requireAuthority().promote(message);
        const promotionResult = result.result.status === "promoted" ? "promoted" : result.result.status === "rejected" ? "rejected" : "conflict";
        this.send(socket, { type: "mission_promotion", version: PROTOCOL_VERSION, requestId: message.requestId, mission: publicMission(result.mission), planRevisionId: message.planRevisionId, changeRevision: message.changeRevision, decision: message.decision, reviewerId: result.reviewerId, result: promotionResult });
        return;
      }
      case "subscribe_mission_events":
        await this.subscribe(socket, state, message);
        return;
      case "unsubscribe_mission_events": {
        state.subscriptions.get(message.subscriptionId)?.unsubscribe();
        state.subscriptions.delete(message.subscriptionId);
        this.send(socket, { type: "unsubscribed", version: PROTOCOL_VERSION, requestId: message.requestId, subscriptionId: message.subscriptionId });
      }
    }
  }

  private async subscribe(socket: Socket, state: ConnectionState, message: Extract<ClientRequest, { type: "subscribe_mission_events" }>): Promise<void> {
    if (await this.options.registry.get(message.missionId) === null) {
      this.sendError(socket, message.requestId, "mission_not_found", "Mission not found.");
      return;
    }
    const previous = state.subscriptions.get(message.subscriptionId);
    previous?.unsubscribe();
    const subscription: Subscription = {
      subscriptionId: message.subscriptionId,
      missionId: message.missionId,
      requestId: message.requestId,
      lastSequence: message.afterSequence ?? 0,
      unsubscribe: () => undefined,
    };
    const pendingEvents: MissionEvent[] = [];
    let acknowledged = false;
    const deliver = (event: MissionEvent) => {
      if (event.missionId !== message.missionId || event.sequence <= subscription.lastSequence) return;
      subscription.lastSequence = event.sequence;
      this.send(socket, { type: "mission_event", version: PROTOCOL_VERSION, requestId: subscription.requestId, subscriptionId: subscription.subscriptionId, event: this.publicEvent(event) });
    };
    if (this.options.eventSource) {
      const eventSubscription = this.options.eventSource.subscribe(message.missionId, (event) => {
        if (acknowledged) deliver(event);
        else if (pendingEvents.length < MAX_PENDING_SUBSCRIPTION_EVENTS) pendingEvents.push(structuredClone(event));
        else socket.destroy();
      });
      subscription.unsubscribe = typeof eventSubscription === "function" ? eventSubscription : () => eventSubscription.unsubscribe();
    }
    state.subscriptions.set(message.subscriptionId, subscription);
    const readAfter = this.options.eventSource?.readAfter;
    const highWaterMark = this.options.eventSource?.highWaterMark ? await this.options.eventSource.highWaterMark(message.missionId) : undefined;
    const replayResult = readAfter ? await readAfter.call(this.options.eventSource, message.missionId, message.afterSequence ?? 0, highWaterMark) : [];
    const structured = isEventReplay(replayResult) ? replayResult : undefined;
    const replay = structured?.events ?? replayResult as readonly (MissionEvent | MissionEventRecord)[];
    const expectedSequence = message.afterSequence ?? 0;
    const orderedReplay = replay.slice().sort((a, b) => a.sequence - b.sequence);
    if (!structured?.overflow && orderedReplay.some((event, index) => event.sequence !== expectedSequence + index + 1)) {
      this.send(socket, { type: "subscribed", version: PROTOCOL_VERSION, requestId: message.requestId, subscriptionId: message.subscriptionId, missionId: message.missionId, afterSequence: message.afterSequence ?? 0, replay: "durable", cursor: orderedReplay.at(-1)?.sequence ?? expectedSequence, highWaterMark: highWaterMark ?? orderedReplay.at(-1)?.sequence ?? expectedSequence, overflow: { firstAvailableSequence: orderedReplay[0]?.sequence ?? expectedSequence + 1 } });
      acknowledged = true;
      return;
    }
    this.send(socket, { type: "subscribed", version: PROTOCOL_VERSION, requestId: message.requestId, subscriptionId: message.subscriptionId, missionId: message.missionId, afterSequence: message.afterSequence ?? 0, replay: readAfter ? "durable" : "live_only", ...(structured ? { cursor: structured.cursor, highWaterMark: structured.highWaterMark, ...(structured.overflow ? { overflow: structured.overflow } : {}) } : {}) });
    acknowledged = true;
    orderedReplay.forEach(deliver);
    pendingEvents.forEach(deliver);
  }

  private requireAuthority(): DaemonMissionAuthority {
    if (!this.options.authority) throw new AuthorityError("authority_unavailable");
    return this.options.authority;
  }

  private publicEvent(event: MissionEvent | MissionEventRecord): MissionEvent {
    const { payloadVersion: _payloadVersion, recordedAt: _recordedAt, ...result } = event as MissionEventRecord;
    return structuredClone(result);
  }

  private send(socket: Socket, response: ServerResponse): void {
    const state = this.findState(socket);
    if (!state || socket.destroyed || !socket.writable) return;
    const encoded = encodeMessage(response);
    if (state.outputBytes + Buffer.byteLength(encoded, "utf8") > MAX_OUTBOUND_BYTES) {
      socket.destroy();
      return;
    }
    state.output.push(encoded);
    state.outputBytes += Buffer.byteLength(encoded, "utf8");
    this.flush(socket, state);
  }

  private readonly states = new Map<Socket, ConnectionState>();

  private findState(socket: Socket): ConnectionState | undefined { return this.states.get(socket); }

  private flush(socket: Socket, state: ConnectionState): void {
    if (state.writing || socket.destroyed || !socket.writable) return;
    const next = state.output.shift();
    if (!next) return;
    state.outputBytes -= Buffer.byteLength(next, "utf8");
    state.writing = true;
    socket.write(next, (error) => {
      state.writing = false;
      if (error) { socket.destroy(); return; }
      this.flush(socket, state);
    });
  }

  private sendError(socket: Socket, requestId: string, code: string, message: string): void {
    this.send(socket, { type: "error", version: PROTOCOL_VERSION, requestId, code, message });
  }
}

function isEventReplay(value: readonly (MissionEvent | MissionEventRecord)[] | { events: readonly (MissionEvent | MissionEventRecord)[] }): value is { events: readonly (MissionEvent | MissionEventRecord)[]; cursor: number; highWaterMark: number; overflow?: { firstAvailableSequence: number } } {
  return !Array.isArray(value) && "events" in value;
}

class AuthorityError extends Error {
  constructor(readonly code: string) { super(code); }
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not found")) return "mission_not_found";
  if (message.includes("revision") || message.includes("fingerprint") || message.includes("stale")) return "stale_revision";
  if (message.includes("active run") || message.includes("cancellation")) return "invalid_run";
  if (message.includes("approved") || message.includes("repository")) return "repository_not_approved";
  return "internal_error";
}

function stableErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    authority_unavailable: "The daemon authority is unavailable.",
    mission_not_found: "Mission not found.",
    stale_revision: "The request does not match the current mission revision.",
    invalid_run: "The requested run is not active.",
    repository_not_approved: "The repository is not approved for this mission.",
    internal_error: "The daemon could not complete the request.",
  };
  return messages[code] ?? messages.internal_error;
}
