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
    getIntelligenceSettings(): ReturnType<MissionControlHostService["getIntelligenceSettings"]>;
    setIntelligenceSettings(input: Parameters<MissionControlHostService["setIntelligenceSettings"]>[0]): ReturnType<MissionControlHostService["setIntelligenceSettings"]>;
    listIntelligenceMessages(input: Parameters<MissionControlHostService["listIntelligenceMessages"]>[0]): ReturnType<MissionControlHostService["listIntelligenceMessages"]>;
    sendIntelligenceMessage(input: Parameters<MissionControlHostService["sendIntelligenceMessage"]>[0], parent?: BrowserWindow): ReturnType<MissionControlHostService["sendIntelligenceMessage"]>;
    clearIntelligenceThread(input: Parameters<MissionControlHostService["clearIntelligenceThread"]>[0]): ReturnType<MissionControlHostService["clearIntelligenceThread"]>;
    getIntelligenceTurnStatus(input: Parameters<MissionControlHostService["getIntelligenceTurnStatus"]>[0]): ReturnType<MissionControlHostService["getIntelligenceTurnStatus"]>;
    reviewAndPromote(input: MissionReviewInput): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    reviewAndPromoteInWindow(input: MissionReviewInput, parent: BrowserWindow): ReturnType<MissionControlHostService["reviewAndPromote"]>;
    listMcpCatalog(): ReturnType<MissionControlHostService["listMcpCatalog"]>;
    registerMcpServer(input: Parameters<MissionControlHostService["registerMcpServer"]>[0], parent: BrowserWindow): ReturnType<MissionControlHostService["registerMcpServer"]>;
    removeMcpServer(input: Parameters<MissionControlHostService["removeMcpServer"]>[0]): ReturnType<MissionControlHostService["removeMcpServer"]>;
    setMcpToolDecision(input: Parameters<MissionControlHostService["setMcpToolDecision"]>[0], parent: BrowserWindow): ReturnType<MissionControlHostService["setMcpToolDecision"]>;
    listMcpActivity(): ReturnType<MissionControlHostService["listMcpActivity"]>;
    invokeMcpTool(input: Parameters<MissionControlHostService["invokeMcpTool"]>[0], parent: BrowserWindow): ReturnType<MissionControlHostService["invokeMcpTool"]>;
    disconnect(): Promise<void>;
  }
}
