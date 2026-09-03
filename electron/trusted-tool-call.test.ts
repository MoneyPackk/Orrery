import { describe, expect, it } from "vitest";
import { trustedToolCallDetail, trustedToolCallWindowOptions, type TrustedToolCallTarget } from "./trusted-tool-call";

const target: TrustedToolCallTarget = {
  serverLabel: "Files",
  serverOrigin: "mcp-files",
  serverId: "files",
  name: "write_file",
  title: "Write file",
  description: "Writes content to a path.",
  risk: "write",
  args: { path: "notes.txt", content: "hello" },
  argumentsDigest: "a".repeat(64),
};

describe("trusted tool call consent", () => {
  it("opens a sandboxed modal with no preload and no node integration", () => {
    const parent = {} as never;
    const options = trustedToolCallWindowOptions(parent);
    expect(options.modal).toBe(true);
    expect(options.parent).toBe(parent);
    expect(options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true });
    // A preload would give the consent page a bridge back into the app.
    expect(options.webPreferences).not.toHaveProperty("preload");
  });

  it("shows the exact arguments and digest that will be signed", () => {
    const detail = trustedToolCallDetail(target);
    expect(JSON.parse(detail)).toEqual({
      server: "Files",
      origin: "mcp-files",
      tool: "write_file",
      risk: "write",
      argumentsDigest: "a".repeat(64),
      arguments: { path: "notes.txt", content: "hello" },
    });
  });
});
