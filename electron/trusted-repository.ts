import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

export interface TrustedRepositoryTarget {
  readonly canonicalRoot: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}

export function trustedRepositoryWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return { parent, modal: true, show: false, width: 760, height: 520, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true } };
}

export async function confirmTrustedRepository(target: TrustedRepositoryTarget, parent: BrowserWindow): Promise<boolean> {
  const window = new BrowserWindow(trustedRepositoryWindowOptions(parent));
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
      if (destination === "orrery-repository://confirm") finish(true);
      else if (destination === "orrery-repository://cancel") finish(false);
    });
    window.once("closed", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(trustedRepositoryHtml(target))}`).then(() => window.show()).catch(error => { if (!settled) { settled = true; reject(error); } window.destroy(); });
  });
}

export function trustedRepositoryHtml(target: TrustedRepositoryTarget): string {
  const root = escapeHtml(target.canonicalRoot);
  const fingerprint = escapeHtml(target.fingerprint);
  const expiresAt = escapeHtml(target.expiresAt);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Approve repository</title><style>body{font:14px system-ui;margin:0;padding:28px;background:#111;color:#eee}h1{font-size:22px}dl{background:#191919;border:1px solid #444;padding:18px}dt{color:#aaa;margin-top:12px}dd{margin:4px 0;overflow-wrap:anywhere}footer{display:flex;justify-content:flex-end;gap:12px;margin-top:22px}a{color:inherit;border:1px solid #777;padding:10px 16px;text-decoration:none}a.primary{background:#eee;color:#111}</style></head><body><h1>Approve repository</h1><p>Allow Orrery's authoritative daemon to operate on this exact Git repository identity.</p><dl><dt>Canonical root</dt><dd>${root}</dd><dt>Fingerprint</dt><dd><code>${fingerprint}</code></dd><dt>Proposal expires</dt><dd>${expiresAt}</dd></dl><footer><a href="orrery-repository://cancel">Cancel</a><a class="primary" href="orrery-repository://confirm">Approve repository</a></footer></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
