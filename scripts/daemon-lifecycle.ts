import { chmod, lstat, mkdir, open, readFile, rm, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, win32 as win32Path } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { MissionControlClient, TcpLineTransport } from "@orrery/mission-control-client";
import { hardenPrivatePath } from "../packages/mission-control-daemon/src/auth";

export interface DaemonEndpointMetadata {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly protocol: string;
  readonly tokenPath: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly lockNonce?: string;
  readonly approvalKeyFingerprint?: string;
}

export interface RuntimeDirectoryOptions {
  baseDirectory?: string;
  localAppData?: string;
  platform?: NodeJS.Platform;
  harden?: (path: string, platform?: NodeJS.Platform) => Promise<void>;
}

const DEFAULT_RUNTIME = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Orrery", "runtime");
const DEFAULT_READY_ATTEMPTS = 50;
const DEFAULT_READY_DELAY_MS = 100;

export function endpointPaths(runtimeDirectory: string): { endpointPath: string; tokenPath: string; lockPath: string } {
  return {
    endpointPath: join(runtimeDirectory, "daemon.json"),
    tokenPath: join(runtimeDirectory, "daemon.token"),
    lockPath: join(runtimeDirectory, "daemon.lock"),
  };
}

export async function createRuntimeDirectory(options: RuntimeDirectoryOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const runtime = options.baseDirectory ? join(options.baseDirectory, "runtime") : DEFAULT_RUNTIME;
  let trustedRoot: string | undefined;
  if (platform === "win32") {
    trustedRoot = win32Path.resolve(options.localAppData ?? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"));
    const relative = win32Path.relative(trustedRoot, win32Path.resolve(runtime));
    if (relative.startsWith("..") || win32Path.isAbsolute(relative)) {
      throw new Error("Windows private runtime must be beneath trusted per-user LOCALAPPDATA.");
    }
  }
  if (platform === "win32") {
    await ensureRealAncestry(trustedRoot as string, win32Path.resolve(runtime));
    const appRoot = dirname(win32Path.resolve(runtime));
    await mkdir(appRoot, { recursive: true, mode: 0o700 });
    await ensureRealDirectory(appRoot);
    await (options.harden ?? hardenPrivatePath)(appRoot, platform);
  }
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  if (platform === "win32") await ensureRealDirectory(runtime);
  if (platform !== "win32") await chmod(runtime, 0o700);
  if (options.harden) await options.harden(runtime, options.platform);
  else if (platform === "win32") await hardenPrivatePath(runtime, "win32");
  return runtime;
}

export async function publishDaemonEndpoint(path: string, endpoint: DaemonEndpointMetadata, options: {
  platform?: NodeJS.Platform;
  harden?: (path: string, platform?: NodeJS.Platform) => Promise<void>;
} = {}): Promise<void> {
  if (endpoint.tokenPath !== join(dirname(path), "daemon.token")) throw new Error("Daemon endpoint token path must match the expected runtime token path.");
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(endpoint)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") await (options.harden ?? hardenPrivatePath)(temporary, "win32");
  await rename(temporary, path);
  if (platform !== "win32") await chmod(path, 0o600);
  else await (options.harden ?? hardenPrivatePath)(path, "win32");
}

export async function readDaemonEndpoint(path: string): Promise<DaemonEndpointMetadata> {
  const value: unknown = JSON.parse(await readPrivateStateFile(path));
  if (!value || typeof value !== "object") throw new Error("Invalid daemon endpoint metadata.");
  const endpoint = value as Partial<DaemonEndpointMetadata>;
  const expectedTokenPath = join(dirname(path), "daemon.token");
  if ((endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") || typeof endpoint.port !== "number" || !Number.isInteger(endpoint.port) || endpoint.port <= 0 ||
      typeof endpoint.protocol !== "string" || typeof endpoint.tokenPath !== "string" || typeof endpoint.pid !== "number" || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0 ||
      typeof endpoint.instanceId !== "string" || !endpoint.instanceId || endpoint.tokenPath !== expectedTokenPath ||
      (endpoint.lockNonce !== undefined && (typeof endpoint.lockNonce !== "string" || !endpoint.lockNonce)) ||
      (endpoint.approvalKeyFingerprint !== undefined && (typeof endpoint.approvalKeyFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(endpoint.approvalKeyFingerprint)))) throw new Error("Invalid daemon endpoint metadata.");
  return Object.freeze(endpoint as DaemonEndpointMetadata);
}

export interface DaemonLock {
  readonly nonce: string;
  verify(nonce: string): Promise<boolean>;
  release(): Promise<void>;
}

export async function verifyDaemonLock(path: string, nonce: string, ownerPid = process.ppid): Promise<boolean> {
  try {
    const record = JSON.parse(await readPrivateStateFile(path)) as { pid?: number; nonce?: string };
    return record.pid === ownerPid && record.nonce === nonce;
  } catch { return false; }
}

export function registerDaemonCleanup(cleanup: () => Promise<void> | void): () => void {
  let active = true;
  const run = () => {
    if (!active) return;
    active = false;
    void cleanup();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  signals.forEach((signal) => process.once(signal, run));
  process.once("beforeExit", run);
  return () => {
    if (!active) return;
    active = false;
    signals.forEach((signal) => process.off(signal, run));
    process.off("beforeExit", run);
  };
}

export async function acquireDaemonLock(path: string, alive: (pid: number) => boolean = isProcessAlive, options: {
  platform?: NodeJS.Platform;
  harden?: (path: string, platform?: NodeJS.Platform) => Promise<void>;
  afterStaleRead?: () => Promise<void>;
} = {}): Promise<DaemonLock | null> {
  let handle: FileHandle;
  try { handle = await open(path, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const raw = (await readPrivateStateFile(path)).trim();
      const record = raw.startsWith("{") ? JSON.parse(raw) as { pid?: number } : undefined;
      const owner = record?.pid ?? Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(owner) || owner <= 0 || alive(owner)) return null;
      await options.afterStaleRead?.();
      const abandoned = `${path}.abandoned-${randomBytes(16).toString("hex")}`;
      await rename(path, abandoned);
      try {
        const current = await readPrivateStateFile(abandoned);
        if (current !== `${raw}\n` && current.trim() !== raw) {
          await rename(abandoned, path);
          return null;
        }
        handle = await open(path, "wx", 0o600);
        await rm(abandoned, { force: true });
      } catch (error) {
        await rename(abandoned, path).catch(() => undefined);
        throw error;
      }
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw retryError;
    }
  }
  const nonce = randomBytes(32).toString("hex");
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce })}\n`, "utf8");
    const platform = options.platform ?? process.platform;
    if (platform === "win32") await (options.harden ?? hardenPrivatePath)(path, "win32");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    nonce,
    verify: async (candidate) => {
      try {
        const record = JSON.parse(await readPrivateStateFile(path)) as { pid?: number; nonce?: string };
        return record.pid === process.pid && record.nonce === candidate;
      } catch { return false; }
    },
    release: async () => {
      await handle.close();
      try {
        const record = JSON.parse(await readPrivateStateFile(path)) as { pid?: number; nonce?: string };
        if (record.pid === process.pid && record.nonce === nonce) await rm(path, { force: true });
      } catch { /* already removed or replaced */ }
    },
  };
}

export async function cleanupDaemonState(options: {
  endpointPath: string;
  tokenPath: string;
  lockPath: string;
  lockNonce: string;
  pid: number;
  instanceId: string;
  isProcessAlive: (pid: number) => boolean;
}): Promise<void> {
  let endpoint: DaemonEndpointMetadata;
  try { endpoint = await readDaemonEndpoint(options.endpointPath); } catch { return; }
  if (endpoint.pid !== options.pid || endpoint.instanceId !== options.instanceId || endpoint.tokenPath !== join(dirname(options.endpointPath), "daemon.token") ||
      options.tokenPath !== endpoint.tokenPath || options.isProcessAlive(endpoint.pid) || !(await verifyDaemonLock(options.lockPath, options.lockNonce, options.pid))) return;
  const current = await readDaemonEndpoint(options.endpointPath).catch(() => undefined);
  if (!current || current.pid !== options.pid || current.instanceId !== options.instanceId || current.tokenPath !== endpoint.tokenPath) return;
  await rm(options.endpointPath, { force: true });
  await rm(endpoint.tokenPath, { force: true });
}

interface ProbeClient {
  connect(endpoint: { host: string; port: number; version: string }, token: string): Promise<void>;
  disconnect(): Promise<void>;
}

export async function probeDaemon(
  endpoint: DaemonEndpointMetadata,
  token: string,
  dependencies: {
    createClient?: () => ProbeClient;
    readToken?: (path: string) => Promise<string>;
  } = {},
): Promise<boolean> {
  const client = dependencies.createClient?.() ?? new MissionControlClient(new TcpLineTransport());
  try {
    const storedToken = dependencies.readToken ? (await dependencies.readToken(endpoint.tokenPath)).trim() : token;
    if (storedToken !== token) return false;
    await client.connect({ host: endpoint.host, port: endpoint.port, version: endpoint.protocol }, token);
    return true;
  } catch {
    return false;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function readAndProbeDaemon(
  endpointPath: string,
  dependencies: {
    readEndpoint?: typeof readDaemonEndpoint;
    readToken?: (path: string) => Promise<string>;
    probe?: (endpoint: DaemonEndpointMetadata, token: string) => Promise<boolean>;
  } = {},
): Promise<DaemonEndpointMetadata | null> {
  try {
    const endpoint = await (dependencies.readEndpoint ?? readDaemonEndpoint)(endpointPath);
    const token = (await (dependencies.readToken ?? readPrivateStateFile)(endpoint.tokenPath)).trim();
    return await (dependencies.probe ?? probeDaemon)(endpoint, token) ? endpoint : null;
  } catch {
    return null;
  }
}

export async function waitForDaemon(
  endpointPath: string,
  dependencies: {
    readEndpoint?: typeof readDaemonEndpoint;
    readToken?: (path: string) => Promise<string>;
    probe?: (endpoint: DaemonEndpointMetadata, token: string) => Promise<boolean>;
    sleep?: (milliseconds: number) => Promise<void>;
    maxAttempts?: number;
    delayMs?: number;
  } = {},
): Promise<DaemonEndpointMetadata> {
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < (dependencies.maxAttempts ?? DEFAULT_READY_ATTEMPTS); attempt += 1) {
    try {
      const endpoint = await (dependencies.readEndpoint ?? readDaemonEndpoint)(endpointPath);
      const token = dependencies.readToken
        ? (await dependencies.readToken(endpoint.tokenPath)).trim()
        : (await readPrivateStateFile(endpoint.tokenPath)).trim();
      if (await (dependencies.probe ?? probeDaemon)(endpoint, token)) return endpoint;
    } catch {
      // The daemon publishes metadata only after its authenticated socket is ready.
    }
    await sleep(dependencies.delayMs ?? DEFAULT_READY_DELAY_MS);
  }
  throw new Error("Daemon did not become ready before the startup timeout.");
}

export interface DaemonChild {
  readonly pid?: number;
  readonly bootstrapBinding?: Promise<{ instanceId: string; approvalKeyFingerprint: string }>;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface EnsuredDaemon {
  readonly endpoint: DaemonEndpointMetadata;
  readonly owned: boolean;
  readonly child?: DaemonChild;
  readonly lock?: DaemonLock;
}

export async function ensureDaemon(
  endpointPath: string,
  dependencies: {
    readEndpoint?: typeof readDaemonEndpoint;
    readToken?: (path: string) => Promise<string>;
    probe?: (endpoint: DaemonEndpointMetadata, token?: string) => Promise<boolean>;
    acquireLock: () => Promise<DaemonLock | null>;
    spawn: (handoff?: { nonce: string; lockPath?: string }) => DaemonChild;
    waitForReady?: () => Promise<DaemonEndpointMetadata>;
    signal?: AbortSignal;
  },
): Promise<EnsuredDaemon> {
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  try {
    const endpoint = await (dependencies.readEndpoint ?? readDaemonEndpoint)(endpointPath);
    const token = dependencies.readToken ? (await dependencies.readToken(endpoint.tokenPath)).trim() : undefined;
    if (await (dependencies.probe ?? ((candidate, candidateToken) => probeDaemon(candidate, candidateToken ?? "")))(endpoint, token)) {
      signal?.throwIfAborted();
      return { endpoint, owned: false, child: undefined };
    }
  } catch {
    signal?.throwIfAborted();
    // Missing or invalid metadata proceeds to startup arbitration.
  }

  const lock = await dependencies.acquireLock();
  if (signal?.aborted) {
    await lock?.release();
    signal.throwIfAborted();
  }
  if (!lock) {
    const endpoint = await abortable((dependencies.waitForReady ?? (() => waitForDaemon(endpointPath)))(), signal);
    return { endpoint, owned: false, child: undefined };
  }

  let child: DaemonChild | undefined;
  try {
    child = dependencies.spawn({ nonce: lock.nonce, lockPath: join(dirname(endpointPath), "daemon.lock") });
    signal?.throwIfAborted();
    const endpoint = await abortable((dependencies.waitForReady ?? (() => waitForDaemon(endpointPath)))(), signal);
    if (child.bootstrapBinding) {
      const binding = await abortable(child.bootstrapBinding, signal);
      if (endpoint.instanceId !== binding.instanceId || endpoint.approvalKeyFingerprint !== binding.approvalKeyFingerprint) throw new Error("Managed daemon readiness endpoint does not match its bootstrap challenge.");
    }
    signal?.throwIfAborted();
    return { endpoint, owned: true, child, lock };
  } catch (error) {
    child?.kill("SIGTERM");
    await lock.release();
    throw error;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function stopOwnedDaemon(daemon: EnsuredDaemon, timeoutMs = 2_000): Promise<void> {
  if (!daemon.owned || !daemon.child) return;
  daemon.child.kill("SIGTERM");
  const child = daemon.child as ChildProcess;
  if (typeof child.once === "function" && child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await daemon.lock?.release();
}

export async function removeStaleDaemonState(options: {
  endpointPath: string;
  lockPath: string;
  expectedTokenPath: string;
  isProcessAlive?: (pid: number) => boolean;
  acquireLock?: () => Promise<DaemonLock | null>;
}): Promise<boolean> {
  let endpoint: DaemonEndpointMetadata;
  try {
    endpoint = await readDaemonEndpoint(options.endpointPath);
  } catch {
    return false;
  }
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (alive(endpoint.pid) || endpoint.tokenPath !== options.expectedTokenPath) return false;
  const observedLock = await readLockRecord(options.lockPath);
  if (observedLock && (observedLock.pid !== endpoint.pid || observedLock.nonce !== endpoint.lockNonce)) return false;
  const lock = await (options.acquireLock ?? (() => acquireDaemonLock(options.lockPath, alive)))();
  if (!lock) return false;
  try {
    const current = await readDaemonEndpoint(options.endpointPath).catch(() => undefined);
    if (!current || current.pid !== endpoint.pid || current.instanceId !== endpoint.instanceId || current.tokenPath !== options.expectedTokenPath || alive(current.pid)) return false;
    await rm(options.endpointPath, { force: true });
    await rm(options.expectedTokenPath, { force: true });
  } finally {
    await lock.release();
  }
  return true;
}

async function readLockRecord(path: string): Promise<{ pid: number; nonce?: string } | undefined> {
  try {
    const raw = (await readPrivateStateFile(path)).trim();
    if (!raw.startsWith("{")) {
      const pid = Number.parseInt(raw, 10);
      return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
    }
    const value = JSON.parse(raw) as { pid?: unknown; nonce?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.nonce !== undefined && typeof value.nonce !== "string")) return undefined;
    return { pid: value.pid as number, ...(value.nonce === undefined ? {} : { nonce: value.nonce }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Windows private runtime must use real directories, not reparse points.");
}

export async function readPrivateStateFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Daemon state path must be a real file, not a reparse point.");
  if (process.platform === "win32") await hardenPrivatePath(path, "win32");
  return readFile(path, "utf8");
}

async function ensureRealAncestry(root: string, target: string): Promise<void> {
  const relative = win32Path.relative(root, target);
  const components = relative ? relative.split(win32Path.sep) : [];
  let current = root;
  await ensureRealDirectory(current);
  for (const component of components) {
    current = win32Path.join(current, component);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error("Windows private runtime ancestry contains a reparse point.");
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
