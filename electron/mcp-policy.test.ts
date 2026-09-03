import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertServerInput, classifyToolRisk, effectiveRisk, maximumRisk, normalizeExecutableName, McpPolicyStore, requiresConsentEveryTime, MAX_SERVERS, type McpToolRecord } from "./mcp-policy";

let runtime: string;
const harden = vi.fn(async () => undefined);
const store = () => new McpPolicyStore(runtime, "linux", harden);

const tool = (name: string, risk: McpToolRecord["risk"] = "read"): McpToolRecord =>
  ({ name, title: name, description: `${name} tool`, risk, inputSchema: { type: "object" } });

const stdioServer = { serverId: "files", label: "Files", transport: "stdio" as const, command: "/usr/bin/mcp-files", args: ["--root", "/tmp"] };

beforeEach(async () => {
  runtime = await mkdtemp(join(tmpdir(), "orrery-mcp-"));
  harden.mockClear();
});
afterEach(async () => {
  await rm(runtime, { recursive: true, force: true });
});

describe("MCP policy store", () => {
  it("registers a server and redacts its command to a basename for the renderer", async () => {
    const catalog = await store().registerServer(stdioServer);
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0].origin).toBe("mcp-files");
    expect(JSON.stringify(catalog)).not.toContain("/usr/bin");
    expect(JSON.stringify(catalog)).not.toContain("--root");
  });

  it("redacts an http endpoint to its host", async () => {
    const catalog = await store().registerServer({ serverId: "remote", label: "Remote", transport: "http", endpoint: "https://tools.example.com/mcp?key=secret" });
    expect(catalog.servers[0].origin).toBe("tools.example.com");
    expect(JSON.stringify(catalog)).not.toContain("secret");
    expect(JSON.stringify(catalog)).not.toContain("/mcp");
  });

  it("classifies a tool's worst-case effect, defaulting to write when ambiguous", () => {
    expect(classifyToolRisk({ name: "read_file" })).toBe("read");
    expect(classifyToolRisk({ name: "list_issues" })).toBe("read");
    expect(classifyToolRisk({ name: "write_file" })).toBe("write");
    expect(classifyToolRisk({ name: "delete_branch" })).toBe("destructive");
    expect(classifyToolRisk({ name: "send_email" })).toBe("network");
    expect(classifyToolRisk({ name: "charge_card" })).toBe("spend");
    // An opaque name is treated as a write, never as a read.
    expect(classifyToolRisk({ name: "frobnicate" })).toBe("write");
    expect(classifyToolRisk({ name: "do_thing", description: "Does a thing." })).toBe("write");
  });

  it("lets a server raise its own risk through annotations but never lower it", () => {
    expect(classifyToolRisk({ name: "read_file", annotations: { destructiveHint: true } })).toBe("destructive");
    expect(classifyToolRisk({ name: "read_file", annotations: { openWorldHint: true } })).toBe("network");
    // A readOnlyHint cannot downgrade a name that clearly deletes.
    expect(classifyToolRisk({ name: "delete_everything", annotations: { readOnlyHint: true } })).toBe("destructive");
    expect(classifyToolRisk({ name: "write_file", annotations: { readOnlyHint: true } })).toBe("write");
    // Nor can it promote an unrecognized name into the remembered-allow-eligible class.
    expect(classifyToolRisk({ name: "frobnicate", annotations: { readOnlyHint: true } })).toBe("write");
    expect(classifyToolRisk({ name: "do_thing", description: "Totally safe.", annotations: { readOnlyHint: true } })).toBe("write");
  });

  it("does not let dangerous verbs slip into the read class", () => {
    // Each of these reaches a side effect, so none may become remembered-allow eligible.
    for (const name of ["fetch_url", "execute_query", "search_and_replace", "query_erase", "run_script", "eval_expression", "clear_cache", "reset_database", "download_report", "http_request", "install_package", "order_item"]) {
      expect(classifyToolRisk({ name })).not.toBe("read");
    }
    // Genuinely read-only signatures still qualify.
    for (const name of ["read_file", "list_issues", "get_status", "describe_table", "count_rows", "show_diff"]) {
      expect(classifyToolRisk({ name })).toBe("read");
    }
  });

  it("takes the more dangerous of a stored and a freshly derived risk", () => {
    expect(maximumRisk("read", "destructive")).toBe("destructive");
    expect(maximumRisk("destructive", "read")).toBe("destructive");
    expect(maximumRisk("write", "network")).toBe("network");
    expect(maximumRisk("read", "read")).toBe("read");
    // A forged stored risk cannot downgrade what the declaration plainly says.
    expect(effectiveRisk({ name: "delete_everything", title: "t", description: "", risk: "read", inputSchema: {} })).toBe("destructive");
  });

  it("refuses to remember consent for risks that must always be confirmed", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file", "read"), tool("write_file", "write"), tool("delete_file", "destructive"), tool("send_it", "network"), tool("buy_it", "spend")]);
    await expect(shared.setDecision("files", "write_file", "allow")).rejects.toThrow(/confirmed every time/);
    await expect(shared.setDecision("files", "delete_file", "allow")).rejects.toThrow(/confirmed every time/);
    await expect(shared.setDecision("files", "send_it", "allow")).rejects.toThrow(/confirmed every time/);
    await expect(shared.setDecision("files", "buy_it", "allow")).rejects.toThrow(/confirmed every time/);
    // A read-only tool may be remembered.
    const catalog = await shared.setDecision("files", "read_file", "allow");
    expect(catalog.tools.find(entry => entry.name === "read_file")?.decision).toBe("allow");
    expect(requiresConsentEveryTime("read")).toBe(false);
  });

  it("never reports a remembered allow for an always-ask tool, even if one is on disk", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("write_file", "write")]);
    // Simulate a tampered policy file granting a standing allow for a write.
    const raw = JSON.parse(await readFile(join(runtime, "mcp-servers.json"), "utf8")) as { servers: Array<{ decisions: Record<string, string> }> };
    raw.servers[0].decisions.write_file = "allow";
    await writeFile(join(runtime, "mcp-servers.json"), JSON.stringify(raw), "utf8");
    const catalog = await shared.readCatalog();
    expect(catalog.tools[0].decision).toBe("ask");
    expect(catalog.tools[0].alwaysAsk).toBe(true);
  });

  it("allows a deny decision for any risk", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("delete_file", "destructive")]);
    const catalog = await shared.setDecision("files", "delete_file", "deny");
    expect(catalog.tools[0].decision).toBe("deny");
  });

  it("drops consent when a tool disappears or its declaration changes", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file", "read"), tool("list_files", "read")]);
    await shared.setDecision("files", "read_file", "allow");
    await shared.setDecision("files", "list_files", "allow");
    // read_file now declares a destructive effect, and list_files is gone.
    const catalog = await shared.replaceTools("files", [tool("read_file", "destructive")]);
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0].decision).toBe("ask");
  });

  it("drops consent when only the description or schema changes", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file", "read")]);
    await shared.setDecision("files", "read_file", "allow");
    // Same name and risk, different meaning: the remembered permission must not carry over.
    const rewritten = { ...tool("read_file", "read"), description: "Reads a file, and also uploads it." };
    const catalog = await shared.replaceTools("files", [rewritten]);
    expect(catalog.tools[0].decision).toBe("ask");
  });

  it("discards tools and consent when a server is re-registered", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file", "read")]);
    await shared.setDecision("files", "read_file", "allow");
    // A changed command must not inherit consent granted to the previous one.
    const catalog = await shared.registerServer({ ...stdioServer, command: "/usr/bin/other" });
    expect(catalog.tools).toHaveLength(0);
    expect(catalog.servers[0].origin).toBe("other");
  });

  it("rejects a stdio server without an absolute command, and cross-transport fields", () => {
    expect(() => assertServerInput({ ...stdioServer, command: "mcp-files" })).toThrow(/absolute path/);
    expect(() => assertServerInput({ ...stdioServer, command: undefined })).toThrow(/requires a command/);
    expect(() => assertServerInput({ ...stdioServer, endpoint: "https://example.com" })).toThrow(/must not declare an endpoint/);
    expect(() => assertServerInput({ serverId: "r", label: "R", transport: "http", endpoint: "https://e.com", command: "/bin/x" })).toThrow(/must not declare a command/);
    expect(assertServerInput({ ...stdioServer, command: "C:\\tools\\mcp.exe" }).command).toBe("C:\\tools\\mcp.exe");
  });

  it("rejects an http endpoint that is not https or loopback http", () => {
    expect(() => assertServerInput({ serverId: "r", label: "R", transport: "http", endpoint: "http://evil.example.com/mcp" })).toThrow(/https/);
    expect(() => assertServerInput({ serverId: "r", label: "R", transport: "http", endpoint: "https://user:pw@e.com/mcp" })).toThrow(/credentials/);
    expect(assertServerInput({ serverId: "r", label: "R", transport: "http", endpoint: "http://127.0.0.1:3000/mcp" }).endpoint).toContain("127.0.0.1");
  });

  it("rejects prototype-bearing server and tool identifiers", async () => {
    expect(() => assertServerInput({ ...stdioServer, serverId: "__proto__" })).toThrow(/identifier is invalid/);
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file")]);
    await expect(shared.setDecision("files", "__proto__", "allow")).rejects.toThrow(/Unsupported tool name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores a prototype-poisoned policy file", async () => {
    await writeFile(join(runtime, "mcp-servers.json"), JSON.stringify({ version: 1, servers: [{ ...stdioServer, enabled: true, registeredAt: "now", tools: [], decisions: { __proto__: { polluted: true } } }] }), "utf8");
    const shared = store();
    await shared.replaceTools("files", [tool("read_file")]);
    const written = await readFile(join(runtime, "mcp-servers.json"), "utf8");
    expect(written).not.toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("resolves the name Windows will actually execute before matching the denylist", () => {
    // Windows discards trailing dots and spaces, so these all launch cmd.exe.
    expect(normalizeExecutableName("C:\\Windows\\System32\\cmd.exe.")).toBe("cmd.exe");
    expect(normalizeExecutableName("C:\\Windows\\System32\\cmd.exe..")).toBe("cmd.exe");
    expect(normalizeExecutableName("C:\\Windows\\System32\\cmd.exe ")).toBe("cmd.exe");
    expect(normalizeExecutableName("/usr/bin/mcp-files")).toBe("mcp-files");
    expect(normalizeExecutableName("C:/tools/MCP.EXE")).toBe("mcp.exe");
  });

  it("refuses an interpreter disguised by trailing dots, spaces, or a forward-slash UNC path", () => {
    for (const command of [
      "C:\\Windows\\System32\\cmd.exe.",
      "C:\\Windows\\System32\\cmd.exe..",
      "C:\\Windows\\System32\\cmd.exe ",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe.",
      "C:\\tools\\payload.ps1.",
      "C:/Windows/System32/cmd.exe",
    ]) {
      expect(() => assertServerInput({ ...stdioServer, command })).toThrow(/cannot be registered/);
    }
    // Both separator forms denote a UNC path.
    expect(() => assertServerInput({ ...stdioServer, command: "\\\\attacker\\share\\payload.exe" })).toThrow(/local path/);
    expect(() => assertServerInput({ ...stdioServer, command: "//attacker/share/payload.exe" })).toThrow(/local path/);
  });

  it("refuses control characters in a command or argument, which spawn would echo back with the path", () => {
    expect(() => assertServerInput({ ...stdioServer, command: "C:\\tools\\a\u0000b.exe" })).toThrow(/invalid characters/);
    expect(() => assertServerInput({ ...stdioServer, command: "C:\\tools\\a\nb.exe" })).toThrow(/invalid characters/);
    expect(() => assertServerInput({ ...stdioServer, args: ["ok", "bad\u0000"] })).toThrow(/argument vector is invalid/);
  });

  it("bounds the number of registered servers", async () => {
    const shared = store();
    for (let index = 0; index < MAX_SERVERS; index += 1) {
      await shared.registerServer({ ...stdioServer, serverId: `s-${index}` });
    }
    await expect(shared.registerServer({ ...stdioServer, serverId: "overflow" })).rejects.toThrow(/Too many/);
    // Re-registering an existing server is still allowed at the limit.
    await expect(shared.registerServer({ ...stdioServer, serverId: "s-0" })).resolves.toBeDefined();
  });

  it("records an ordered audit entry for every outcome", async () => {
    const shared = store();
    await shared.appendActivity({ serverId: "files", name: "read_file", risk: "read", outcome: "allowed" });
    await shared.appendActivity({ serverId: "files", name: "write_file", risk: "write", outcome: "denied", reason: "Cancelled by the operator." });
    await shared.appendActivity({ serverId: "files", name: "write_file", risk: "write", outcome: "failed", reason: "boom" });
    const entries = await shared.readActivity();
    expect(entries.map(entry => entry.sequence)).toEqual([1, 2, 3]);
    expect(entries.map(entry => entry.outcome)).toEqual(["allowed", "denied", "failed"]);
  });

  it("serializes concurrent writes without dropping an audit entry", async () => {
    const shared = store();
    await Promise.all([
      shared.appendActivity({ serverId: "a", name: "t", risk: "read", outcome: "allowed" }),
      shared.appendActivity({ serverId: "b", name: "t", risk: "read", outcome: "allowed" }),
      shared.appendActivity({ serverId: "c", name: "t", risk: "read", outcome: "allowed" }),
    ]);
    expect((await shared.readActivity()).map(entry => entry.sequence)).toEqual([1, 2, 3]);
  });

  it("refuses a policy file that is a symlink or oversized", async () => {
    await writeFile(join(runtime, "mcp-activity.json"), "x".repeat(4 * 1024 * 1024 + 1), "utf8");
    await expect(store().readActivity()).rejects.toThrow(/exceeds the supported size/);
  });

  it("hardens both the temporary file and the final file on Windows", async () => {
    const windows = new McpPolicyStore(runtime, "win32", harden);
    await windows.registerServer(stdioServer);
    expect(harden.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a decision for an unknown server or tool", async () => {
    const shared = store();
    await expect(shared.setDecision("missing", "t", "allow")).rejects.toThrow(/Unknown server/);
    await shared.registerServer(stdioServer);
    await expect(shared.setDecision("files", "missing", "allow")).rejects.toThrow(/Unknown tool/);
    await expect(shared.setDecision("files", "t", "maybe" as never)).rejects.toThrow(/Unsupported decision/);
  });

  it("removes a server and its tools", async () => {
    const shared = store();
    await shared.registerServer(stdioServer);
    await shared.replaceTools("files", [tool("read_file")]);
    const catalog = await shared.removeServer("files");
    expect(catalog.servers).toHaveLength(0);
    expect(catalog.tools).toHaveLength(0);
  });
});
