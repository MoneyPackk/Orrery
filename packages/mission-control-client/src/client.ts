import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import {
  PROTOCOL_VERSION,
  decodeMessage,
  type ClientRequest,
  type ClientMutationRequest,
  type MissionListItem,
  type ServerMutationResponse,
  type ServerResponse,
} from "@orrery/mission-control-protocol";
import type { LineTransport, TransportEndpoint } from "./transport";

export type Unsubscribe = () => Promise<void>;
export type EventListener = (event: MissionEvent) => void;
export type SubscriptionState =
  | { status: "live" }
  | { status: "lost_history"; fromSequence: number; throughSequence: number; cursor: number; highWaterMark: number }
  | { status: "gap"; expectedSequence: number; receivedSequence: number }
  | { status: "invalid"; expectedSequence: number; receivedSequence: number; reason: "timeout" | "buffer_limit" };
export type SubscriptionStateListener = (state: SubscriptionState) => void;

export interface MissionControlClientOptions {
  maxBufferedEvents?: number;
  gapTimeoutMs?: number;
}

type RequestInput<T extends ClientRequest["type"]> = Omit<Extract<ClientRequest, { type: T }>, "type" | "version" | "requestId">;
type MutationResult<T extends ServerMutationResponse["type"]> = Omit<Extract<ServerMutationResponse, { type: T }>, "type" | "version" | "requestId">;

export type ProposeRepositoryInput = RequestInput<"propose_repository">;
export type ApproveRepositoryInput = RequestInput<"approve_repository">;
export type CreateMissionInput = RequestInput<"create_mission">;
export type RunMissionInput = RequestInput<"run_mission">;
export type CancelMissionInput = RequestInput<"cancel_mission">;
export type InspectMissionInput = RequestInput<"inspect_mission">;
export type PromoteMissionInput = RequestInput<"promote_mission">;

