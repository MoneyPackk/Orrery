import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrustedApprovalService, approvalKeyFingerprint } from "../packages/mission-control-daemon/src/promotion-approval";
import { completeParentBootstrap } from "./daemon-bootstrap";
import { acquireDaemonLock, createRuntimeDirectory, endpointPaths, waitForDaemon } from "./daemon-lifecycle";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Electron-managed daemon bootstrap integration", () => {
  it("pins the inherited key and publishes matching readiness metadata", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "orrery-electron-bootstrap-")); directories.push(localAppData);
    const runtime = join(localAppData, "Orrery", "runtime");
    await createRuntimeDirectory({ localAppData, baseDirectory: join(localAppData, "Orrery") });
    const paths = endpointPaths(runtime);
    const lock = await acquireDaemonLock(paths.lockPath);
    if (!lock) throw new Error("Expected startup lock");
    const issuer = new TrustedApprovalService();
    const child = daemonChild(localAppData, lock.nonce, true);
    const binding = await Promise.race([completeParentBootstrap(child, lock.nonce, issuer.publicKey), childFailure(child)]);
    const endpoint = await Promise.race([waitForDaemon(paths.endpointPath, { maxAttempts: 1_200, delayMs: 50 }), childFailure(child)]);
    expect(endpoint).toMatchObject({ pid: child.pid, instanceId: binding.instanceId, approvalKeyFingerprint: approvalKeyFingerprint(issuer.publicKey) });
    child.kill("SIGTERM");
    await exited(child);
    await lock.release();
  }, 120_000);

  it("rejects attacker lock plus environment key when the inherited pipe is absent", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "orrery-env-bootstrap-")); directories.push(localAppData);
    const runtime = await createRuntimeDirectory({ localAppData, baseDirectory: join(localAppData, "Orrery") });
    const paths = endpointPaths(runtime);
    const lock = await acquireDaemonLock(paths.lockPath);
    if (!lock) throw new Error("Expected startup lock");
    const child = daemonChild(localAppData, lock.nonce, false, { ORRERY_FAKE_PROMOTION_KEY: "attacker" });
    await expect(exited(child)).resolves.not.toBe(0);
    await expect(waitForDaemon(paths.endpointPath, { maxAttempts: 2, delayMs: 1 })).rejects.toThrow(/ready/i);
    await lock.release();
  }, 30_000);
});

function daemonChild(localAppData: string, nonce: string, withPipe: boolean, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, [join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"), join(process.cwd(), "scripts", "orrery-daemon.ts"), "--electron-promotion-bootstrap"], {
    env: { ...process.env, LOCALAPPDATA: localAppData, ORRERY_DAEMON_MANAGED: "1", ORRERY_DAEMON_HANDOFF_NONCE: nonce, ...extraEnv },
    stdio: withPipe ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : "ignore",
    windowsHide: true,
  });
}

function exited(child: ReturnType<typeof spawn>): Promise<number | null> { return new Promise((resolve) => child.once("exit", resolve)); }
function childFailure(child: ReturnType<typeof spawn>): Promise<never> { return new Promise((_, reject) => { let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += chunk; }); child.once("exit", (code) => reject(new Error(`Daemon exited ${code}: ${stderr}`))); }); }
