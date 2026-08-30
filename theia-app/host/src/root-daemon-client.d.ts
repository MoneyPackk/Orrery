declare module "@orrery/root-mission-control-daemon-client" {
  import type { BrowserWindow } from "electron";
  import type { MissionControlHostService, MissionReviewInput } from "@orrery/mission-control-theia";

  export class MissionControlDaemonClient {
    constructor(options: { parentWindow(): BrowserWindow | null; daemonEntryPath: string });
    list(): ReturnType<MissionControlHostService["list"]>;
    getSnapshot(input: Parameters<MissionControlHostService["getSnapshot"]>[0]): ReturnType<MissionControlHostService["getSnapshot"]>;
    reviewAndPromote(input: MissionReviewInput): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    reviewAndPromoteInWindow(input: MissionReviewInput, parent: BrowserWindow): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    disconnect(): Promise<void>;
  }
}
