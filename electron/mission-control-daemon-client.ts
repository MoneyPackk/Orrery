import { MissionControlClient, TcpLineTransport } from "@orrery/mission-control-client";
import { createRuntimeDirectory, endpointPaths, readAndProbeDaemon, readPrivateStateFile } from "../scripts/daemon-lifecycle";
import type { MissionIpcService, MissionSnapshotIntent } from "./mission-ipc";

interface SharedClient {
  connect(endpoint: { host: string; port: number; version: string }, token: string): Promise<void>;
  disconnect(): Promise<void>;
  proposeRepository: MissionIpcService["proposeRepository"];
  approveRepository(input: import("./contract").ApproveRepositoryInput): Promise<unknown>;
  createMission: MissionIpcService["create"];
  runMission: MissionIpcService["run"];
  cancelMission: MissionIpcService["cancel"];
  getMission(id: string): ReturnType<MissionIpcService["getSnapshot"]>;
  inspectMission: MissionIpcService["inspect"];
  promoteMission(input: import("./contract").PromoteMissionInput): Promise<unknown>;
}
export interface MissionControlDaemonClientDependencies {
  createRuntimeDirectory?: typeof createRuntimeDirectory;
  endpointPaths?: typeof endpointPaths;
  readAndProbeDaemon?: typeof readAndProbeDaemon;
  readToken?: (path: string) => Promise<string>;
  createClient?: () => SharedClient;
}
export class MissionControlDaemonClient implements MissionIpcService {
  private client: SharedClient | undefined;
  private connecting: Promise<SharedClient> | undefined;
  constructor(private readonly dependencies: MissionControlDaemonClientDependencies = {}) {}
  proposeRepository: MissionIpcService["proposeRepository"] = async (input) => this.mutate((client) => client.proposeRepository(input));
  create: MissionIpcService["create"] = async (input) => this.mutate((client) => client.createMission(input));
  run: MissionIpcService["run"] = async (input) => this.mutate((client) => client.runMission(input));
  cancel: MissionIpcService["cancel"] = async (input) => this.mutate((client) => client.cancelMission(input));
  getSnapshot = async (input: MissionSnapshotIntent) => (await this.connected()).getMission(input.missionId);
  inspect: MissionIpcService["inspect"] = async (input) => (await this.connected()).inspectMission(input);
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.disconnect();
  }
  private connected(): Promise<SharedClient> {
    if (this.client) return Promise.resolve(this.client);
    return this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
  }
  private async mutate<T>(operation: (client: SharedClient) => Promise<T>): Promise<T> {
    const client = await this.connected();
    try {
      return await operation(client);
    } catch (error) {
      if (!isDisconnect(error) || this.client !== client) throw error;
      this.client = undefined;
      await client.disconnect().catch(() => undefined);
      return operation(await this.connected());
    }
  }
  private async connect(): Promise<SharedClient> {
    const runtime = await (this.dependencies.createRuntimeDirectory ?? createRuntimeDirectory)();
    const paths = (this.dependencies.endpointPaths ?? endpointPaths)(runtime);
    const endpoint = await (this.dependencies.readAndProbeDaemon ?? readAndProbeDaemon)(paths.endpointPath);
    if (!endpoint) throw new Error("No authenticated Orrery daemon endpoint is available. Start `npm run daemon` first.");
    const token = (await (this.dependencies.readToken ?? readPrivateStateFile)(endpoint.tokenPath)).trim();
    const client = this.dependencies.createClient?.() ?? new MissionControlClient(new TcpLineTransport());
    await client.connect({ host: endpoint.host, port: endpoint.port, version: endpoint.protocol }, token);
    this.client = client;
    return client;
  }
}

function isDisconnect(error: unknown): boolean {
  return error instanceof Error && /disconnect|socket|closed|ECONNRESET|EPIPE/i.test(error.message);
}