export class MissionControlError extends Error {
  readonly name = "MissionControlError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type ResponseType = Exclude<ServerResponse["type"], "mission_event" | "error">;
type ResponseOf<T extends ResponseType> = Extract<ServerResponse, { type: T }>;
type Pending = {
  expected: ResponseType;
  resolve: (value: ServerResponse) => void;
  reject: (error: Error) => void;
};
type Subscription = {
  missionId: string;
  requestId: string;
  listener: EventListener;
  lastSequence: number;
  buffered: Map<number, MissionEvent>;
  state: SubscriptionState;
  stateListener?: SubscriptionStateListener;
  gapTimer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_MAX_BUFFERED_EVENTS = 100;
const DEFAULT_GAP_TIMEOUT_MS = 1_000;

const SERVER_RESPONSE_TYPES = new Set<ServerResponse["type"]>([
  "hello_ack",
  "mission_list",
  "mission_snapshot",
  "mission_event",
  "subscribed",
  "unsubscribed",
  "pong",
  "repository_proposal",
  "repository_approved",
  "mission_created",
  "mission_run_accepted",
  "mission_cancelled",
  "mission_inspection",
  "mission_promotion",
  "error",
]);

export class MissionControlClient {
  private state: "disconnected" | "connecting" | "connected" = "disconnected";
  private nextRequestId = 1;
  private nextSubscriptionId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  private removeMessageListener: (() => void) | undefined;
  private removeCloseListener: (() => void) | undefined;

  private readonly maxBufferedEvents: number;
  private readonly gapTimeoutMs: number;

  constructor(private readonly transport: LineTransport, options: MissionControlClientOptions = {}) {
    this.maxBufferedEvents = Math.max(1, options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS);
    this.gapTimeoutMs = Math.max(1, options.gapTimeoutMs ?? DEFAULT_GAP_TIMEOUT_MS);
  }

  async connect(endpoint: TransportEndpoint, token: string): Promise<void> {
    if (this.state !== "disconnected") throw new Error("Client is already connected or connecting.");
    if (endpoint.version !== PROTOCOL_VERSION) throw new Error(`Unsupported endpoint protocol version: ${endpoint.version}.`);
    this.state = "connecting";
    try {
      await this.transport.connect(endpoint);
      this.removeMessageListener = this.transport.onMessage((message) => this.receive(message));
      this.removeCloseListener = this.transport.onClose((error) => this.handleClose(error));
      await this.request({ type: "hello", version: PROTOCOL_VERSION, requestId: this.id(), token }, "hello_ack");
      this.state = "connected";
    } catch (error) {
      await this.teardown(asError(error));
      throw error;
    }
  }

  async listMissions(): Promise<ReadonlyArray<MissionListItem>> {
    const response = await this.request({ type: "list_missions", version: PROTOCOL_VERSION, requestId: this.id() }, "mission_list");
    return response.missions;
  }

  async getMission(id: string): Promise<Mission> {
    const response = await this.request({ type: "get_mission", version: PROTOCOL_VERSION, requestId: this.id(), missionId: id }, "mission_snapshot");
    return response.mission;
  }

  async proposeRepository(input: ProposeRepositoryInput): Promise<MutationResult<"repository_proposal">> {
    const response = await this.mutation("propose_repository", input, "repository_proposal");
    return responseBody(response);
  }

  async approveRepository(input: ApproveRepositoryInput): Promise<MutationResult<"repository_approved">> {
    const response = await this.mutation("approve_repository", input, "repository_approved");
    if (response.fingerprint !== input.fingerprint) throw responseMismatch("repository approval");
    return responseBody(response);
  }

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const response = await this.mutation("create_mission", input, "mission_created");
    if (response.mission.title !== input.title || response.mission.goal !== input.goal || response.mission.mode !== input.mode || response.mission.plan.scope !== input.plan.scope || JSON.stringify(response.mission.plan.actions) !== JSON.stringify(input.plan.actions) || JSON.stringify(response.mission.plan.acceptanceCriteria) !== JSON.stringify(input.plan.acceptanceCriteria)) throw responseMismatch("mission creation");
    return response.mission;
  }

  async runMission(input: RunMissionInput): Promise<MutationResult<"mission_run_accepted">> {
    const response = await this.mutation("run_mission", input, "mission_run_accepted");
    if (response.mission.id !== input.missionId || response.mission.plan.id !== input.planRevisionId) throw responseMismatch("mission run");
    return responseBody(response);
  }

  async cancelMission(input: CancelMissionInput): Promise<MutationResult<"mission_cancelled">> {
    const response = await this.mutation("cancel_mission", input, "mission_cancelled");
    if (response.mission.id !== input.missionId || response.runId !== input.runId) throw responseMismatch("mission cancellation");
    return responseBody(response);
  }

  async inspectMission(input: InspectMissionInput): Promise<MutationResult<"mission_inspection">> {
    const response = await this.mutation("inspect_mission", input, "mission_inspection");
    if (response.mission.id !== input.missionId || response.planRevisionId !== input.planRevisionId || response.mission.plan.id !== input.planRevisionId || !response.changeRevision || !response.contentDigest) throw responseMismatch("mission inspection");
    return responseBody(response);
  }

  async promoteMission(input: PromoteMissionInput): Promise<MutationResult<"mission_promotion">> {
    const response = await this.mutation("promote_mission", input, "mission_promotion");
    if (response.mission.id !== input.missionId || response.planRevisionId !== input.planRevisionId || response.changeRevision !== input.changeRevision || response.decision !== input.decision) throw responseMismatch("mission promotion");
    return responseBody(response);
  }

  async subscribe(id: string, listener: EventListener, stateListener?: SubscriptionStateListener, afterSequence = 0): Promise<Unsubscribe> {
    const requestId = this.id();
    const subscriptionId = `subscription-${this.nextSubscriptionId++}`;
    const subscription: Subscription = { missionId: id, requestId, listener, lastSequence: afterSequence, buffered: new Map(), state: { status: "live" }, stateListener };
    this.subscriptions.set(subscriptionId, subscription);
    try {
      const response = await this.request({
        type: "subscribe_mission_events",
        version: PROTOCOL_VERSION,
        requestId,
        subscriptionId,
        missionId: id,
        ...(afterSequence > 0 ? { afterSequence } : {}),
      }, "subscribed");
      if (response.subscriptionId !== subscriptionId || response.missionId !== id || response.afterSequence !== afterSequence) {
        throw new Error("Subscription acknowledgement does not match the request.");
      }
      if (response.replay !== "durable") throw new Error("Daemon did not acknowledge durable replay.");
    } catch (error) {
      this.subscriptions.delete(subscriptionId);
      throw error;
    }

    let active = true;
    return async () => {
      if (!active) return;
      const response = await this.request({
        type: "unsubscribe_mission_events",
        version: PROTOCOL_VERSION,
        requestId: this.id(),
        subscriptionId,
      }, "unsubscribed");
      if (response.subscriptionId !== subscriptionId) throw new Error("Unsubscribe acknowledgement does not match the request.");
      active = false;
      this.clearGapTimer(subscription);
      this.subscriptions.delete(subscriptionId);
    };
  }

  getSubscriptionState(missionId: string): SubscriptionState | undefined {
    let state: SubscriptionState | undefined;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.missionId === missionId) state = subscription.state;
    }
    return state;
  }

  async disconnect(): Promise<void> {
    if (this.state === "disconnected") return;
    await this.teardown(new Error("Client disconnected."));
  }

  private id(): string {
    return `request-${this.nextRequestId++}`;
  }

  private mutation<TRequest extends ClientMutationRequest["type"], TResponse extends ResponseType>(
    type: TRequest,
    input: RequestInput<TRequest>,
    expected: TResponse,
  ): Promise<ResponseOf<TResponse>> {
    return this.request({ type, version: PROTOCOL_VERSION, requestId: this.id(), ...input } as Extract<ClientMutationRequest, { type: TRequest }>, expected);
  }

  private request<T extends ResponseType>(message: ClientRequest, expected: T): Promise<ResponseOf<T>> {
    if (this.state === "disconnected" || (this.state === "connecting" && message.type !== "hello")) {
      return Promise.reject(new Error("Client is not connected."));
    }
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      this.pending.set(message.requestId, {
        expected,
        resolve: (response) => resolve(response as ResponseOf<T>),
        reject,
      });
      void this.transport.send(message).catch((error: unknown) => {
        this.pending.delete(message.requestId);
        reject(asError(error));
      });
    });
  }

  private receive(raw: unknown): void {
    let response: ServerResponse;
    try {
      const decoded = decodeMessage(JSON.stringify(raw));
      if (!SERVER_RESPONSE_TYPES.has(decoded.type as ServerResponse["type"])) throw new Error(`Unexpected client message type: ${decoded.type}.`);
      response = decoded as ServerResponse;
    } catch (error) {
      void this.teardown(asError(error));
      return;
    }

    if (response.type === "mission_event") {
      this.receiveEvent(response);
      return;
    }

    const pending = this.pending.get(response.requestId);
    if (!pending) {
      void this.teardown(new Error(`Unexpected response request ID: ${response.requestId}`));
      return;
    }
    this.pending.delete(response.requestId);

    if (response.type === "error") {
      pending.reject(new MissionControlError(response.code, response.message));
      return;
    }
    if (response.type !== pending.expected) {
      pending.reject(new Error(`Expected ${pending.expected} response, received ${response.type}.`));
      return;
    }
    if (response.type === "subscribed") {
      const subscription = this.subscriptions.get(response.subscriptionId);
      if (!subscription || subscription.requestId !== response.requestId || subscription.missionId !== response.missionId) {
        pending.reject(new Error("Subscription acknowledgement does not match the request."));
        return;
      }
      if (response.overflow) {
        subscription.lastSequence = response.overflow.firstAvailableSequence - 1;
        this.setSubscriptionState(subscription, {
          status: "lost_history",
          fromSequence: response.afterSequence + 1,
          throughSequence: response.overflow.firstAvailableSequence - 1,
          cursor: subscription.lastSequence,
          highWaterMark: response.highWaterMark ?? response.cursor ?? subscription.lastSequence,
        });
      } else {
        subscription.lastSequence = response.afterSequence;
      }
    }
    pending.resolve(response);
  }

  private receiveEvent(response: Extract<ServerResponse, { type: "mission_event" }>): void {
    const subscription = this.subscriptions.get(response.subscriptionId);
    if (!subscription || response.requestId !== subscription.requestId || response.event.missionId !== subscription.missionId) return;
    if (subscription.state.status === "invalid") return;
    if (response.event.sequence <= subscription.lastSequence || subscription.buffered.has(response.event.sequence)) return;
    subscription.buffered.set(response.event.sequence, response.event);
    if (response.event.sequence > subscription.lastSequence + 1 && (subscription.state.status === "live" || subscription.state.status === "lost_history")) {
      const state: SubscriptionState = {
        status: "gap",
        expectedSequence: subscription.lastSequence + 1,
        receivedSequence: response.event.sequence,
      };
      this.setSubscriptionState(subscription, state);
      subscription.gapTimer = setTimeout(() => this.invalidateSubscription(subscription, "timeout"), this.gapTimeoutMs);
    }
    if (subscription.buffered.size >= this.maxBufferedEvents && subscription.state.status === "gap") {
      this.invalidateSubscription(subscription, "buffer_limit");
      return;
    }
    let next = subscription.buffered.get(subscription.lastSequence + 1);
    while (next) {
      subscription.buffered.delete(next.sequence);
      subscription.lastSequence = next.sequence;
      subscription.listener(next);
      if (subscription.state.status === "lost_history") {
        this.setSubscriptionState(subscription, { ...subscription.state, cursor: next.sequence, highWaterMark: Math.max(subscription.state.highWaterMark, next.sequence) });
      }
      next = subscription.buffered.get(subscription.lastSequence + 1);
    }
    if (subscription.state.status === "gap" && subscription.buffered.size === 0) {
      this.clearGapTimer(subscription);
      this.setSubscriptionState(subscription, { status: "live" });
    }
  }

  private invalidateSubscription(subscription: Subscription, reason: "timeout" | "buffer_limit"): void {
    if (subscription.state.status !== "gap") return;
    const { expectedSequence, receivedSequence } = subscription.state;
    this.clearGapTimer(subscription);
    subscription.buffered.clear();
    this.setSubscriptionState(subscription, { status: "invalid", expectedSequence, receivedSequence, reason });
  }

  private setSubscriptionState(subscription: Subscription, state: SubscriptionState): void {
    subscription.state = state;
    subscription.stateListener?.(state);
  }

  private clearGapTimer(subscription: Subscription): void {
    if (subscription.gapTimer) clearTimeout(subscription.gapTimer);
    subscription.gapTimer = undefined;
  }

  private handleClose(error?: Error): void {
    void this.teardown(error ?? new Error("Transport disconnected."), false);
  }

  private async teardown(error: Error, disconnectTransport = true): Promise<void> {
    this.state = "disconnected";
    this.removeMessageListener?.();
    this.removeCloseListener?.();
    this.removeMessageListener = undefined;
    this.removeCloseListener = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const subscription of this.subscriptions.values()) this.clearGapTimer(subscription);
    this.subscriptions.clear();
    if (disconnectTransport) await this.transport.disconnect();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function responseBody<T extends ServerMutationResponse>(response: T): Omit<T, "type" | "version" | "requestId"> {
  const { type: _type, version: _version, requestId: _requestId, ...body } = response;
  return body;
}

function responseMismatch(operation: string): Error {
  return new Error(`The ${operation} response does not match the request.`);
}
