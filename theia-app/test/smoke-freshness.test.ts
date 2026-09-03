import { describe, expect, it } from "vitest";
import { describeStaleInstall, findStaleInstalledFiles, resolveExtensionPaths } from "../scripts/smoke-freshness.mjs";

/**
 * Models the two `lib` trees as in-memory maps keyed by path relative to `lib`,
 * so the check can be exercised without touching the real installed copy.
 */
function readers(built: Record<string, string>, installed: Record<string, string>) {
  const treeFor = (path: string) => (path.includes("node_modules") ? installed : built);
  const keyOf = (path: string) => path.split("lib\\")[1] ?? "";
  return {
    list: (directory: string) => {
      const tree = treeFor(directory);
      const prefix = keyOf(directory) === "" ? "" : `${keyOf(directory)}\\`;
      const names = new Set<string>();
      for (const file of Object.keys(tree)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (rest.length === 0) continue;
        const cut = rest.indexOf("\\");
        names.add(cut === -1 ? rest : rest.slice(0, cut));
      }
      return [...names].map(name => ({
        name,
        isDirectory: () => !name.includes("."),
      }));
    },
    read: (path: string) => {
      const tree = treeFor(path);
      const key = keyOf(path);
      if (!(key in tree)) throw new Error("ENOENT");
      return Buffer.from(tree[key]!);
    },
    stat: () => ({ isFile: () => true }),
  };
}

const BUILT = "C:\\repo\\theia-extensions\\mission-control\\lib";
const INSTALLED = "C:\\repo\\theia-app\\node_modules\\@orrery\\mission-control-theia\\lib";

describe("Theia smoke install freshness", () => {
  it("reports nothing when the installed copy matches the build", () => {
    const files = { "browser\\widget.js": "same", "electron-main\\main.js": "same" };
    expect(findStaleInstalledFiles(BUILT, INSTALLED, readers(files, { ...files }))).toEqual([]);
  });

  it("detects an extension change that was rebuilt but never reinstalled", () => {
    // This is the real failure: the bundle would carry the old text and the smoke would pass.
    const stale = findStaleInstalledFiles(
      BUILT,
      INSTALLED,
      readers({ "browser\\style.js": "new css" }, { "browser\\style.js": "old css" }),
    );
    expect(stale).toEqual([{ file: "browser\\style.js", reason: "differs" }]);
  });

  it("detects a newly added file that is absent from the installed copy", () => {
    const stale = findStaleInstalledFiles(
      BUILT,
      INSTALLED,
      readers({ "browser\\tools.js": "new" }, {}),
    );
    expect(stale).toEqual([{ file: "browser\\tools.js", reason: "missing" }]);
  });

  it("ignores non-JavaScript output, which cannot change runtime behavior", () => {
    const stale = findStaleInstalledFiles(
      BUILT,
      INSTALLED,
      readers({ "browser\\widget.d.ts": "new types" }, { "browser\\widget.d.ts": "old types" }),
    );
    expect(stale).toEqual([]);
  });

  it("ignores lib output the extension does not publish, which is never installed", () => {
    // `theia-test-setup.js` sits at the lib root and is outside the published `files` list.
    const stale = findStaleInstalledFiles(
      BUILT,
      INSTALLED,
      readers({ "theia-test-setup.js": "test only" }, {}),
    );
    expect(stale).toEqual([]);
  });

  it("checks every published directory, not just the browser bundle", () => {
    const stale = findStaleInstalledFiles(
      BUILT,
      INSTALLED,
      readers({ "electron-main\\main.js": "new", "common\\contracts.js": "new", "electron-browser\\preload.js": "new" }, {}),
    );
    expect(stale.map(entry => entry.file).sort()).toEqual(["common\\contracts.js", "electron-browser\\preload.js", "electron-main\\main.js"]);
  });

  it("explains how to fix a stale install and names the offending files", () => {
    const message = describeStaleInstall([{ file: "browser\\style.js", reason: "differs" }]);
    expect(message).toContain("browser\\style.js");
    expect(message).toContain("theia-app:install");
    expect(message).toMatch(/certify code that is not running/);
  });

  it("summarizes rather than listing every file when many are stale", () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ file: `browser\\f${index}.js`, reason: "differs" as const }));
    expect(describeStaleInstall(many)).toContain("...and 4 more");
  });

  it("resolves the built and installed trees relative to the app root", () => {
    const paths = resolveExtensionPaths("C:\\repo\\theia-app");
    expect(paths.built.replace(/\\/g, "/")).toMatch(/theia-extensions\/mission-control\/lib$/);
    expect(paths.installed.replace(/\\/g, "/")).toMatch(/@orrery\/mission-control-theia\/lib$/);
  });
});
