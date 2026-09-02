declare module "@orrery/root-mission-control-daemon-client" {
  import type { BrowserWindow } from "electron";
  import type { MissionControlHostService, MissionReviewInput } from "@orrery/mission-control-theia";

  export class MissionControlDaemonClient {
    constructor(options: { parentWindow(): BrowserWindow | null; daemonEntryPath: string });
    list(): ReturnType<MissionControlHostService["list"]>;
    getSnapshot(input: Parameters<MissionControlHostService["getSnapshot"]>[0]): ReturnType<MissionControlHostService["getSnapshot"]>;
    intakeRepository(input: Parameters<MissionControlHostService["intakeRepository"]>[0], parent: BrowserWindow): ReturnType<MissionControlHostService["intakeRepository"]>;
    create(input: Parameters<MissionControlHostService["create"]>[0]): ReturnType<MissionControlHostService["create"]>;
    run(input: Parameters<MissionControlHostService["run"]>[0]): ReturnType<MissionControlHostService["run"]>;
    cancel(input: Parameters<MissionControlHostService["cancel"]>[0]): ReturnType<MissionControlHostService["cancel"]>;
    inspect(input: Parameters<MissionControlHostService["inspect"]>[0]): ReturnType<MissionControlHostService["inspect"]>;
    reviewAndPromote(input: MissionReviewInput): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    reviewAndPromoteInWindow(input: MissionReviewInput, parent: BrowserWindow): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    disconnect(): Promise<void>;
  }
}
