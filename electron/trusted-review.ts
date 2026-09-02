import type { MissionReviewContent } from "@orrery/mission-control-protocol";
import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

export interface TrustedReviewTarget {
  readonly decision: "accepted" | "rejected";
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly contentDigest: string;
  readonly review: MissionReviewContent;
}

export function trustedReviewDetail(target: TrustedReviewTarget): string {
  return JSON.stringify({
    missionId: target.missionId,
    planRevisionId: target.planRevisionId,
    changeRevision: target.changeRevision,
    contentDigest: target.contentDigest,
    decision: target.decision,
    changes: target.review.changes,
    evidence: target.review.evidence,
  }, null, 2);
}

export function trustedReviewWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return { parent, modal: true, show: false, width: 960, height: 760, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true } };
}

export async function confirmTrustedReview(target: TrustedReviewTarget, parent: BrowserWindow): Promise<boolean> {
  const window = new BrowserWindow(trustedReviewWindowOptions(parent));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (approved: boolean) => { if (settled) return; settled = true; resolve(approved); window.destroy(); };
    window.webContents.on("will-navigate", (event, destination) => {
      event.preventDefault();
      if (destination === "orrery-review://confirm") finish(true);
      else if (destination === "orrery-review://cancel") finish(false);
    });
    window.once("closed", () => { if (!settled) { settled = true; resolve(false); } });
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reviewHtml(target))}`).then(() => window.show()).catch(error => { if (!settled) { settled = true; reject(error); } window.destroy(); });
  });
}

function reviewHtml(target: TrustedReviewTarget): string {
  const title = target.decision === "accepted" ? "Promote reviewed change" : "Reject reviewed change";
  const detail = escapeHtml(trustedReviewDetail(target));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><style>body{font:14px system-ui;margin:0;padding:28px;background:#111;color:#eee}h1{font-size:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#191919;border:1px solid #444;padding:18px;max-height:560px;overflow:auto}footer{display:flex;justify-content:flex-end;gap:12px}a{color:inherit;border:1px solid #777;padding:10px 16px;text-decoration:none}a.primary{background:#eee;color:#111}</style></head><body><h1>${title}</h1><p>This exact daemon inspection will be bound to the signed decision.</p><pre>${detail}</pre><footer><a href="orrery-review://cancel">Cancel</a><a class="primary" href="orrery-review://confirm">${target.decision === "accepted" ? "Promote" : "Reject"}</a></footer></body></html>`;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
