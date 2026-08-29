import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDaemonLock,
  cleanupDaemonState,
  createRuntimeDirectory,
  ensureDaemon,
  endpointPaths,
  probeDaemon,
  publishDaemonEndpoint,
  readDaemonEndpoint,
  readAndProbeDaemon,
  removeStaleDaemonState,
  stopOwnedDaemon,
  waitForDaemon,
  verifyDaemonLock,
  type DaemonEndpointMetadata,
} from "./daemon-lifecycle";

const directories: string[] = [];
const metadata: DaemonEndpointMetadata = {
  host: "127.0.0.1",
  port: 43123,
  protocol: "mission-control.v1",
  tokenPath: "token",
  pid: 1234,
  instanceId: "instance-1",
  lockNonce: "lock-1",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon lifecycle", () => {
  it("creates a private per-user runtime directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-"));
    directories.push(parent);

    const runtime = await createRuntimeDirectory({ baseDirectory: parent, platform: "linux" });

    expect(runtime).toBe(join(parent, "runtime"));
  });

  it("rejects a Windows runtime root outside trusted per-user LOCALAPPDATA", async () => {
    await expect(createRuntimeDirectory({
      baseDirectory: "C:\\shared\\orrery",
      localAppData: "C:\\Users\\user\\AppData\\Local",
      platform: "win32",
      harden: async () => undefined,
    })).rejects.toThrow(/LOCALAPPDATA|trusted/i);
  });

  it("rejects a reparse point in the Windows runtime ancestry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-reparse-"));
    const target = await mkdtemp(join(tmpdir(), "orrery-lifecycle-target-"));
    directories.push(parent, target);
    await symlink(target, join(parent, "Orrery"), process.platform === "win32" ? "junction" : "dir");

    await expect(createRuntimeDirectory({
      baseDirectory: join(parent, "Orrery"),
      localAppData: parent,
      platform: "win32",
      harden: async () => undefined,
    })).rejects.toThrow(/reparse|symbolic|real directory/i);
  });

  it("hardens every app-owned Windows runtime directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-ancestry-"));
    directories.push(parent);
    const hardened: string[] = [];

    await createRuntimeDirectory({
      baseDirectory: join(parent, "Orrery"),
      localAppData: parent,
      platform: "win32",
      harden: async (path) => { hardened.push(path); },
    });

    expect(hardened).toEqual([join(parent, "Orrery"), join(parent, "Orrery", "runtime")]);
  });

  it("publishes endpoint metadata atomically without a raw token", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-publish-"));
    directories.push(parent);
    const endpointPath = join(parent, "endpoint.json");

    const endpoint = { ...metadata, tokenPath: join(parent, "daemon.token") };
    await publishDaemonEndpoint(endpointPath, endpoint);

    await expect(readDaemonEndpoint(endpointPath)).resolves.toEqual(endpoint);
    expect(await readFile(endpointPath, "utf8")).not.toContain("secret-token");
  });

  it("hardens the published Windows endpoint file after its atomic rename", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-endpoint-acl-"));
    directories.push(parent);
    const endpointPath = join(parent, "daemon.json");
    const hardened: string[] = [];

    await publishDaemonEndpoint(endpointPath, { ...metadata, tokenPath: join(parent, "daemon.token") }, {
      platform: "win32",
      harden: async (path) => { hardened.push(path); },
    });

    expect(hardened).toContain(endpointPath);
  });

  it("rejects endpoint metadata that redirects token reads away from daemon.token", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-token-redirect-"));
    directories.push(parent);
    const endpointPath = join(parent, "daemon.json");
    const attackerTokenPath = join(parent, "attacker.token");
    await writeFile(endpointPath, JSON.stringify({ ...metadata, tokenPath: attackerTokenPath }), "utf8");
    let tokenRead = false;

    await expect(readDaemonEndpoint(endpointPath)).rejects.toThrow(/metadata/i);
    await expect(readAndProbeDaemon(endpointPath, {
      readToken: async () => { tokenRead = true; return "secret"; },
    })).resolves.toBeNull();
    expect(tokenRead).toBe(false);
  });

  it("arbitrates one owner and releases the lock", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-lock-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");

    const first = await acquireDaemonLock(lockPath);
    await expect(acquireDaemonLock(lockPath)).resolves.toBeNull();
    await first.release();
    const second = await acquireDaemonLock(lockPath);
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("recovers a startup lock owned by a dead process", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-stale-lock-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");
    await writeFile(lockPath, "2147483647\n", "utf8");

    const lock = await acquireDaemonLock(lockPath);

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("hardens a newly acquired Windows lock file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-lock-acl-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");
    const hardened: string[] = [];

    const lock = await acquireDaemonLock(lockPath, () => false, {
      platform: "win32",
      harden: async (path) => { hardened.push(path); },
    });

    expect(hardened).toContain(lockPath);
    await lock?.release();
  });

  it("closes the lock file handle when Windows hardening fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-lock-failure-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");

    await expect(acquireDaemonLock(lockPath, () => false, {
      platform: "win32",
      harden: async () => { throw new Error("ACL failure"); },
    })).rejects.toThrow("ACL failure");

    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a lock that replaces the initially observed stale lock", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-stale-race-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");
    await writeFile(lockPath, `${JSON.stringify({ pid: 2147483647, nonce: "stale" })}\n`, "utf8");

    const lock = await acquireDaemonLock(lockPath, () => false, {
      afterStaleRead: async () => {
        await rm(lockPath);
        await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce: "replacement" })}\n`, "utf8");
      },
    });

    expect(lock).toBeNull();
    expect(await readFile(lockPath, "utf8")).toContain("replacement");
  });

  it("binds the startup lock to a nonce that a child must present", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-nonce-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");
    const lock = await acquireDaemonLock(lockPath);

    expect(lock).not.toBeNull();
    expect(lock && "nonce" in lock).toBe(true);
    await expect(verifyDaemonLock(lockPath, "wrong", process.pid)).resolves.toBe(false);
    await expect(verifyDaemonLock(lockPath, (lock as { nonce: string }).nonce, process.pid)).resolves.toBe(true);
    await lock?.release();
  });

  it("does not validate or remove a lock replaced by another instance", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-lock-race-"));
    directories.push(parent);
    const lockPath = join(parent, "daemon.lock");
    const lock = await acquireDaemonLock(lockPath);
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce: "replacement" })}\n`, "utf8");

    await expect(verifyDaemonLock(lockPath, lock?.nonce ?? "", process.pid)).resolves.toBe(false);
    await lock?.release();
    expect(await readFile(lockPath, "utf8")).toContain("replacement");
  });

  it("does not allow a managed child without an ownership handoff", async () => {
    const spawned: string[] = [];
    await expect(verifyDaemonLock("missing.lock", "rogue-env-only")).resolves.toBe(false);
    expect(spawned).toEqual([]);
  });

  it("cleans only state owned by the matching live instance", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-cleanup-"));
    directories.push(parent);
    const endpointPath = join(parent, "endpoint.json");
    const ownedMetadata = { ...metadata, pid: process.pid, tokenPath: join(parent, "daemon.token") };
    await publishDaemonEndpoint(endpointPath, ownedMetadata);

    const lock = await acquireDaemonLock(join(parent, "daemon.lock"));
    await cleanupDaemonState({ endpointPath, tokenPath: ownedMetadata.tokenPath, lockPath: join(parent, "daemon.lock"), lockNonce: lock?.nonce ?? "", pid: process.pid, instanceId: metadata.instanceId, isProcessAlive: () => true });
    await expect(readDaemonEndpoint(endpointPath)).resolves.toEqual(ownedMetadata);
    await cleanupDaemonState({ endpointPath, tokenPath: ownedMetadata.tokenPath, lockPath: join(parent, "daemon.lock"), lockNonce: lock?.nonce ?? "", pid: process.pid, instanceId: metadata.instanceId, isProcessAlive: () => false });
    await expect(readDaemonEndpoint(endpointPath)).rejects.toThrow();
  });

  it("does not clean stale state unless it acquires and still proves the startup lock", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-clean-lock-"));
    directories.push(parent);
    const paths = endpointPaths(parent);
    await writeFile(paths.endpointPath, JSON.stringify({ ...metadata, tokenPath: paths.tokenPath }), "utf8");
    await writeFile(paths.tokenPath, "secret", "utf8");
    await writeFile(paths.lockPath, `${JSON.stringify({ pid: process.pid, nonce: "new-owner" })}\n`, "utf8");

    await expect(removeStaleDaemonState({ ...paths, expectedTokenPath: paths.tokenPath, isProcessAlive: () => false, acquireLock: async () => null })).resolves.toBe(false);
    await expect(access(paths.endpointPath)).resolves.toBeUndefined();
    await expect(access(paths.tokenPath)).resolves.toBeUndefined();
    expect(await readFile(paths.lockPath, "utf8")).toContain("new-owner");
  });

  it("refuses stale cleanup when endpoint and lock ownership do not match", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-owner-mismatch-"));
    directories.push(parent);
    const paths = endpointPaths(parent);
    await writeFile(paths.endpointPath, JSON.stringify({ ...metadata, tokenPath: paths.tokenPath }), "utf8");
    await writeFile(paths.tokenPath, "secret", "utf8");
    await writeFile(paths.lockPath, `${JSON.stringify({ pid: metadata.pid, nonce: "different-lock" })}\n`, "utf8");

    await expect(removeStaleDaemonState({ ...paths, expectedTokenPath: paths.tokenPath, isProcessAlive: () => false })).resolves.toBe(false);
    await expect(access(paths.endpointPath)).resolves.toBeUndefined();
    await expect(access(paths.tokenPath)).resolves.toBeUndefined();
    expect(await readFile(paths.lockPath, "utf8")).toContain("different-lock");
  });

  it("does not unlink malformed endpoint metadata without ownership proof", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-lifecycle-malformed-"));
    directories.push(parent);
    const paths = endpointPaths(parent);
    await writeFile(paths.endpointPath, "not-json", "utf8");

    await expect(removeStaleDaemonState({ ...paths, expectedTokenPath: paths.tokenPath, isProcessAlive: () => false })).resolves.toBe(false);
    await expect(readFile(paths.endpointPath, "utf8")).resolves.toBe("not-json");
  });

  it("authenticates readiness probes and rejects an endpoint with the wrong token", async () => {
    const calls: string[] = [];
    const client = {
      async connect(endpoint: unknown, token: string) {
        calls.push(`${JSON.stringify(endpoint)}:${token}`);
      },
      async disconnect() { calls.push("disconnect"); },
    };

    await expect(probeDaemon(metadata, "secret", {
      createClient: () => client,
      readToken: async () => "secret",
    })).resolves.toBe(true);
    await expect(probeDaemon(metadata, "wrong", {
      createClient: () => client,
      readToken: async () => "secret",
    })).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("waits only a bounded number of readiness attempts", async () => {
    let attempts = 0;
    await expect(waitForDaemon("endpoint.json", {
      readEndpoint: async () => metadata,
      readToken: async () => "secret",
      probe: async () => { attempts += 1; return false; },
      sleep: async () => undefined,
      maxAttempts: 3,
    })).rejects.toThrow("Daemon did not become ready");
    expect(attempts).toBe(3);
  });

  it("starts one child when the endpoint is absent and marks only that child as owned", async () => {
    const spawned: string[] = [];
    const child = { pid: 4321, kill: () => { spawned.push("kill"); } };
    const result = await ensureDaemon("endpoint.json", {
      readEndpoint: async () => { throw new Error("missing"); },
      acquireLock: async () => ({ release: async () => { spawned.push("release"); } }),
      spawn: () => { spawned.push("spawn"); return child; },
      waitForReady: async () => metadata,
    });
    expect(result).toMatchObject({ endpoint: metadata, owned: true, child });
    expect(spawned).toEqual(["spawn"]);
  });

  it("reuses a ready daemon without acquiring a lock or owning shutdown", async () => {
    const result = await ensureDaemon("endpoint.json", {
      readEndpoint: async () => metadata,
      probe: async () => true,
      acquireLock: async () => { throw new Error("must not lock"); },
      spawn: () => { throw new Error("must not spawn"); },
    });
    expect(result).toEqual({ endpoint: metadata, owned: false, child: undefined });
  });

  it("stops and unlocks only a daemon owned by this launcher", async () => {
    const calls: string[] = [];
    const child = { pid: 4321, kill: (signal?: NodeJS.Signals) => { calls.push(`kill:${signal}`); return true; } };
    await stopOwnedDaemon({ endpoint: metadata, owned: false, child });
    await stopOwnedDaemon({
      endpoint: metadata,
      owned: true,
      child,
      lock: { release: async () => { calls.push("release"); } },
    });
    expect(calls).toEqual(["kill:SIGTERM", "release"]);
  });

  it("derives all runtime paths beneath the supplied private runtime directory", () => {
    const paths = endpointPaths("C:/private/orrery/runtime");
    expect(paths.endpointPath).toMatch(/daemon\.json$/);
    expect(paths.tokenPath).toMatch(/daemon\.token$/);
    expect(paths.lockPath).toMatch(/daemon\.lock$/);
  });
});
