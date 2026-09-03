import { BrowserWindow } from "electron";
import { trustedToolCallWindowOptions } from "./trusted-tool-call";
import type { McpToolRisk, McpTransportKind } from "./mcp-contract";

export interface TrustedServerRegistrationTarget {
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  /** stdio: the full absolute command. Shown untruncated: this is what will execute. */
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  /** http: the full endpoint URL. */
  readonly endpoint?: string;
  readonly replacesExisting: boolean;
}

export interface TrustedDecisionTarget {
  readonly serverLabel: string;
  readonly serverId: string;
  readonly name: string;
  readonly risk: McpToolRisk;
}

/**
 * Confirms registration of a server before anything is spawned or contacted.
 *
 * Registration is an execution primitive: a command plus an argument vector runs on
 * the operator's machine. The human therefore sees the exact, untruncated command
 * line, and a renderer alone can never introduce one.
 */
export async function confirmTrustedServerRegistration(target: TrustedServerRegistrationTarget, parent: BrowserWindow): Promise<boolean> {
  return decide(parent, registrationHtml(target));
}

/**
 * Confirms granting standing permission for a tool, which removes the per-call prompt.
 * Only read-risk tools ever reach this point; everything else is refused earlier.
 */
export async function confirmTrustedDecision(target: TrustedDecisionTarget, parent: BrowserWindow): Promise<boolean> {
  return decide(parent, decisionHtml(target));
}

async function decide(parent: BrowserWindow, html: string): Promise<boolean> {
  const window = new BrowserWindow(trustedToolCallWindowOptions(parent));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
      window.destroy();
    };
    window.webContents.on("will-navigate", (event, destination) => {
      event.preventDefault();
      if (destination === "orrery-mcp://confirm") finish(true);
      else if (destination === "orrery-mcp://cancel") finish(false);
    });
    window.once("closed", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => window.show())
      .catch(error => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        window.destroy();
      });
  });
}

const STYLE = "body{font:14px system-ui;margin:0;padding:28px;background:#111;color:#eee}h1{font-size:21px;margin:0 0 14px}p{line-height:1.55}.warn{border-left:3px solid #e5a50a;background:#191919;padding:12px 14px;margin:0 0 18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#191919;border:1px solid #444;padding:16px;max-height:320px;overflow:auto}footer{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}a{color:inherit;border:1px solid #777;padding:10px 16px;text-decoration:none}a.primary{background:#eee;color:#111}";

/** Beyond this, the command line cannot be meaningfully reviewed in the dialog. */
const MAX_REVIEWABLE_COMMAND_LENGTH = 2_000;

function registrationHtml(target: TrustedServerRegistrationTarget): string {
  const full = target.transport === "stdio"
    ? `${target.command ?? ""}\n\n${(target.args ?? []).map((argument, index) => `argument ${index + 1}: ${argument}`).join("\n") || "no arguments"}`
    : target.endpoint ?? "";
  // Truncate rather than render thousands of lines the human will not read, and say so.
  const detail = full.length > MAX_REVIEWABLE_COMMAND_LENGTH
    ? `${full.slice(0, MAX_REVIEWABLE_COMMAND_LENGTH)}\n\n[truncated: ${full.length - MAX_REVIEWABLE_COMMAND_LENGTH} more characters not shown]`
    : full;
  const warning = target.transport === "stdio"
    ? "Orrery will run this program on this machine, now and whenever this server is used. Only approve a program you trust."
    : "Orrery will send requests to this address. Treat anything it returns as untrusted.";
  const replacing = target.replacesExisting
    ? "<p class=\"warn\"><strong>This replaces a server that is already registered. Its tools and remembered permissions will be discarded.</strong></p>"
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Add tool server</title><style>${STYLE}</style></head><body><h1>Add tool server &ldquo;${escapeHtml(target.label)}&rdquo;?</h1><p class="warn"><strong>${escapeHtml(warning)}</strong></p>${replacing}<p>Identifier: ${escapeHtml(target.serverId)} &middot; transport: ${escapeHtml(target.transport)}</p><pre>${escapeHtml(detail)}</pre><footer><a href="orrery-mcp://cancel">Cancel</a><a class="primary" href="orrery-mcp://confirm">Add server</a></footer></body></html>`;
}

function decisionHtml(target: TrustedDecisionTarget): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Always allow tool</title><style>${STYLE}</style></head><body><h1>Always allow &ldquo;${escapeHtml(target.name)}&rdquo;?</h1><p class="warn"><strong>Orrery will stop asking before running this tool. It will run without confirmation until you change this.</strong></p><p>Server: ${escapeHtml(target.serverLabel)} (${escapeHtml(target.serverId)})<br>Tool: ${escapeHtml(target.name)}<br>Risk: ${escapeHtml(target.risk)}</p><p>Only read-only tools can be allowed this way. Tools that change data, send data, or spend money are always confirmed individually.</p><footer><a href="orrery-mcp://cancel">Keep asking</a><a class="primary" href="orrery-mcp://confirm">Always allow</a></footer></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
