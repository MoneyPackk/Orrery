import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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

export async function runDaemon(): Promise<void> {
  const runtimeDirectory = await createRuntimeDirectory();
  const paths = endpointPaths(runtimeDirectory);
  const managed = process.env.ORRERY_DAEMON_MANAGED === "1";
  const handoffNonce = process.env.ORRERY_DAEMON_HANDOFF_NONCE;
  const lock = managed ? undefined : await acquireDaemonLock(paths.lockPath);
  if (managed) {
    if (!handoffNonce) throw new Error("Managed daemon startup requires an ownership handoff nonce.");
    if (!(await verifyDaemonLock(paths.lockPath, handoffNonce))) throw new Error("Managed daemon ownership handoff is invalid.");
  } else if (!lock) throw new Error("An Orrery daemon is already running or starting.");
  await rm(paths.endpointPath, { force: true });
  await rm(paths.tokenPath, { force: true });

  const instanceId = randomUUID();
  const authority = await createDaemonAuthority(runtimeDirectory);
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
    await cleanupDaemonState({ endpointPath: paths.endpointPath, tokenPath: paths.tokenPath, lockPath: paths.lockPath, lockNonce: handoffNonce ?? lock?.nonce ?? "", pid: process.pid, instanceId, isProcessAlive: () => false });
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

if (process.env.npm_lifecycle_event === "daemon" || process.env.ORRERY_DAEMON_MANAGED === "1") {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
