import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMission,
  MissionTransitionError,
  transitionMission,
  type Evidence,
  type Mission,
  type MissionEvent,
  type MissionStatus,
  type PlanRevision,
} from "@orrery/mission-control-domain";

describe("mission control domain package boundary", () => {
  it("exports the mission contracts and pure transitions", () => {
    const mission: Mission = createMission({
      title: "Package boundary",
      goal: "Expose the framework-free mission domain",
      mode: "build",
    });
    const status: MissionStatus = mission.status;
    const plan: PlanRevision = mission.plan;
    const events: MissionEvent[] = mission.events;
    const evidence: Evidence[] = mission.evidence;

    expect(status).toBe("draft");
    expect(plan.revision).toBe(1);
    expect(events).toEqual([]);
    expect(evidence).toEqual([]);
    expect(() => transitionMission(mission, { type: "approve_plan" })).toThrow(
      MissionTransitionError,
    );
  });

  it("contains no forbidden runtime imports", () => {
    const source = ["index.ts", "mission.ts", "fixture-runtime.ts"]
      .map((file) => readFileSync(resolve(process.cwd(), "packages/mission-control-domain/src", file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /(?:electron|react|theia|@theia\/|node:fs|node:process|from ["']fs|from ["']process)/i,
    );
  });
});
