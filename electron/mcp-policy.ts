import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hardenPrivatePath } from "../packages/mission-control-daemon/src/auth";
import { assertLoopbackOrHttps } from "./intelligence-store";
import {
  ALWAYS_ASK_RISKS,
  type McpActivityEntry,
  type McpCatalog,
  type McpServerInput,
  type McpServerStatus,
  type McpToolDecision,
  type McpToolRisk,
  type McpToolStatus,
  type McpTransportKind,
} from "./mcp-contract";

export const MAX_SERVERS = 20;
export const MAX_TOOLS_PER_SERVER = 100;
export const MAX_ACTIVITY_ENTRIES = 200;
export const MAX_TOOL_CONTENT_LENGTH = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const TRANSPORTS: ReadonlyArray<McpTransportKind> = ["stdio", "http"];
const DECISIONS: ReadonlyArray<McpToolDecision> = ["ask", "allow", "deny"];
const RISKS: ReadonlyArray<McpToolRisk> = ["read", "write", "destructive", "network", "spend"];
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** A tool as declared by a server, after Orrery has classified its risk. */
export interface McpToolRecord {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: McpToolRisk;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpServerRecord {
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly endpoint?: string;
  readonly enabled: boolean;
  readonly registeredAt: string;
  readonly tools: ReadonlyArray<McpToolRecord>;
  readonly decisions: Readonly<Record<string, McpToolDecision>>;
}

/**
 * Classifies a tool's worst-case effect from its own declaration.
 *
 * Deliberately pessimistic: an unrecognized tool is treated as `write`, not `read`,
 * so a server cannot obtain silent-allow eligibility by describing itself vaguely.
 * Only an explicit, unambiguous read-only signature earns `read`.
 */
export function classifyToolRisk(tool: { readonly name: string; readonly description?: string; readonly annotations?: Readonly<Record<string, unknown>> }): McpToolRisk {
  const annotations = tool.annotations ?? {};
  // A server may only ever raise its own risk through annotations, never lower it.
  if (annotations.destructiveHint === true) return "destructive";
  if (annotations.openWorldHint === true) return "network";
  const haystack = tokenize(`${tool.name} ${tool.description ?? ""}`);
  if (DESTRUCTIVE.test(haystack)) return "destructive";
  if (SPEND.test(haystack)) return "spend";
  if (NETWORK.test(haystack)) return "network";
  if (WRITE.test(haystack)) return "write";
  // A read keyword is required. `readOnlyHint` alone is a server's self-assertion and
  // is never sufficient, because `read` is the only class eligible to be remembered.
  if (READ.test(haystack)) return "read";
  return "write";
}

const DESTRUCTIVE = /\b(delete|destroy|drop|remove|truncate|purge|wipe|rm|unlink|revoke|erase|clear|reset|overwrite|flush|prune|expire|kill|terminate|format|restore|exec|execute|eval|run|shell|spawn|command)\b/;
const SPEND = /\b(pay|charge|purchase|checkout|invoice|billing|subscribe|transfer|refund|order|buy|bid|payout|wire|credit|debit)\b/;
const NETWORK = /\b(publish|deploy|release|send|post|email|tweet|notify|webhook|upload|push|fetch|http|https|request|download|browse|url|uri|dns|sms|call)\b/;
const WRITE = /\b(write|create|update|edit|patch|modify|set|insert|rename|move|commit|merge|replace|apply|sync|import|install|grant|chmod|chown|add|append|put|upsert|save)\b/;
const READ = /\b(read|get|list|search|find|query|show|describe|inspect|view|status|count|stat|head|diff|log)\b/;

/**
 * Splits identifiers into words so pattern matching is not defeated by naming style.
 * A regex word boundary does not fire between "delete" and "_", so `delete_file`
 * would otherwise escape the destructive patterns entirely.
 */
function tokenize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase();
}

/** Ordering from least to most dangerous, for taking the maximum of two classifications. */
const RISK_ORDER: ReadonlyArray<McpToolRisk> = ["read", "write", "network", "spend", "destructive"];

/**
 * Returns the more dangerous of two classifications.
 *
 * Stored risk is a cache, never authority: at invocation time it is re-derived from
 * the tool's declaration and escalated, so tampering with the policy file cannot
 * downgrade a destructive tool into the remembered-allow-eligible `read` class.
 */
export function maximumRisk(left: McpToolRisk, right: McpToolRisk): McpToolRisk {
  return RISK_ORDER.indexOf(left) >= RISK_ORDER.indexOf(right) ? left : right;
}

/** The authoritative risk for a stored tool: never lower than a fresh classification. */
export function effectiveRisk(tool: McpToolRecord): McpToolRisk {
  return maximumRisk(tool.risk, classifyToolRisk({ name: tool.name, description: tool.description }));
}

