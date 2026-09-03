import type { Command } from "@theia/core/lib/common/command";

export const MissionControlCommands = {
  OPEN: { id: "orrery.missionControl.open", label: "Mission Control" },
  REFRESH: { id: "orrery.missionControl.refresh", label: "Refresh Missions" },
  REVIEW: { id: "orrery.missionControl.review", label: "Review Mission" },
} as const satisfies Record<string, Command>;

export const OrreryIntelligenceCommands = {
  OPEN: { id: "orrery.intelligence.open", label: "Orrery Intelligence" },
} as const satisfies Record<string, Command>;

export const OrreryToolsCommands = {
  OPEN: { id: "orrery.tools.open", label: "Orrery Tools" },
} as const satisfies Record<string, Command>;
