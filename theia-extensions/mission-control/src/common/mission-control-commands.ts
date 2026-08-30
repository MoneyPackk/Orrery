import type { Command } from "@theia/core/lib/common/command";

export const MissionControlCommands = {
  OPEN: { id: "orrery.missionControl.open", label: "Mission Control" },
  REFRESH: { id: "orrery.missionControl.refresh", label: "Refresh Missions" },
  REVIEW: { id: "orrery.missionControl.review", label: "Review Mission" },
} as const satisfies Record<string, Command>;
