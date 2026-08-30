import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(root, "../theia-extensions/mission-control");
if (process.versions.node !== "24.19.0") {
  throw new Error(`Theia host requires Node 24.19.0; found ${process.versions.node}.`);
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to install the Theia host.");
execFileSync(process.execPath, [npmCli, "ci", "--ignore-scripts"], { cwd: extension, stdio: "inherit" });
execFileSync(process.execPath, [npmCli, "run", "build"], { cwd: extension, stdio: "inherit" });
rmSync(resolve(root, "node_modules/@orrery/mission-control-theia"), { recursive: true, force: true });
execFileSync(process.execPath, [npmCli, "ci", "--ignore-scripts", "--install-links"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [npmCli, "rebuild", "@theia/ffmpeg", "native-keymap", "drivelist"], { cwd: root, stdio: "inherit" });
