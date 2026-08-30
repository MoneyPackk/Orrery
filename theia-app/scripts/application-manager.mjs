import { ApplicationPackageManager } from "@theia/application-manager/lib/application-package-manager.js";

const [command, ...args] = process.argv.slice(2);
const manager = new ApplicationPackageManager({ projectPath: process.cwd() });

if (command === "clean") {
  await manager.clean();
} else if (command === "build") {
  await manager.build([], { mode: args.includes("--mode=development") ? "development" : "production" });
} else if (command === "start") {
  const child = manager.start(args);
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  throw new Error(`Unsupported Theia application-manager command: ${command ?? "missing"}`);
}
