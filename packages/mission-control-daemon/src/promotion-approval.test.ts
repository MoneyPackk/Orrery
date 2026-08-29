import { describe, expect, it } from "vitest";
import { TrustedApprovalService } from "./promotion-approval";

describe("TrustedApprovalService", () => {
  it("derives reviewer identity and bounded expiry from trusted context", () => {
    const approvals = new TrustedApprovalService({
      reviewerId: () => "native-user",
      now: () => "2026-08-28T11:00:00.000Z",
      id: () => "capability-1",
      maximumTtlMs: 60_000,
    });

    const capability = approvals.issue({ missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" });

    expect(approvals.consume({ capability, missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" }))
      .toEqual({ reviewerId: "native-user" });
    expect(() => approvals.consume({ capability, missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" }))
      .toThrow(/already used/i);
  });

  it("expires capabilities at the issuer's fixed maximum TTL", () => {
    let now = "2026-08-28T11:00:00.000Z";
    const approvals = new TrustedApprovalService({ reviewerId: () => "native-user", now: () => now, id: () => "capability-1", maximumTtlMs: 1_000 });
    const capability = approvals.issue({ missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" });
    now = "2026-08-28T11:00:01.000Z";

    expect(() => approvals.consume({ capability, missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" })).toThrow(/expired/i);
  });
});
