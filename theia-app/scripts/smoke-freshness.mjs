import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The Theia app consumes the extension as an installed *copy* under
 * `theia-app/node_modules/@orrery/mission-control-theia`, not a symlink. `build:full`
 * therefore bundles whatever that copy holds, so an extension change that was never
 * reinstalled is silently absent from the bundle and the smoke passes against stale code.
 *
 * This compares the built extension against the installed copy by content and reports
 * every file that differs, so the smoke can refuse to certify a stale bundle.
 */
/**
 * Only these `lib` subdirectories are published by the extension's `files` field, so only
 * these can reach the bundle. Anything else in `lib` (test setup, stray output) is not
 * installed and must not be reported as stale.
 */
const PUBLISHED_DIRECTORIES = ["common", "browser", "electron-browser", "electron-main"];

export function findStaleInstalledFiles(builtLibDirectory, installedLibDirectory, readers = {}) {
  const list = readers.list ?? (directory => readdirSync(directory, { withFileTypes: true }));
  const read = readers.read ?? (path => readFileSync(path));
  const stat = readers.stat ?? (path => statSync(path));

  const built = PUBLISHED_DIRECTORIES.flatMap(directory =>
    collectFiles(join(builtLibDirectory, directory), list, stat).map(file => join(directory, file)));
  const stale = [];
  for (const file of built) {
    const source = join(builtLibDirectory, file);
    const installed = join(installedLibDirectory, file);
    let installedContent;
    try {
      installedContent = read(installed);
    } catch {
      stale.push({ file, reason: "missing" });
      continue;
    }
    if (!read(source).equals(installedContent)) stale.push({ file, reason: "differs" });
  }
  return stale;
}

/** Only `.js` output matters to the bundle; declarations and maps do not change runtime behavior. */
function collectFiles(directory, list, stat) {
  const found = [];
  const walk = current => {
    let entries;
    try {
      entries = list(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      try {
        if (!stat(path).isFile()) continue;
      } catch {
        continue;
      }
      found.push(relative(directory, path));
    }
  };
  walk(directory);
  return found;
}

export function describeStaleInstall(stale) {
  const shown = stale.slice(0, 10).map(entry => `  ${entry.file} (${entry.reason})`).join("\n");
  const more = stale.length > 10 ? `\n  ...and ${stale.length - 10} more` : "";
  return [
    `The installed extension copy is stale in ${stale.length} file(s), so the bundle would not`,
    "contain the current extension code and this smoke would certify code that is not running:",
    shown + more,
    "",
    "Run `npm run theia-app:install` after `npm run theia:build`, then re-run the smoke.",
  ].join("\n");
}

export function resolveExtensionPaths(appRoot) {
  return {
    built: resolve(appRoot, "../theia-extensions/mission-control/lib"),
    installed: resolve(appRoot, "node_modules/@orrery/mission-control-theia/lib"),
  };
}
