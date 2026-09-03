import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import type { McpToolRisk } from "./mcp-contract";

export interface TrustedToolCallTarget {
  readonly serverLabel: string;
  readonly serverOrigin: string;
  readonly serverId: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: McpToolRisk;
  /** Rendered verbatim for the human, and digested into the capability. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
}

const RISK_NOTE: Readonly<Record<McpToolRisk, string>> = {
  read: "This tool reads data. It should not change anything.",
  write: "This tool can create or change data. This cannot be undone by Orrery.",
  destructive: "This tool can delete or destroy data. This cannot be undone by Orrery.",
  network: "This tool sends data outside this machine. Treat anything it returns as untrusted.",
  spend: "This tool can spend money or incur charges.",
};

export function trustedToolCallDetail(target: TrustedToolCallTarget): string {
  return JSON.stringify({
    server: target.serverLabel,
    origin: target.serverOrigin,
    tool: target.name,
    risk: target.risk,
    argumentsDigest: target.argumentsDigest,
    arguments: target.args,
  }, null, 2);
}

export function trustedToolCallWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    modal: true,
    show: false,
    width: 880,
    height: 720,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true },
  };
}

/**
 * Asks the human to approve one tool invocation in a sandboxed modal with no preload.
 * The decision travels as an intercepted navigation, so the page has no scripting and
 * no bridge. Closing the window without deciding denies the call.
 */
export async function confirmTrustedToolCall(target: TrustedToolCallTarget, parent: BrowserWindow): Promise<boolean> {
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
      if (destination === "orrery-tool://confirm") finish(true);
      else if (destination === "orrery-tool://cancel") finish(false);
    });
    window.once("closed", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toolCallHtml(target))}`)
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

function toolCallHtml(target: TrustedToolCallTarget): string {
  const title = `Run ${target.name}?`;
  const detail = escapeHtml(trustedToolCallDetail(target));
  const note = escapeHtml(RISK_NOTE[target.risk]);
  const label = escapeHtml(target.serverLabel);
  const origin = escapeHtml(target.serverOrigin);
  const description = escapeHtml(target.description);
  const risk = escapeHtml(target.risk);
  const elevated = target.risk !== "read";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui;margin:0;padding:28px;background:#111;color:#eee}h1{font-size:22px;margin:0 0 6px}p{line-height:1.55}.origin{opacity:.75;font-size:12px;margin:0 0 18px}.risk{border-left:3px solid ${elevated ? "#e5a50a" : "#777"};background:#191919;padding:12px 14px;margin:0 0 18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#191919;border:1px solid #444;padding:18px;max-height:420px;overflow:auto}footer{display:flex;justify-content:flex-end;gap:12px;margin-top:18px}a{color:inherit;border:1px solid #777;padding:10px 16px;text-decoration:none}a.primary{background:#eee;color:#111}</style></head><body><h1>${escapeHtml(title)}</h1><p class="origin">${label} &middot; ${origin} &middot; risk: ${risk}</p><p class="risk"><strong>${note}</strong></p><p>${description}</p><p>Orrery will run this tool with exactly these arguments. The approval is signed, single-use, and expires in one minute.</p><pre>${detail}</pre><footer><a href="orrery-tool://cancel">Cancel</a><a class="primary" href="orrery-tool://confirm">Run tool</a></footer></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
