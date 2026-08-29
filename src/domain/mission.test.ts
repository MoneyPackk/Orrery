import { describe, expect, it } from "vitest";
import {
  createMission,
  MissionTransitionError,
  transitionMission,
} from "./mission";

const input = {
  title: "Build command palette",
  goal: "Add keyboard-first command discovery",
  mode: "build" as const,
  plan: {
    scope: "Implement palette search and activation.",
    actions: ["Index commands", "Render filtered results"],
    acceptanceCriteria: ["Keyboard selection works"],
  },
};

describe("mission domain", () => {
  it.each(["explore", "plan", "delegate"] as const)(
    "rejects fixture execution for %s mode at the domain boundary",
    (mode) => {
      const queued = transitionMission(createMission({ ...input, mode }), { type: "approve_plan" });

      expect(() => transitionMission(queued, {
        type: "start",
        workspaceId: "opaque-workspace",
        runId: "run-01",
      })).toThrow(/not supported|cannot execute|only build/i);
    },
  );

  it("uses opaque UUIDs for mission and plan identities", () => {
    const first = createMission(input);
    const second = createMission(input);

    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.plan.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Set([first.id, second.id, first.plan.id, second.plan.id])).toHaveLength(4);
  });

  it("creates a draft with an immutable first plan revision", () => {
    const mission = createMission(input);

    expect(mission.status).toBe("draft");
    expect(mission.plan.revision).toBe(1);
    expect(mission.plan.approved).toBe(false);
    expect(mission.events).toEqual([]);
  });

  it("moves an approved plan to the queue", () => {
    const planned = transitionMission(createMission(input), {
      type: "update_plan",
      plan: { ...input.plan, scope: "Implement a ranked command palette." },
    });
    const queued = transitionMission(planned, { type: "approve_plan" });

    expect(queued.status).toBe("queued");
    expect(queued.plan.revision).toBe(2);
    expect(queued.plan.approved).toBe(true);
  });

  it("rejects a write-capable start without an isolated workspace", () => {
    const queued = transitionMission(createMission(input), {
      type: "approve_plan",
    });

    expect(() =>
      transitionMission(queued, { type: "start", workspaceId: "", runId: "run-01" }),
    ).toThrow(MissionTransitionError);
  });

  it("rejects starting a queued mission whose plan is not approved", () => {
    const invalidQueued = { ...createMission(input), status: "queued" as const };

    expect(() => transitionMission(invalidQueued, {
      type: "start",
      workspaceId: "opaque-workspace",
      runId: "run-01",
    })).toThrow(/approved plan/i);
  });

  it.each(["explore", "plan", "delegate"] as const)("does not locally execute %s missions", (mode) => {
    const queued = transitionMission(createMission({ ...input, mode }), { type: "approve_plan" });
    expect(() => transitionMission(queued, {
      type: "start",
      workspaceId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    })).toThrow(/build/i);
  });

  it("blocks on a permission request and resumes after either decision", () => {
    for (const decision of ["allowed", "denied"] as const) {
      let mission = transitionMission(createMission(input), { type: "approve_plan" });
      const runId = crypto.randomUUID();
      mission = transitionMission(mission, { type: "start", workspaceId: crypto.randomUUID(), runId });
      const requestId = crypto.randomUUID();
      mission = transitionMission(mission, {
        type: "append_event",
        runId,
        event: {
          id: crypto.randomUUID(), missionId: mission.id, runId, sequence: 1,
          timestamp: new Date().toISOString(), kind: "capability_request", title: "Permission", detail: "Network",
          capability: { requestId, runId, capability: "network", scope: "example.test", reason: "Metadata" },
        },
      });
      expect(mission.status).toBe("blocked");
      mission = transitionMission(mission, { type: "resolve_capability", runId, requestId, decision });
      expect(mission.status).toBe("running");
    }
  });

  it("rejects completion without evidence", () => {
    let mission = transitionMission(createMission(input), {
      type: "approve_plan",
    });
    mission = transitionMission(mission, {
      type: "start",
      workspaceId: "worktree/mission-01",
      runId: "run-01",
    });

    expect(() =>
      transitionMission(mission, {
        type: "complete",
        runId: "run-01",
        summary: "Implemented the palette.",
      }),
    ).toThrow("evidence");
  });

  it("rejects failed-only and stale-plan evidence at completion", () => {
    let mission = transitionMission(createMission(input), { type: "approve_plan" });
    mission = transitionMission(mission, {
      type: "start",
      workspaceId: "worktree/mission-01",
      runId: "run-01",
    });
    mission = transitionMission(mission, {
      type: "record_evidence",
      runId: "run-01",
      evidence: {
        id: "evidence-failed",
        kind: "test",
        status: "failed",
        summary: "1 test failed",
        criterion: "Keyboard selection works",
        planRevisionId: mission.plan.id,
        timestamp: "2026-08-27T10:00:00.000Z",
      },
    });

    expect(() =>
      transitionMission(mission, { type: "complete", runId: "run-01", summary: "Failed." }),
    ).toThrow(/passing evidence|warning/i);

    const stalePlanMission = {
      ...mission,
      evidence: [{ ...mission.evidence[0], status: "passed" as const, planRevisionId: "old-plan" }],
    };
    expect(() =>
      transitionMission(stalePlanMission, {
        type: "complete",
        runId: "run-01",
        summary: "Stale proof.",
      }),
    ).toThrow(/current plan/i);
  });

  it("accepts an explicit current-plan warning as review evidence", () => {
    let mission = transitionMission(createMission(input), { type: "approve_plan" });
    mission = transitionMission(mission, {
      type: "start",
      workspaceId: "worktree/mission-01",
      runId: "run-warning",
    });
    mission = transitionMission(mission, {
      type: "record_evidence",
      runId: "run-warning",
      evidence: {
        id: "evidence-warning",
        kind: "manual",
        status: "warning",
        summary: "Automated browser verification unavailable; manually verified keyboard flow.",
        criterion: "Keyboard selection works",
        planRevisionId: mission.plan.id,
        timestamp: "2026-08-27T10:00:00.000Z",
      },
    });

    const completed = transitionMission(mission, {
      type: "complete",
      runId: "run-warning",
      summary: "Completed with an explicit verification warning.",
    });
    expect(completed.status).toBe("ready_for_review");
  });

  it("validates event ownership, identity, sequence, and active run", () => {
    let mission = transitionMission(createMission(input), { type: "approve_plan" });
    mission = transitionMission(mission, {
      type: "start",
      workspaceId: "worktree/mission-01",
      runId: "run-01",
    });
    const event = {
      id: "event-01",
      missionId: mission.id,
      runId: "run-01",
      sequence: 1,
      timestamp: "2026-08-27T10:00:00.000Z",
      kind: "execution" as const,
      title: "Started",
      detail: "Run started.",
    };
    mission = transitionMission(mission, { type: "append_event", runId: "run-01", event });

    expect(() =>
      transitionMission(mission, {
        type: "append_event",
        runId: "run-01",
        event: { ...event, missionId: "wrong-mission", id: "event-02", sequence: 2 },
      }),
    ).toThrow(/mission/i);
    expect(() =>
      transitionMission(mission, {
        type: "append_event",
        runId: "run-01",
        event: { ...event, sequence: 2 },
      }),
    ).toThrow(/unique/i);
    expect(() =>
      transitionMission(mission, {
        type: "append_event",
        runId: "run-01",
        event: { ...event, id: "event-03", sequence: 3 },
      }),
    ).toThrow(/contiguous/i);
    expect(() =>
      transitionMission(mission, {
        type: "append_event",
        runId: "stale-run",
        event: { ...event, id: "event-02", runId: "stale-run", sequence: 2 },
      }),
    ).toThrow(/active run/i);
  });

  it("blocks on a capability request and resumes after either resolution", () => {
    for (const decision of ["allowed", "denied"] as const) {
      let mission = transitionMission(createMission(input), { type: "approve_plan" });
      mission = transitionMission(mission, { type: "start", workspaceId: "opaque-workspace", runId: `run-${decision}` });
      const capability = {
        requestId: `request-${decision}`,
        runId: `run-${decision}`,
        capability: "network" as const,
        scope: "registry.npmjs.org",
        reason: "Read package metadata.",
      };
      mission = transitionMission(mission, {
        type: "append_event",
        runId: capability.runId,
        event: {
          id: `event-${decision}`,
          missionId: mission.id,
          runId: capability.runId,
          sequence: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          kind: "capability_request",
          title: "Permission required",
          detail: capability.reason,
          capability,
        },
      });
      expect(mission.status).toBe("blocked");

      mission = transitionMission(mission, {
        type: "resolve_capability",
        runId: capability.runId,
        requestId: capability.requestId,
        decision,
      });
      expect(mission.status).toBe("running");
    }
  });

  it("isolates revised run artifacts while preserving the global event log", () => {
    let mission = transitionMission(createMission(input), { type: "approve_plan" });
    mission = transitionMission(mission, { type: "start", workspaceId: "workspace-old", runId: "run-old" });
    mission = transitionMission(mission, {
      type: "append_event", runId: "run-old", event: {
        id: "event-old", missionId: mission.id, runId: "run-old", sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z", kind: "execution", title: "Old run", detail: "Started.",
      },
    });
    mission = transitionMission(mission, { type: "observe_change", runId: "run-old", change: { path: "old.ts", additions: 1, deletions: 0, diff: "+old" } });
    mission = transitionMission(mission, { type: "record_evidence", runId: "run-old", evidence: { id: "evidence-old", kind: "test", status: "passed", summary: "Old proof", planRevisionId: mission.plan.id, timestamp: "2026-08-27T10:00:01.000Z" } });
    mission = transitionMission(mission, { type: "complete", runId: "run-old", summary: "Old summary" });
    mission = transitionMission(mission, { type: "request_revision" });

    expect(mission.events).toHaveLength(1);
    expect(mission.changes).toEqual([]);
    expect(mission.evidence).toEqual([]);
    expect(mission.completionSummary).toBeUndefined();
    expect(mission.workspaceId).toBeUndefined();
    expect(mission.missionBranch).toBeUndefined();
  });

  it("revalidates review evidence and summary before accepting or rejecting", () => {
    const invalidReady = {
      ...createMission(input),
      status: "ready_for_review" as const,
      completionSummary: "Summary",
      plan: { ...createMission(input).plan, approved: true },
      evidence: [],
    };

    expect(() => transitionMission(invalidReady, { type: "accept" })).toThrow(/evidence/i);
    expect(() => transitionMission(invalidReady, { type: "reject" })).toThrow(/evidence/i);
  });

  it("follows the valid path from draft through accepted", () => {
    let mission = transitionMission(createMission(input), {
      type: "approve_plan",
    });
    mission = transitionMission(mission, {
      type: "start",
      workspaceId: "worktree/mission-01",
      runId: "run-01",
    });
    mission = transitionMission(mission, {
      type: "observe_change",
      runId: "run-01",
      change: {
        path: "src/palette.ts",
        additions: 24,
        deletions: 0,
        diff: "+export function openPalette() {}",
      },
    });
    mission = transitionMission(mission, {
      type: "record_evidence",
      runId: "run-01",
      evidence: {
        id: "evidence-01",
        kind: "test",
        status: "passed",
        summary: "12 tests passed",
        criterion: "Keyboard selection works",
        planRevisionId: mission.plan.id,
        timestamp: "2026-08-27T10:00:00.000Z",
      },
    });
    mission = transitionMission(mission, {
      type: "complete",
      runId: "run-01",
      summary: "Implemented and verified the command palette.",
    });
    mission = transitionMission(mission, { type: "accept" });

    expect(mission.status).toBe("accepted");
    expect(mission.reviewDecision).toBe("accepted");
  });

  it("rejects review decisions before review readiness", () => {
    expect(() =>
      transitionMission(createMission(input), { type: "reject" }),
    ).toThrow(MissionTransitionError);
  });

  it.each(["accept", "reject", "request_revision"] as const)("revalidates review prerequisites for %s", (type) => {
    const invalid = {
      ...createMission(input),
      status: "ready_for_review" as const,
      completionSummary: "Stale summary",
      plan: { ...createMission(input).plan, approved: true },
    };
    expect(() => transitionMission(invalid, { type })).toThrow(/evidence/i);
  });

  it("clears the prior review snapshot when a requested revision is edited", () => {
    const base = createMission(input);
    const revised = transitionMission({
      ...base,
      status: "revision_requested",
      reviewDecision: "revision_requested",
      workspaceId: crypto.randomUUID(),
      missionBranch: "orrery/old",
      activeRunId: crypto.randomUUID(),
      completionSummary: "Old completion",
      changes: [{ path: "old.ts", additions: 1, deletions: 0, diff: "+old" }],
      evidence: [{ id: crypto.randomUUID(), kind: "test", status: "passed", summary: "Old", planRevisionId: base.plan.id, timestamp: base.createdAt }],
    }, { type: "update_plan", plan: { ...input.plan, scope: "Revised scope" } });

    expect(revised).toMatchObject({ status: "planning", changes: [], evidence: [] });
    expect(revised.completionSummary).toBeUndefined();
    expect(revised.workspaceId).toBeUndefined();
    expect(revised.missionBranch).toBeUndefined();
    expect(revised.activeRunId).toBeUndefined();
  });

  it("records cancellation as a neutral durable event", () => {
    let mission = transitionMission(createMission(input), { type: "approve_plan" });
    const runId = crypto.randomUUID();
    mission = transitionMission(mission, { type: "start", workspaceId: crypto.randomUUID(), runId });
    mission = transitionMission(mission, {
      type: "cancel",
      runId,
      event: {
        id: crypto.randomUUID(), missionId: mission.id, runId, sequence: 1,
        timestamp: new Date().toISOString(), kind: "cancellation", title: "Run cancelled", detail: "Cancelled by user.",
      },
    });
    expect(mission.status).toBe("cancelled");
    expect(mission.events.at(-1)?.kind).toBe("cancellation");
  });
});
