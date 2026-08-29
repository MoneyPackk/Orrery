export type MissionMode = "explore" | "plan" | "build" | "delegate";

export type MissionStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "ready_for_review"
  | "revision_requested"
  | "accepted"
  | "rejected"
  | "failed"
  | "cancelled";

export type ReviewDecision = "accepted" | "rejected" | "revision_requested";

export interface PlanContent {
  scope: string;
  actions: string[];
  acceptanceCriteria: string[];
}

export interface PlanRevision extends PlanContent {
  id: string;
  revision: number;
  approved: boolean;
  createdAt: string;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  kind:
    | "workspace"
    | "context"
    | "execution"
    | "capability_request"
    | "capability_resolution"
    | "change"
    | "verification"
     | "completion"
    | "cancellation"
    | "interruption"
    | "fallback"
    | "error";
  title: string;
  detail: string;
  capability?: CapabilityRequest;
}

export interface CapabilityRequest {
  requestId: string;
  runId: string;
  capability: "network" | "dependency" | "secret" | "destructive" | "deployment";
  scope: string;
  reason: string;
  resolved?: "allowed" | "denied" | "interrupted";
}

export interface Evidence {
  id: string;
  kind: "command" | "test" | "diagnostic" | "screenshot" | "log" | "manual";
  status: "passed" | "failed" | "warning" | "informational";
  summary: string;
  criterion?: string;
  planRevisionId: string;
  timestamp: string;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
}

export interface Mission {
  id: string;
  title: string;
  goal: string;
  mode: MissionMode;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  targetBranch: string;
  missionBranch?: string;
  workspaceId?: string;
  plan: PlanRevision;
  events: MissionEvent[];
  changes: FileChange[];
  evidence: Evidence[];
  completionSummary?: string;
  reviewDecision?: ReviewDecision;
  activeRunId?: string;
}

export interface CreateMissionInput {
  title: string;
  goal: string;
  mode: MissionMode;
  plan?: PlanContent;
}

export type MissionAction =
  | { type: "update_plan"; plan: PlanContent }
  | { type: "submit_plan" }
  | { type: "approve_plan" }
  | { type: "start"; workspaceId: string; runId: string }
  | { type: "pause" }
  | { type: "block"; reason: string }
  | { type: "resolve_capability"; runId: string; requestId: string; decision: "allowed" | "denied" }
  | { type: "append_event"; runId: string; event: MissionEvent }
  | { type: "observe_change"; runId: string; change: FileChange }
  | { type: "record_evidence"; runId: string; evidence: Evidence }
  | { type: "complete"; runId: string; summary: string }
  | { type: "request_revision" }
  | { type: "accept" }
  | { type: "reject" }
  | { type: "fail"; runId?: string; reason: string }
  | { type: "cancel"; runId?: string; event?: MissionEvent };

const now = () => new Date().toISOString();

export class MissionTransitionError extends Error {
  constructor(status: MissionStatus, action: MissionAction["type"], reason?: string) {
    super(reason ?? `Cannot ${action} while mission is ${status}.`);
    this.name = "MissionTransitionError";
  }
}

export function createMission(input: CreateMissionInput): Mission {
  if (!input.title.trim() || !input.goal.trim()) {
    throw new Error("Mission title and goal are required.");
  }

  const createdAt = now();
  const id = crypto.randomUUID();
  const plan = input.plan ?? {
    scope: "",
    actions: [""],
    acceptanceCriteria: [""],
  };

  return {
    id,
    title: input.title.trim(),
    goal: input.goal.trim(),
    mode: input.mode,
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    targetBranch: "main",
    plan: {
      ...plan,
      actions: [...plan.actions],
      acceptanceCriteria: [...plan.acceptanceCriteria],
      id: crypto.randomUUID(),
      revision: 1,
      approved: false,
      createdAt,
    },
    events: [],
    changes: [],
    evidence: [],
  };
}

function assertStatus(
  mission: Mission,
  action: MissionAction,
  allowed: MissionStatus[],
) {
  if (!allowed.includes(mission.status)) {
    throw new MissionTransitionError(mission.status, action.type);
  }
}

function update(mission: Mission, patch: Partial<Mission>): Mission {
  return { ...mission, ...patch, updatedAt: now() };
}

