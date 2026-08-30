import { MissionControlClient, TcpLineTransport } from "@orrery/mission-control-client";
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { TrustedApprovalService } from "../packages/mission-control-daemon/src/promotion-approval";
import { acquireDaemonLock, createRuntimeDirectory, endpointPaths, ensureDaemon, readPrivateStateFile, stopOwnedDaemon, type EnsuredDaemon } from "../scripts/daemon-lifecycle";
import type { MissionIpcService, MissionSnapshotIntent } from "./mission-ipc";
import { confirmTrustedReview } from "./trusted-review";
import { completeParentBootstrap } from "../scripts/daemon-bootstrap";

interface SharedClient {
  connect(endpoint: { host: string; port: number; version: string }, token: string): Promise<void>;
  disconnect(): Promise<void>;
  proposeRepository: MissionIpcService["proposeRepository"];
  approveRepository(input: import("./contract").ApproveRepositoryInput): Promise<unknown>;
  createMission: MissionIpcService["create"];
  runMission: MissionIpcService["run"];
  cancelMission: MissionIpcService["cancel"];
  listMissions(): ReturnType<MissionIpcService["list"]>;
  getMission(id: string): ReturnType<MissionIpcService["getSnapshot"]>;
  inspectMission: MissionIpcService["inspect"];
  promoteMission(input: import("./contract").PromoteMissionInput): ReturnType<MissionIpcService["reviewAndPromote"]>;
}
export interface MissionControlDaemonClientDependencies {
  createRuntimeDirectory?: typeof createRuntimeDirectory;
  endpointPaths?: typeof endpointPaths;
  ensureDaemon?: typeof ensureDaemon;
  readToken?: (path: string) => Promise<string>;
  createClient?: () => SharedClient;
  confirmReview?: (input: { decision: "accepted" | "rejected"; missionId: string; planRevisionId: string; changeRevision: string; contentDigest: string; review: import("@orrery/mission-control-protocol").MissionReviewContent }) => Promise<boolean>;
  acquireLock?: () => ReturnType<typeof acquireDaemonLock>;
  parentWindow?: () => BrowserWindow | null;
}
export class MissionControlDaemonClient implements MissionIpcService {
  private client: SharedClient | undefined;
  private connecting: Promise<SharedClient> | undefined;
  private readonly approvals = new TrustedApprovalService();
  private daemon?: EnsuredDaemon;
  constructor(private readonly dependencies: MissionControlDaemonClientDependencies = {}) {}
  proposeRepository: MissionIpcService["proposeRepository"] = async (input) => this.mutate((client) => client.proposeRepository(input));
  create: MissionIpcService["create"] = async (input) => this.mutate((client) => client.createMission(input));
  run: MissionIpcService["run"] = async (input) => this.mutate((client) => client.runMission(input));
  cancel: MissionIpcService["cancel"] = async (input) => this.mutate((client) => client.cancelMission(input));
  list = async () => (await this.connected()).listMissions();
  getSnapshot = async (input: MissionSnapshotIntent) => (await this.connected()).getMission(input.missionId);
  inspect: MissionIpcService["inspect"] = async (input) => (await this.connected()).inspectMission(input);
  reviewAndPromote: MissionIpcService["reviewAndPromote"] = async (input) => {
    const inspection = await this.inspect({ missionId: input.missionId, planRevisionId: input.planRevisionId });
    if (inspection.mission.id !== input.missionId || inspection.planRevisionId !== input.planRevisionId) throw new Error("The inspected mission is stale.");
    const target = { ...input, changeRevision: inspection.changeRevision, contentDigest: inspection.contentDigest, review: inspection.review };
    const confirm = this.dependencies.confirmReview ?? (async (reviewTarget) => { const parent = this.dependencies.parentWindow?.(); if (!parent) throw new Error("Trusted review requires the Electron main window."); return confirmTrustedReview(reviewTarget, parent); });
    if (!await confirm(target)) throw new Error("Mission review cancelled.");
    const approvalInput = { missionId: input.missionId, planRevisionId: input.planRevisionId, changeRevision: inspection.changeRevision, contentDigest: inspection.contentDigest, decision: input.decision };
    const approvalCapability = this.approvals.issue(approvalInput);
    return (await this.connected()).promoteMission({ ...approvalInput, intentId: input.intentId, approvalCapability });
  };
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.disconnect();
    if (this.daemon) await stopOwnedDaemon(this.daemon);
    this.daemon = undefined;
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
    const daemon = await (this.dependencies.ensureDaemon ?? ensureDaemon)(paths.endpointPath, {
      acquireLock: this.dependencies.acquireLock ?? (() => acquireDaemonLock(paths.lockPath)),
      spawn: (handoff) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url)), fileURLToPath(new URL("../scripts/orrery-daemon.ts", import.meta.url)), "--electron-promotion-bootstrap"], { env: { ...process.env, ORRERY_DAEMON_MANAGED: "1", ORRERY_DAEMON_HANDOFF_NONCE: handoff?.nonce }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
        if (!handoff?.nonce || !child.pid) { child.kill("SIGTERM"); throw new Error("Managed daemon bootstrap pipe is unavailable."); }
        const bootstrapBinding = completeParentBootstrap(child, handoff.nonce, this.approvals.publicKey);
        void bootstrapBinding.catch(() => child.kill("SIGTERM"));
        return Object.assign(child, { bootstrapBinding });
      },
    });
    if (!daemon.owned) throw new Error("Electron requires an Electron-owned daemon; another Orrery daemon is already active.");
    this.daemon = daemon;
    const endpoint = daemon.endpoint;
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
