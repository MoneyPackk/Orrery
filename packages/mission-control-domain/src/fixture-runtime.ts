import type { CapabilityRequest, Evidence, FileChange, MissionEvent, PlanContent } from "./mission";

type RuntimeBase = { runId: string; missionId: string; sequence: number; event: MissionEvent };

export type RuntimeSignal = RuntimeBase &
  (
    | { type: "event" }
    | { type: "capability_request"; requestId: string; capability: CapabilityRequest }
    | { type: "change"; change: FileChange }
    | { type: "evidence"; evidence: Evidence }
    | { type: "complete"; summary: string }
  );

export interface FixtureRunOptions {
  delay?: number;
  workspaceId?: string;
  plan: PlanContent;
  planRevisionId: string;
}
export interface FixtureRun {
  runId: string;
  signals: AsyncGenerator<RuntimeSignal>;
  cancel: () => void;
}

interface PendingDecision {
  requestId: string;
  resolve: (decision: "allowed" | "denied") => void;
  reject: (error: Error) => void;
}

const pendingDecisions = new Map<string, PendingDecision>();
const newId = () => crypto.randomUUID();

const abortError = () => Object.assign(new Error("Fixture run aborted"), { name: "AbortError" });
const sleep = (ms: number, isCancelled: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    if (isCancelled()) return reject(abortError());
    setTimeout(() => isCancelled() ? reject(abortError()) : resolve(), ms);
  });

export function resolveFixtureCapability(
  runId: string,
  requestId: string,
  decision: "allowed" | "denied",
) {
  const pending = pendingDecisions.get(runId);
  if (!pending || pending.requestId !== requestId) {
    throw new Error(`No matching pending capability request for ${runId}.`);
  }
  pendingDecisions.delete(runId);
  pending.resolve(decision);
}

export function createFixtureRun(missionId: string, options: FixtureRunOptions): FixtureRun {
  const runId = newId();
  let cancelled = false;
  const delay = options.delay ?? 45;
  const workspaceId = options.workspaceId ?? `fixture-workspace-${newId()}`;
  const plan = structuredClone(options.plan);
  const planRevisionId = options.planRevisionId;
  let sequence = 0;
  let rejectPending: (() => void) | undefined;

  const makeEvent = (kind: MissionEvent["kind"], title: string, detail: string, capability?: CapabilityRequest) => {
    const current = ++sequence;
    const event: MissionEvent = {
      id: newId(),
      missionId,
      runId,
      sequence: current,
      timestamp: new Date().toISOString(),
      kind,
      title,
      detail,
      capability,
    };
    return { runId, missionId, sequence: current, event };
  };

  async function* generate(): AsyncGenerator<RuntimeSignal> {
    const emitEvent = async (kind: MissionEvent["kind"], title: string, detail: string) => {
      await sleep(delay, () => cancelled);
      return { ...makeEvent(kind, title, detail), type: "event" as const };
    };

    yield await emitEvent("workspace", "Workspace isolated", `.orrery/worktrees/${workspaceId}`);
    yield await emitEvent("context", "Context indexed", `Read 14 project files within approved scope: ${plan.scope}`);
    for (const [index, action] of plan.actions.entries()) {
      yield await emitEvent("execution", `Action ${index + 1} of ${plan.actions.length}`, action);
    }

    await sleep(delay, () => cancelled);
    const requestId = newId();
    const capability: CapabilityRequest = {
      requestId,
      runId,
      capability: "network",
      scope: "registry.npmjs.org",
      reason: "Check package metadata before using the local fixture fallback.",
    };
    const decisionPromise = new Promise<"allowed" | "denied">((resolve, reject) => {
      pendingDecisions.set(runId, { requestId, resolve, reject });
    });
    rejectPending = () => {
      const pending = pendingDecisions.get(runId);
      if (pending?.requestId === requestId) {
        pendingDecisions.delete(runId);
        pending.reject(abortError());
      }
    };
    if (cancelled) rejectPending();
    yield { ...makeEvent("capability_request", "Network access requested", capability.reason, capability), type: "capability_request", requestId, capability };

    const decision = await decisionPromise;
    yield await emitEvent(
      decision === "allowed" ? "capability_resolution" : "fallback",
      decision === "allowed" ? "Network access allowed" : "Using local fixture",
      decision === "allowed" ? "Allowed once for registry.npmjs.org." : "Network denied; continued without external access.",
    );

    await sleep(delay, () => cancelled);
    const change: FileChange = {
      path: "src/mission-fixture.ts",
      additions: 18,
      deletions: 2,
      diff: "@@ -1,2 +1,18 @@\n-export const status = 'draft'\n+export const status = 'verified'\n+export const source = 'fixture-runtime'",
    };
    yield { ...makeEvent("change", "Change observed", `${change.path}: +${change.additions} -${change.deletions}`), type: "change", change };
    yield await emitEvent("verification", "Verification running", "npm test -- --run");

    await sleep(delay, () => cancelled);
    const evidence: Evidence = {
      id: newId(),
      kind: "test",
      status: "passed",
      summary: "8 fixture checks passed in 420ms",
      criterion: plan.acceptanceCriteria[0],
      planRevisionId,
      timestamp: new Date().toISOString(),
    };
    yield { ...makeEvent("verification", "Evidence passed", evidence.summary), type: "evidence", evidence };

    await sleep(delay, () => cancelled);
    const summary = "Fixture implementation complete. One file changed and verification passed.";
    yield { ...makeEvent("completion", "Run complete", summary), type: "complete", summary };
  }

  return {
    runId,
    signals: generate(),
    cancel: () => {
      cancelled = true;
      rejectPending?.();
    },
  };
}