function assertActiveRun(mission: Mission, runId: string, action: MissionAction) {
  if (!runId || mission.activeRunId !== runId) {
    throw new MissionTransitionError(mission.status, action.type, "Signal does not belong to the active run.");
  }
}

export function transitionMission(mission: Mission, action: MissionAction): Mission {
  switch (action.type) {
    case "update_plan": {
      assertStatus(mission, action, ["draft", "planning", "revision_requested"]);
      if (mission.mode === "explore") {
        throw new MissionTransitionError(mission.status, action.type, "Explore mode is read-only and cannot edit plans.");
      }
      const revision = mission.plan.revision + 1;
      const resetsReview = mission.status === "revision_requested";
      return update(mission, {
        status: "planning",
        reviewDecision: undefined,
        ...(resetsReview ? {
          changes: [],
          evidence: [],
          completionSummary: undefined,
          workspaceId: undefined,
          missionBranch: undefined,
          activeRunId: undefined,
        } : {}),
        plan: {
          ...action.plan,
          actions: [...action.plan.actions],
          acceptanceCriteria: [...action.plan.acceptanceCriteria],
          id: crypto.randomUUID(),
          revision,
          approved: false,
          createdAt: now(),
        },
      });
    }
    case "submit_plan":
      assertStatus(mission, action, ["draft", "planning", "revision_requested"]);
      return update(mission, { status: "awaiting_approval" });
    case "approve_plan":
      assertStatus(mission, action, ["draft", "planning", "awaiting_approval"]);
      if (
        !mission.plan.scope.trim() ||
        mission.plan.actions.every((item) => !item.trim()) ||
        mission.plan.acceptanceCriteria.every((item) => !item.trim())
      ) {
        throw new MissionTransitionError(
          mission.status,
          action.type,
          "Complete scope, actions, and acceptance criteria before approval.",
        );
      }
      return update(mission, {
        status: "queued",
        plan: { ...mission.plan, approved: true },
      });
    case "start":
      assertStatus(mission, action, ["queued"]);
      if (!mission.plan.approved) {
        throw new MissionTransitionError(mission.status, action.type, "Execution requires an approved plan.");
      }
      if (mission.mode !== "build") {
        throw new MissionTransitionError(mission.status, action.type, "Local fixture execution is not supported for this mode; only build missions can execute it.");
      }
      if (!action.workspaceId.trim()) {
        throw new MissionTransitionError(
          mission.status,
          action.type,
          "A write-capable mission requires an isolated workspace.",
        );
      }
      if (!action.runId.trim()) {
        throw new MissionTransitionError(mission.status, action.type, "A run identifier is required.");
      }
      return update(mission, {
        status: "running",
        workspaceId: action.workspaceId,
        missionBranch: `orrery/${action.workspaceId}`,
        activeRunId: action.runId,
      });
    case "pause":
      assertStatus(mission, action, ["running"]);
      return update(mission, { status: "paused" });
    case "block":
      assertStatus(mission, action, ["running", "paused"]);
      return update(mission, { status: "blocked" });
    case "resolve_capability":
      assertStatus(mission, action, ["running", "paused", "blocked"]);
      assertActiveRun(mission, action.runId, action);
      const pending = mission.events.find(
        (event) =>
          event.kind === "capability_request" &&
          event.capability?.requestId === action.requestId &&
          event.capability.runId === action.runId &&
          !event.capability.resolved,
      );
      if (!pending) {
        throw new MissionTransitionError(mission.status, action.type, "No matching active pending capability request.");
      }
      return update(mission, {
        status: "running",
        events: mission.events.map((event) =>
          event.id === pending.id
            ? {
                ...event,
                capability: { ...pending.capability!, resolved: action.decision },
              }
            : event,
        ),
      });
    case "append_event": {
      assertStatus(mission, action, ["running", "paused", "blocked"]);
      assertActiveRun(mission, action.runId, action);
      if (action.event.missionId !== mission.id) {
        throw new MissionTransitionError(mission.status, action.type, "Event belongs to another mission.");
      }
      if (action.event.runId !== action.runId) {
        throw new MissionTransitionError(mission.status, action.type, "Event belongs to another run.");
      }
      if (mission.events.some((event) => event.id === action.event.id)) {
        throw new MissionTransitionError(mission.status, action.type, "Event id must be unique.");
      }
      const expectedSequence = mission.events.length + 1;
      if (action.event.sequence !== expectedSequence) {
        throw new MissionTransitionError(mission.status, action.type, `Event sequence must be contiguous; expected ${expectedSequence}.`);
      }
      return update(mission, {
        events: [...mission.events, action.event],
        ...(action.event.kind === "capability_request" ? { status: "blocked" as const } : {}),
      });
    }
    case "observe_change":
      assertStatus(mission, action, ["running"]);
      assertActiveRun(mission, action.runId, action);
      return update(mission, { changes: [...mission.changes, action.change] });
    case "record_evidence":
      assertStatus(mission, action, ["running"]);
      assertActiveRun(mission, action.runId, action);
      return update(mission, { evidence: [...mission.evidence, action.evidence] });
    case "complete":
      assertStatus(mission, action, ["running"]);
      assertActiveRun(mission, action.runId, action);
      if (!action.summary.trim()) {
        throw new MissionTransitionError(
          mission.status,
          action.type,
          "Completion requires a non-empty summary.",
        );
      }
      const currentEvidence = mission.evidence.filter(
        (evidence) => evidence.planRevisionId === mission.plan.id,
      );
      if (currentEvidence.length === 0) {
        throw new MissionTransitionError(mission.status, action.type, "Completion requires evidence linked to the current plan.");
      }
      if (!currentEvidence.some((evidence) => evidence.status === "passed" || evidence.status === "warning")) {
        throw new MissionTransitionError(mission.status, action.type, "Completion requires passing evidence or an explicit warning.");
      }
      return update(mission, {
        status: "ready_for_review",
        completionSummary: action.summary.trim(),
        activeRunId: undefined,
      });
    case "request_revision":
      assertStatus(mission, action, ["ready_for_review"]);
      assertReviewReady(mission, action);
      return update(mission, {
        status: "revision_requested",
        reviewDecision: "revision_requested",
        changes: [],
        evidence: [],
        completionSummary: undefined,
        workspaceId: undefined,
        missionBranch: undefined,
        activeRunId: undefined,
      });
    case "accept":
      assertStatus(mission, action, ["ready_for_review"]);
      assertReviewReady(mission, action);
      return update(mission, { status: "accepted", reviewDecision: "accepted" });
    case "reject":
      assertStatus(mission, action, ["ready_for_review"]);
      assertReviewReady(mission, action);
      return update(mission, { status: "rejected", reviewDecision: "rejected" });
    case "fail":
      assertStatus(mission, action, ["queued", "running", "paused", "blocked"]);
      if (action.runId) assertActiveRun(mission, action.runId, action);
      return update(mission, { status: "failed", completionSummary: action.reason, activeRunId: undefined });
    case "cancel":
      assertStatus(mission, action, [
        "draft",
        "planning",
        "awaiting_approval",
        "queued",
        "running",
        "paused",
        "blocked",
      ]);
      if (action.runId) {
        const recoveredRun = mission.status === "blocked" && !mission.activeRunId &&
          mission.events.some((event) => event.kind === "interruption" && event.runId === action.runId);
        if (!recoveredRun) assertActiveRun(mission, action.runId, action);
      }
      if (action.event) {
        if (!action.runId || action.event.missionId !== mission.id || action.event.runId !== action.runId ||
          action.event.kind !== "cancellation" || action.event.sequence !== mission.events.length + 1 ||
          mission.events.some((event) => event.id === action.event!.id)) {
          throw new MissionTransitionError(mission.status, action.type, "Cancellation event is invalid.");
        }
      }
      return update(mission, {
        status: "cancelled",
        activeRunId: undefined,
        events: action.event ? [...mission.events, action.event] : mission.events,
      });
  }
}

function assertReviewReady(mission: Mission, action: MissionAction) {
  const evidence = mission.evidence.filter((item) => item.planRevisionId === mission.plan.id);
  if (!evidence.some((item) => item.status === "passed" || item.status === "warning")) {
    throw new MissionTransitionError(mission.status, action.type, "Review requires current passing evidence or an explicit warning.");
  }
  if (!mission.plan.approved || !mission.completionSummary?.trim()) {
    throw new MissionTransitionError(mission.status, action.type, "Review requires an approved plan and completion summary.");
  }
}
