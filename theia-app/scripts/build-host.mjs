import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

await rm(resolve("host/lib"), { recursive: true, force: true });
await mkdir(resolve("host/lib/resources"), { recursive: true });

await build({
  entryPoints: [resolve("host/src/electron-main/mission-control-host-module.ts")],
  outfile: resolve("host/lib/electron-main/mission-control-host-module.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: true,
  external: ["electron", "@theia/*", "@orrery/mission-control-theia"],
  plugins: [{
    name: "orrery-root-daemon-client",
    setup(build) {
      build.onResolve({ filter: /^@orrery\/root-mission-control-daemon-client$/ }, () => ({
        path: resolve("../electron/mission-control-daemon-client.ts")
      }));
    }
  }]
});

await build({
  entryPoints: [resolve("../scripts/orrery-daemon.ts")],
  outfile: resolve("host/lib/resources/mission-control-daemon.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  sourcemap: false
});

const declarations = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "host/tsconfig.json", "--emitDeclarationOnly"], {
  cwd: process.cwd(),
  stdio: "inherit"
});
if (declarations.status !== 0) process.exit(declarations.status ?? 1);
