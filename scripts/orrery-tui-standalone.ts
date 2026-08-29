import { MissionControlClient, TcpLineTransport } from "../packages/mission-control-client/src/index";
import { runTui } from "../packages/mission-control-tui/src/index";
import { createRuntimeDirectory, endpointPaths, readAndProbeDaemon, readDaemonEndpoint, readPrivateStateFile } from "./daemon-lifecycle";

export async function runStandaloneTui(): Promise<void> {
  const paths = endpointPaths(await createRuntimeDirectory());
  const ready = await readAndProbeDaemon(paths.endpointPath);
  if (!ready) throw new Error("No authenticated Orrery daemon endpoint is available. Start `npm run daemon` first.");
  const endpoint = await readDaemonEndpoint(paths.endpointPath);
  const token = (await readPrivateStateFile(endpoint.tokenPath)).trim();
  const client = new MissionControlClient(new TcpLineTransport());
  try {
    await client.connect({ host: endpoint.host, port: endpoint.port, version: endpoint.protocol }, token);
    await runTui(client);
  } finally {
    await client.disconnect();
  }
}

if (process.env.npm_lifecycle_event === "tui:standalone") {
  runStandaloneTui().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
