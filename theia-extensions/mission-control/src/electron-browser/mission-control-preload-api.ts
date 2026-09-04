import {
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
  INTELLIGENCE_GET_SETTINGS_CHANNEL, INTELLIGENCE_SET_SETTINGS_CHANNEL, INTELLIGENCE_LIST_MESSAGES_CHANNEL, INTELLIGENCE_SEND_MESSAGE_CHANNEL, INTELLIGENCE_CLEAR_THREAD_CHANNEL, INTELLIGENCE_TURN_STATUS_CHANNEL,
  MCP_LIST_CATALOG_CHANNEL, MCP_REGISTER_SERVER_CHANNEL, MCP_REMOVE_SERVER_CHANNEL, MCP_SET_DECISION_CHANNEL, MCP_INVOKE_TOOL_CHANNEL, MCP_LIST_ACTIVITY_CHANNEL,
  type MissionControlPublicApi,
} from "../common/mission-control-contracts";

export {
  MISSION_GET_SNAPSHOT_CHANNEL, MISSION_LIST_CHANNEL, MISSION_REVIEW_CHANNEL, MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
  INTELLIGENCE_GET_SETTINGS_CHANNEL, INTELLIGENCE_SET_SETTINGS_CHANNEL, INTELLIGENCE_LIST_MESSAGES_CHANNEL, INTELLIGENCE_SEND_MESSAGE_CHANNEL, INTELLIGENCE_CLEAR_THREAD_CHANNEL, INTELLIGENCE_TURN_STATUS_CHANNEL,
  MCP_LIST_CATALOG_CHANNEL, MCP_REGISTER_SERVER_CHANNEL, MCP_REMOVE_SERVER_CHANNEL, MCP_SET_DECISION_CHANNEL, MCP_INVOKE_TOOL_CHANNEL, MCP_LIST_ACTIVITY_CHANNEL,
};

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type MissionControlPreloadApi = MissionControlPublicApi;

export function createMissionControlPreloadApi(call: Invoke): MissionControlPreloadApi {
  return {
    intakeRepository: (input) => call(MISSION_INTAKE_REPOSITORY_CHANNEL, input) as ReturnType<MissionControlPreloadApi["intakeRepository"]>,
    create: (input) => call(MISSION_CREATE_CHANNEL, input) as ReturnType<MissionControlPreloadApi["create"]>,
    run: (input) => call(MISSION_RUN_CHANNEL, input) as ReturnType<MissionControlPreloadApi["run"]>,
    cancel: (input) => call(MISSION_CANCEL_CHANNEL, input) as ReturnType<MissionControlPreloadApi["cancel"]>,
    list: () => call(MISSION_LIST_CHANNEL) as ReturnType<MissionControlPreloadApi["list"]>,
    getSnapshot: (input) => call(MISSION_GET_SNAPSHOT_CHANNEL, input) as ReturnType<MissionControlPreloadApi["getSnapshot"]>,
    inspect: (input) => call(MISSION_INSPECT_CHANNEL, input) as ReturnType<MissionControlPreloadApi["inspect"]>,
    reviewAndPromote: (input) => call(MISSION_REVIEW_CHANNEL, input) as ReturnType<MissionControlPreloadApi["reviewAndPromote"]>,
    getIntelligenceSettings: () => call(INTELLIGENCE_GET_SETTINGS_CHANNEL) as ReturnType<MissionControlPreloadApi["getIntelligenceSettings"]>,
    setIntelligenceSettings: (input) => call(INTELLIGENCE_SET_SETTINGS_CHANNEL, input) as ReturnType<MissionControlPreloadApi["setIntelligenceSettings"]>,
    listIntelligenceMessages: (input) => call(INTELLIGENCE_LIST_MESSAGES_CHANNEL, input) as ReturnType<MissionControlPreloadApi["listIntelligenceMessages"]>,
    sendIntelligenceMessage: (input) => call(INTELLIGENCE_SEND_MESSAGE_CHANNEL, input) as ReturnType<MissionControlPreloadApi["sendIntelligenceMessage"]>,
    clearIntelligenceThread: (input) => call(INTELLIGENCE_CLEAR_THREAD_CHANNEL, input) as ReturnType<MissionControlPreloadApi["clearIntelligenceThread"]>,
    getIntelligenceTurnStatus: (input) => call(INTELLIGENCE_TURN_STATUS_CHANNEL, input) as ReturnType<MissionControlPreloadApi["getIntelligenceTurnStatus"]>,
    listMcpCatalog: () => call(MCP_LIST_CATALOG_CHANNEL) as ReturnType<MissionControlPreloadApi["listMcpCatalog"]>,
    registerMcpServer: (input) => call(MCP_REGISTER_SERVER_CHANNEL, input) as ReturnType<MissionControlPreloadApi["registerMcpServer"]>,
    removeMcpServer: (input) => call(MCP_REMOVE_SERVER_CHANNEL, input) as ReturnType<MissionControlPreloadApi["removeMcpServer"]>,
    setMcpToolDecision: (input) => call(MCP_SET_DECISION_CHANNEL, input) as ReturnType<MissionControlPreloadApi["setMcpToolDecision"]>,
    invokeMcpTool: (input) => call(MCP_INVOKE_TOOL_CHANNEL, input) as ReturnType<MissionControlPreloadApi["invokeMcpTool"]>,
    listMcpActivity: () => call(MCP_LIST_ACTIVITY_CHANNEL) as ReturnType<MissionControlPreloadApi["listMcpActivity"]>,
  };
}
