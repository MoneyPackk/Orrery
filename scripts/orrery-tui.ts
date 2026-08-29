import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MissionControlClient, TcpLineTransport } from "../packages/mission-control-client/src/index";
import { runTui } from "../packages/mission-control-tui/src/index";
import {
  acquireDaemonLock,
  createRuntimeDirectory,
  endpointPaths,
  ensureDaemon,
  readAndProbeDaemon,
  readPrivateStateFile,
  removeStaleDaemonState,
  stopOwnedDaemon,
} from "./daemon-lifecycle";
import { runStandaloneTui } from "./orrery-tui-standalone";

export interface CompanionTuiDependencies {
  process?: Pick<typeof process, "once" | "off">;
  createRuntimeDirectory?: typeof createRuntimeDirectory;
  endpointPaths?: typeof endpointPaths;
  readAndProbeDaemon?: typeof readAndProbeDaemon;
  removeStaleDaemonState?: typeof removeStaleDaemonState;
  ensureDaemon?: typeof ensureDaemon;
  readToken?: (path: string) => Promise<string>;
  createClient?: () => MissionControlClient;
  runTui?: typeof runTui;
  stopOwnedDaemon?: typeof stopOwnedDaemon;
}

export async function runCompanionTui(dependencies: CompanionTuiDependencies = {}): Promise<void> {
  const processApi = dependencies.process ?? process;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  processApi.once("SIGINT", onSignal);
  processApi.once("SIGTERM", onSignal);
  processApi.once("SIGHUP", onSignal);
  let daemon: EnsuredDaemon | undefined;
  let client: MissionControlClient | undefined;
  try {
    const runtimeDirectory = await (dependencies.createRuntimeDirectory ?? createRuntimeDirectory)();
    controller.signal.throwIfAborted();
    const paths = (dependencies.endpointPaths ?? endpointPaths)(runtimeDirectory);
    if (!(await (dependencies.readAndProbeDaemon ?? readAndProbeDaemon)(paths.endpointPath))) {
      await (dependencies.removeStaleDaemonState ?? removeStaleDaemonState)({ ...paths, expectedTokenPath: paths.tokenPath });
    }
    controller.signal.throwIfAborted();
    daemon = await (dependencies.ensureDaemon ?? ensureDaemon)(paths.endpointPath, {
      acquireLock: () => acquireDaemonLock(paths.lockPath),
      spawn: (handoff) => spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url)), fileURLToPath(new URL("./orrery-daemon.ts", import.meta.url))], {
        env: { ...process.env, ORRERY_DAEMON_MANAGED: "1", ORRERY_DAEMON_HANDOFF_NONCE: handoff?.nonce },
        stdio: "ignore",
        windowsHide: true,
      }),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    const token = (await (dependencies.readToken ?? readPrivateStateFile)(daemon.endpoint.tokenPath)).trim();
    controller.signal.throwIfAborted();
    client = dependencies.createClient?.() ?? new MissionControlClient(new TcpLineTransport());
    await client.connect({ host: daemon.endpoint.host, port: daemon.endpoint.port, version: daemon.endpoint.protocol }, token);
    controller.signal.throwIfAborted();
    await (dependencies.runTui ?? runTui)(client, { signal: controller.signal });
  } finally {
    processApi.off("SIGINT", onSignal);
    processApi.off("SIGTERM", onSignal);
    processApi.off("SIGHUP", onSignal);
    try {
      await client?.disconnect();
    } finally {
      if (daemon) await (dependencies.stopOwnedDaemon ?? stopOwnedDaemon)(daemon);
    }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--standalone")) return runStandaloneTui();
  return runCompanionTui();
}

if (process.env.npm_lifecycle_event === "tui") {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
