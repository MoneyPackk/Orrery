import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { DaemonServer } from "../packages/mission-control-daemon/src/index";
import { PROTOCOL_VERSION } from "../packages/mission-control-protocol/src/index";
import {
  acquireDaemonLock,
  cleanupDaemonState,
  createRuntimeDirectory,
  endpointPaths,
  isProcessAlive,
  publishDaemonEndpoint,
  registerDaemonCleanup,
  verifyDaemonLock,
} from "./daemon-lifecycle";
import { createDaemonAuthority } from "./daemon-authority-bootstrap";
import { readBootstrapFrame, writeBootstrapChallenge } from "./daemon-bootstrap";
import { approvalKeyFingerprint } from "../packages/mission-control-daemon/src/promotion-approval";

export async function runDaemon(): Promise<void> {
  const runtimeDirectory = await createRuntimeDirectory();
  const paths = endpointPaths(runtimeDirectory);
  const managed = process.env.ORRERY_DAEMON_MANAGED === "1";
  const handoffNonce = process.env.ORRERY_DAEMON_HANDOFF_NONCE;
  const lock = managed ? undefined : await acquireDaemonLock(paths.lockPath);
  const promotionBootstrapRequired = process.argv.includes("--electron-promotion-bootstrap");
  if (promotionBootstrapRequired && !managed) throw new Error("Promotion bootstrap requires managed daemon ownership.");
  if (promotionBootstrapRequired) {
    if (!handoffNonce) throw new Error("Managed daemon startup requires an ownership handoff nonce.");
    if (!(await verifyDaemonLock(paths.lockPath, handoffNonce))) throw new Error("Managed daemon ownership handoff is invalid.");
  } else if (!lock) throw new Error("An Orrery daemon is already running or starting.");
  await removeTransientStateFile(paths.endpointPath);
  await removeTransientStateFile(paths.tokenPath);

  const instanceId = randomUUID();
  let trustedApprovalPublicKey: string | undefined;
  if (managed) {
    const parentPid = process.ppid;
    const challenge = randomBytes(32).toString("hex");
    const bootstrapWrite = createWriteStream("NUL", { fd: 3 });
    const bootstrapRead = createReadStream("NUL", { fd: 4 });
    try {
      await writeBootstrapChallenge(bootstrapWrite, { type: "promotion_bootstrap_challenge", version: 1, parentPid, childPid: process.pid, instanceId, challenge });
      const bootstrap = await readBootstrapFrame(bootstrapRead, { handoffNonce: handoffNonce!, parentPid, childPid: process.pid, instanceId, challenge });
      trustedApprovalPublicKey = bootstrap.approvalPublicKey;
    } finally {
      bootstrapRead.destroy();
      bootstrapWrite.destroy();
    }
  }
  const authority = await createDaemonAuthority(runtimeDirectory, { trustedApprovalPublicKey });
  const server = new DaemonServer({
    tokenPath: paths.tokenPath,
    registry: authority.registry,
    authority: authority.authority,
    eventSource: authority.eventSource,
    recoverOnStartup: authority.recoverActiveMissions,
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await authority.authority.shutdown().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await cleanupDaemonState({ endpointPath: paths.endpointPath, tokenPath: paths.tokenPath, lockPath: paths.lockPath, lockNonce: handoffNonce ?? lock?.nonce ?? "", lockOwnerPid: managed ? process.ppid : process.pid, pid: process.pid, instanceId, isProcessAlive: () => false });
    await lock?.release().catch(() => undefined);
  };
  const unregister = registerDaemonCleanup(stop);
  try {
    const endpoint = await server.start();
    await publishDaemonEndpoint(paths.endpointPath, {
      host: endpoint.host,
      port: endpoint.port,
      protocol: PROTOCOL_VERSION,
      tokenPath: endpoint.tokenPath,
      pid: process.pid,
      instanceId,
      lockNonce: handoffNonce ?? lock?.nonce,
      ...(trustedApprovalPublicKey ? { approvalKeyFingerprint: approvalKeyFingerprint(trustedApprovalPublicKey) } : {}),
    });
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.once("SIGHUP", finish);
    });
  } finally {
    unregister();
    await stop();
    if (!isProcessAlive(process.pid)) await rm(paths.endpointPath, { force: true });
  }
}

async function removeTransientStateFile(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

if (process.env.npm_lifecycle_event === "daemon" || process.env.ORRERY_DAEMON_MANAGED === "1") {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
