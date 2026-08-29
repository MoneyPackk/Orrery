import { createHash } from "node:crypto";
import type { MissionReviewContent } from "@orrery/mission-control-protocol";
import type { MissionInspectionResult } from "./authority-types";

export function reviewContent(result: MissionInspectionResult): { review: MissionReviewContent; contentDigest: string } {
  const review: MissionReviewContent = {
    changes: result.changeSnapshot.files.map(({ path, additions, deletions, binary, diff }) => ({ path, additions, deletions, binary, diff })),
    evidence: result.mission.evidence.filter((item) => item.planRevisionId === result.planRevisionId).map(({ id, kind, status, summary, criterion, planRevisionId, timestamp }) => ({ id, kind, status, summary, ...(criterion === undefined ? {} : { criterion }), planRevisionId, timestamp })),
  };
  return { review, contentDigest: digestReviewContent(review) };
}

export function digestReviewContent(review: MissionReviewContent): string {
  return createHash("sha256").update(JSON.stringify(review)).digest("hex");
}