/**
 * Identity of a tool's full declaration. A remembered permission is kept only while
 * every part of the declaration is unchanged, so a server cannot hold the name and
 * risk fixed while rewriting the description or schema to mean something else.
 */
export function declarationDigest(tool: McpToolRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([tool.name, tool.title, tool.description, tool.risk, tool.inputSchema]))
    .digest("hex");
}

/** True when consent for this risk may never be remembered. */
export function requiresConsentEveryTime(risk: McpToolRisk): boolean {
  return ALWAYS_ASK_RISKS.includes(risk);
}

/**
 * Owns MCP server registration, per-tool consent decisions, and the audit log.
 *
 * Server command paths, argument vectors, and endpoints stay in this process;
 * the renderer receives only a redacted origin.
 */
export class McpPolicyStore {
  private readonly serversPath: string;
  private readonly activityPath: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    runtimeDirectory: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly harden: (path: string, platform?: NodeJS.Platform) => Promise<void> = hardenPrivatePath,
  ) {
    this.serversPath = join(runtimeDirectory, "mcp-servers.json");
    this.activityPath = join(runtimeDirectory, "mcp-activity.json");
  }

  async listServers(): Promise<ReadonlyArray<McpServerRecord>> {
    const raw = await this.readJson(this.serversPath);
    const servers = isRecord(raw) && Array.isArray(raw.servers) ? raw.servers : [];
    return servers.filter(isServerRecord).slice(0, MAX_SERVERS);
  }

  async findServer(serverId: string): Promise<McpServerRecord | undefined> {
    return (await this.listServers()).find(server => server.serverId === serverId);
  }

  async readCatalog(): Promise<McpCatalog> {
    const servers = await this.listServers();
    return {
      servers: servers.map(toServerStatus),
      tools: servers.flatMap(server => server.tools.map(tool => toToolStatus(server, tool))),
    };
  }

  /** Validates and stores a server definition. Tools are attached later by discovery. */
  async registerServer(input: McpServerInput): Promise<McpCatalog> {
    const definition = assertServerInput(input);
    return this.serialize(async () => {
      const servers = await this.listServers();
      const existing = servers.find(server => server.serverId === definition.serverId);
      if (!existing && servers.length >= MAX_SERVERS) throw new Error("Too many registered servers.");
      const record: McpServerRecord = {
        ...definition,
        enabled: true,
        registeredAt: new Date().toISOString(),
        // Re-registering a server discards its previous tools and decisions: a changed
        // command or endpoint must not inherit consent granted to the old one.
        tools: [],
        decisions: {},
      };
      await this.writeServers([...servers.filter(server => server.serverId !== definition.serverId), record]);
      return this.readCatalog();
    });
  }

  async removeServer(serverId: string): Promise<McpCatalog> {
    return this.serialize(async () => {
      const servers = await this.listServers();
      await this.writeServers(servers.filter(server => server.serverId !== serverId));
      return this.readCatalog();
    });
  }

  /** Replaces a server's advertised tools after a discovery handshake. */
  async replaceTools(serverId: string, tools: ReadonlyArray<McpToolRecord>): Promise<McpCatalog> {
    return this.serialize(async () => {
      const servers = await this.listServers();
      const server = servers.find(entry => entry.serverId === serverId);
      if (!server) throw new Error("Unknown server.");
      const accepted = tools.filter(tool => ID.test(tool.name)).slice(0, MAX_TOOLS_PER_SERVER);
      const names = new Set(accepted.map(tool => tool.name));
      // Drop decisions for tools whose declaration changed in any way, so consent never
      // survives a redefinition of what the tool is or does — not just its risk.
      const decisions: Record<string, McpToolDecision> = Object.create(null);
      for (const [name, decision] of Object.entries(server.decisions)) {
        const previous = server.tools.find(tool => tool.name === name);
        const next = accepted.find(tool => tool.name === name);
        if (names.has(name) && !FORBIDDEN_KEYS.has(name) && previous && next && declarationDigest(previous) === declarationDigest(next)) {
          decisions[name] = decision;
        }
      }
      const updated: McpServerRecord = { ...server, tools: accepted, decisions: { ...decisions } };
      await this.writeServers(servers.map(entry => (entry.serverId === serverId ? updated : entry)));
      return this.readCatalog();
    });
  }

  /**
   * Records a consent decision. `allow` is refused for risks that must always be
   * confirmed, so a persisted decision can never silently authorize a write or spend.
   */
  async setDecision(serverId: string, name: string, decision: McpToolDecision): Promise<McpCatalog> {
    if (!DECISIONS.includes(decision)) throw new Error("Unsupported decision.");
    if (FORBIDDEN_KEYS.has(name)) throw new Error("Unsupported tool name.");
    return this.serialize(async () => {
      const servers = await this.listServers();
      const server = servers.find(entry => entry.serverId === serverId);
      if (!server) throw new Error("Unknown server.");
      const tool = server.tools.find(entry => entry.name === name);
      if (!tool) throw new Error("Unknown tool.");
      if (decision === "allow" && requiresConsentEveryTime(effectiveRisk(tool))) {
        throw new Error("This tool must be confirmed every time it runs.");
      }
      const decisions: Record<string, McpToolDecision> = Object.create(null);
      for (const [key, value] of Object.entries(server.decisions)) {
        if (!FORBIDDEN_KEYS.has(key)) decisions[key] = value;
      }
      decisions[name] = decision;
      const updated: McpServerRecord = { ...server, decisions: { ...decisions } };
      await this.writeServers(servers.map(entry => (entry.serverId === serverId ? updated : entry)));
      return this.readCatalog();
    });
  }

  async readActivity(): Promise<ReadonlyArray<McpActivityEntry>> {
    const raw = await this.readJson(this.activityPath);
    const entries = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
    return entries.filter(isActivityEntry).slice(-MAX_ACTIVITY_ENTRIES);
  }

  /**
   * Appends one audit entry. Called for allowed, denied, and failed invocations alike.
   *
   * Sequence numbers continue from a high-water mark that is never rolled back, so
   * truncating or replacing the log is detectable as a gap rather than a silent reset.
   */
  async appendActivity(entry: Omit<McpActivityEntry, "sequence" | "at">): Promise<McpActivityEntry> {
    return this.serialize(async () => {
      const raw = await this.readJson(this.activityPath);
      const entries = (isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : []).filter(isActivityEntry).slice(-MAX_ACTIVITY_ENTRIES);
      const storedHighWater = isRecord(raw) && typeof raw.highWater === "number" && Number.isSafeInteger(raw.highWater) ? raw.highWater : 0;
      const highWater = Math.max(storedHighWater, entries.at(-1)?.sequence ?? 0);
      const record: McpActivityEntry = { ...entry, sequence: highWater + 1, at: new Date().toISOString() };
      await this.writePrivateJson(this.activityPath, {
        version: 1,
        highWater: record.sequence,
        entries: [...entries, record].slice(-MAX_ACTIVITY_ENTRIES),
      });
      return record;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async writeServers(servers: ReadonlyArray<McpServerRecord>): Promise<void> {
    await this.writePrivateJson(this.serversPath, { version: 1, servers: servers.slice(0, MAX_SERVERS) });
  }

  private async readJson(path: string): Promise<unknown> {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) return undefined;
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${path} must be a regular file.`);
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`${path} exceeds the supported size.`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  private async writePrivateJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value), "utf8");
      // Flush before the rename so an audit entry survives power loss, not just a crash.
      await file.sync().catch(() => undefined);
    } finally {
      await file.close();
    }
    try {
      if (this.platform === "win32") await this.harden(temporary, "win32");
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (this.platform === "win32") await this.harden(path, "win32");
  }
}

/** Validates a server definition, failing closed on anything ambiguous. */
export function assertServerInput(input: McpServerInput): McpServerInput {
  if (!ID.test(input.serverId) || FORBIDDEN_KEYS.has(input.serverId)) throw new Error("Server identifier is invalid.");
  if (!isBoundedText(input.label, 200)) throw new Error("Server label is invalid.");
  if (!TRANSPORTS.includes(input.transport)) throw new Error("Unsupported transport.");
  if (input.transport === "stdio") {
    if (input.endpoint !== undefined) throw new Error("A stdio server must not declare an endpoint.");
    if (!isBoundedText(input.command, 1_024)) throw new Error("A stdio server requires a command.");
    // A null byte makes spawn throw with the path embedded in the message.
    if (/[\u0000-\u001f]/.test(input.command)) throw new Error("A stdio server command contains invalid characters.");
    if (!isAbsoluteExecutable(input.command)) throw new Error("A stdio server command must be an absolute path.");
    // A remote binary would run code that was never inspected on this machine.
    // Both slash forms denote a UNC path on Windows.
    if (/^(\\\\|\/\/)/.test(input.command.trim())) throw new Error("A stdio server command must be a local path.");
    assertNotIndirectExecutor(input.command);
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 50 || !args.every(argument => typeof argument === "string" && argument.length <= 1_024 && !/[\u0000]/.test(argument))) {
      throw new Error("A stdio server argument vector is invalid.");
    }
    return { serverId: input.serverId, label: input.label.trim(), transport: "stdio", command: input.command.trim(), args: [...args] };
  }
  if (input.command !== undefined || input.args !== undefined) throw new Error("An http server must not declare a command.");
  if (!isBoundedText(input.endpoint, 2_048)) throw new Error("An http server requires an endpoint.");
  // Same rule as the chat provider: https anywhere, or plain http on loopback only.
  assertLoopbackOrHttps(input.endpoint);
  return { serverId: input.serverId, label: input.label.trim(), transport: "http", endpoint: input.endpoint.trim() };
}

/**
 * Shells, script hosts, and language interpreters turn a fixed argument vector back
 * into arbitrary code, which would defeat the point of pinning the command. Registration
 * already requires human confirmation; this refuses the shapes whose argument vector a
 * human cannot meaningfully audit.
 */
const INDIRECT_EXECUTORS = new Set([
  "cmd", "cmd.exe", "command.com", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "wscript", "wscript.exe", "cscript", "cscript.exe", "mshta", "mshta.exe", "rundll32", "rundll32.exe",
  "regsvr32", "regsvr32.exe", "msbuild", "msbuild.exe", "installutil", "installutil.exe",
  "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "env", "xargs", "nohup",
]);
const SCRIPT_EXTENSIONS = /\.(bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|scr|hta|lnk|pif|com|msi|reg)$/i;

function assertNotIndirectExecutor(command: string): void {
  const name = normalizeExecutableName(command);
  if (INDIRECT_EXECUTORS.has(name)) throw new Error("A shell or script interpreter cannot be registered as a server.");
  // Node refuses these without a shell on current runtimes, but that must not be the only guard.
  if (SCRIPT_EXTENSIONS.test(name)) throw new Error("A script file cannot be registered as a server.");
}

/**
 * Resolves the name Windows will actually execute.
 *
 * Windows discards trailing dots and spaces from a path component, so `cmd.exe.` and
 * `cmd.exe ` both launch `cmd.exe`. Comparing the raw basename would let either slip
 * past the denylist, so both separators are normalized and the trailing run is stripped.
 */
export function normalizeExecutableName(command: string): string {
  const unified = command.trim().replaceAll("\\", "/");
  const last = unified.slice(unified.lastIndexOf("/") + 1);
  return last.replace(/[. ]+$/, "").toLowerCase();
}

function toServerStatus(server: McpServerRecord): McpServerStatus {
  return {
    serverId: server.serverId,
    label: server.label,
    transport: server.transport,
    origin: redactOrigin(server),
    enabled: server.enabled,
    toolCount: server.tools.length,
    registeredAt: server.registeredAt,
  };
}

function toToolStatus(server: McpServerRecord, tool: McpToolRecord): McpToolStatus {
  // Re-derive so a tampered stored risk cannot present a dangerous tool as read-only.
  const risk = effectiveRisk(tool);
  const alwaysAsk = requiresConsentEveryTime(risk);
  const stored = Object.prototype.hasOwnProperty.call(server.decisions, tool.name) ? server.decisions[tool.name] : "ask";
  return {
    serverId: server.serverId,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    risk,
    // A remembered allow is never reported for an always-ask tool, even if one is on disk.
    decision: alwaysAsk && stored === "allow" ? "ask" : stored,
    alwaysAsk,
  };
}

/** The renderer learns only the executable name or endpoint host, never a full path or URL. */
function redactOrigin(server: McpServerRecord): string {
  if (server.transport === "stdio") return server.command ? basename(server.command) : "";
  try {
    return new URL(server.endpoint ?? "").host;
  } catch {
    return "";
  }
}

function isAbsoluteExecutable(command: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isToolRecord(value: unknown): value is McpToolRecord {
  return isRecord(value)
    && isBoundedText(value.name, 128)
    && ID.test(value.name)
    && typeof value.title === "string"
    && typeof value.description === "string"
    && RISKS.includes(value.risk as McpToolRisk)
    && isRecord(value.inputSchema);
}

function isServerRecord(value: unknown): value is McpServerRecord {
  if (!isRecord(value)) return false;
  const transport = value.transport;
  const tools = value.tools;
  const shapeOk = isBoundedText(value.serverId, 128)
    && ID.test(value.serverId)
    && isBoundedText(value.label, 200)
    && TRANSPORTS.includes(transport as McpTransportKind)
    && typeof value.enabled === "boolean"
    && isBoundedText(value.registeredAt, 64)
    && Array.isArray(tools)
    && isRecord(value.decisions);
  if (!shapeOk) return false;
  if (transport === "stdio" && !isBoundedText(value.command, 1_024)) return false;
  if (transport === "http" && !isBoundedText(value.endpoint, 2_048)) return false;
  return (tools as ReadonlyArray<unknown>).every(isToolRecord);
}

function isActivityEntry(value: unknown): value is McpActivityEntry {
  return isRecord(value)
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && isBoundedText(value.serverId, 128)
    && isBoundedText(value.name, 128)
    && RISKS.includes(value.risk as McpToolRisk)
    && (value.outcome === "allowed" || value.outcome === "denied" || value.outcome === "failed")
    && isBoundedText(value.at, 64);
}
