import { access, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonToken, createDaemonTokenFile, hardenPrivatePath, verifyDaemonToken } from "./auth";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("daemon authentication", () => {
  it("creates fixed-length hexadecimal capability tokens and verifies exact matches", () => {
    const token = createDaemonToken();
    const differentToken = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDaemonToken(token, token)).toBe(true);
    expect(verifyDaemonToken(differentToken, token)).toBe(false);
  });

  it("rejects candidates with the wrong length or encoding", () => {
    const token = createDaemonToken();

    expect(verifyDaemonToken(token.slice(2), token)).toBe(false);
    expect(verifyDaemonToken("g".repeat(64), token)).toBe(false);
    expect(verifyDaemonToken("00", "not-an-expected-token")).toBe(false);
  });

  it("writes a private token file without returning it through endpoint metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-auth-"));
    directories.push(directory);
    const tokenPath = join(directory, "daemon.token");

    const token = await createDaemonTokenFile(tokenPath);

    await expect(access(tokenPath)).resolves.toBeUndefined();
    expect(await readFile(tokenPath, "utf8")).toBe(token);
    if (process.platform !== "win32") {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("hardens a Windows token file and rejects a reparse token path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-auth-windows-"));
    directories.push(directory);
    const tokenPath = join(directory, "daemon.token");
    const hardened: string[] = [];

    await createDaemonTokenFile(tokenPath, {
      platform: "win32",
      harden: async (path) => { hardened.push(path); },
    });
    expect(hardened).toEqual([tokenPath]);

  });

  it("refuses to replace an existing token path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-auth-existing-"));
    directories.push(directory);
    const tokenPath = join(directory, "daemon.token");
    await writeFile(tokenPath, "existing", "utf8");

    await expect(createDaemonTokenFile(tokenPath)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(tokenPath, "utf8")).toBe("existing");
  });

  it.runIf(process.platform !== "win32")("does not follow an existing token symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-daemon-auth-symlink-"));
    directories.push(directory);
    const targetPath = join(directory, "target");
    const tokenPath = join(directory, "daemon.token");
    await writeFile(targetPath, "target contents", "utf8");
    await symlink(targetPath, tokenPath);

    await expect(createDaemonTokenFile(tokenPath)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(targetPath, "utf8")).toBe("target contents");
  });

  it("fails closed when Windows ACL hardening cannot be verified", async () => {
    await expect(hardenPrivatePath("C:\\orrery-runtime", "win32", async (file) => {
      if (file === "whoami") return { stdout: "user", stderr: "" };
      throw new Error("icacls failed");
    }))
      .rejects.toThrow(/ACL/i);
  });

  it("removes and rejects pre-existing explicit identities instead of accepting a name match", async () => {
    const calls: string[][] = [];
    const outputs = [
      { stdout: "processed", stderr: "" },
      { stdout: "processed", stderr: "" },
      { stdout: " BUILTIN\\Users:(R)", stderr: "" },
      { stdout: "processed", stderr: "" },
      { stdout: "processed", stderr: "" },
      { stdout: "C:\\orrery-runtime user:(F)\n             SYSTEM:(F)", stderr: "" },
    ];
    await expect(hardenPrivatePath("C:\\orrery-runtime", "win32", async (file, args) => {
      calls.push([file, ...args]);
      if (file === "whoami") return { stdout: "user", stderr: "" };
      return outputs.shift() ?? { stdout: "", stderr: "" };
    })).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["whoami"]);
    expect(calls.some((call) => call.includes("/remove:g") && call.includes("BUILTIN\\Users"))).toBe(true);
  });

  it("tolerates error 1332 while removing a stale allow ACE when exact ACL verification succeeds", async () => {
    const calls: string[][] = [];
    const staleSid = "S-1-5-21-111-222-333-1001";

    await expect(hardenPrivatePath("C:\\orrery-runtime", "win32", async (file, args) => {
      calls.push([file, ...args]);
      if (file === "whoami") return { stdout: "user", stderr: "" };
      if (args[1] === "/remove:g" && args[2] === staleSid) {
        throw Object.assign(new Error("No mapping between account names and security IDs was done."), {
          code: 1332,
          stdout: "",
          stderr: "No mapping between account names and security IDs was done.",
        });
      }
      if (args.length === 1 && calls.filter((call) => call[0] === "icacls" && call.length === 2).length === 1) {
        return { stdout: `C:\\orrery-runtime ${staleSid}:(F)`, stderr: "" };
      }
      if (args.length === 1) return { stdout: "C:\\orrery-runtime user:(F)\n             SYSTEM:(F)", stderr: "" };
      return { stdout: "processed", stderr: "" };
    })).resolves.toBeUndefined();

    expect(calls).toContainEqual(["icacls", "C:\\orrery-runtime", "/remove:g", staleSid]);
  });

  it("rejects arbitrary errors while removing an unrelated ACE", async () => {
    await expect(hardenPrivatePath("C:\\orrery-runtime", "win32", async (file, args) => {
      if (file === "whoami") return { stdout: "user", stderr: "" };
      if (args.length === 1) return { stdout: "C:\\orrery-runtime BUILTIN\\Users:(R)", stderr: "" };
      if (args[1] === "/remove" || args[1] === "/remove:g") {
        throw Object.assign(new Error("Access is denied."), { code: 5 });
      }
      return { stdout: "processed", stderr: "" };
    })).rejects.toThrow(/ACL/i);
  });

  it("rejects an ACL that still contains an unrelated explicit ACE", async () => {
    const output = "processed";
    await expect(hardenPrivatePath("C:\\orrery-runtime", "win32", async (file) => {
      if (file === "whoami") return { stdout: "user", stderr: "" };
      return { stdout: output, stderr: "" };
    })).rejects.toThrow(/ACL/i);
  });

  it("fails closed when a runtime parent is not private", async () => {
    await expect(hardenPrivatePath("C:\\Users\\user\\AppData\\Local\\Orrery\\runtime", "win32", async (file, args) => {
      if (file === "whoami") return { stdout: "user", stderr: "" };
      return { stdout: " BUILTIN\\Users:(M)", stderr: "" };
    })).rejects.toThrow(/parent|ACL/i);
  });
});
