import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);

export function createDaemonToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function verifyDaemonToken(candidate: string, expected: string): boolean {
  if (!TOKEN_PATTERN.test(candidate) || !TOKEN_PATTERN.test(expected)) return false;
  const candidateBytes = Buffer.from(candidate, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (candidateBytes.length !== TOKEN_BYTES || expectedBytes.length !== TOKEN_BYTES) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

export async function createDaemonTokenFile(tokenPath: string, options: {
  platform?: NodeJS.Platform;
  harden?: (path: string, platform?: NodeJS.Platform) => Promise<void>;
} = {}): Promise<string> {
  const metadata = await lstat(tokenPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (metadata?.isSymbolicLink()) throw new Error("Daemon token path must not be a reparse point.");
  const token = createDaemonToken();
  const file = await open(tokenPath, "wx", 0o600);
  try {
    await file.writeFile(token, "utf8");
  } finally {
    await file.close();
  }
  await chmod(tokenPath, 0o600);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") await (options.harden ?? hardenPrivatePath)(tokenPath, "win32");
  return token;
}

export async function hardenPrivatePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = async (file, args) => execFileAsync(file, args),
): Promise<void> {
  if (platform !== "win32") return;
  try {
    const identity = (await run("whoami", [])).stdout.trim();
    if (!identity) throw new Error("Unable to determine current Windows identity.");
    const allowed = new Set([identity.toLowerCase(), "system", "nt authority\\system"]);
    await run("icacls", [path, "/reset"]);
    await run("icacls", [path, "/inheritance:r"]);
    const inherited = await run("icacls", [path]);
    for (const entry of parseAclEntries(`${inherited.stdout}\n${inherited.stderr}`)) {
      if (allowed.has(entry.identity.toLowerCase())) continue;
      const removeMode = entry.permissions.includes("(DENY)") ? "/remove" : "/remove:g";
      try {
        await run("icacls", [path, removeMode, entry.identity]);
      } catch (error) {
        if (!isUnresolvedIdentityRemovalError(error)) throw error;
      }
    }
    await run("icacls", [path, "/grant:r", `${identity}:F`, "SYSTEM:F"]);
    const result = await run("icacls", [path]);
    assertPrivateAcl(`${result.stdout}\n${result.stderr}`, allowed);
  } catch (error) {
    throw new Error(`Unable to apply or verify private ACL for ${path}.`, { cause: error });
  }
}

function parseAclEntries(output: string): Array<{ identity: string; permissions: string }> {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/(?:^|\s)([^:\r\n]+):\s*((?:\([^)]+\))+)(?:\s|$)/);
    return match ? [{ identity: match[1].trim(), permissions: match[2] }] : [];
  });
}

function assertPrivateAcl(output: string, allowed: Set<string>): void {
  const entries = parseAclEntries(output);
  if (entries.length !== 2 || entries.some((entry) => !allowed.has(entry.identity.toLowerCase()) || entry.permissions !== "(F)")) {
    throw new Error("icacls did not verify the exact private ACL allowlist.");
  }
}

function isUnresolvedIdentityRemovalError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: unknown; message?: unknown; stderr?: unknown; stdout?: unknown };
  if (details.code === 1332 || details.code === "1332") return true;
  return [details.message, details.stderr, details.stdout].some(
    (value) => typeof value === "string" && (/\b1332\b/.test(value) || /no mapping between account names and security IDs/i.test(value)),
  );
}
