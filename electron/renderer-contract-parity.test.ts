import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps the duplicated renderer DTOs in step with the ones the main process actually sends.
 *
 * `electron/*-contract.ts` and the Theia extension's `mission-control-contracts.ts` declare the
 * same shapes twice on purpose: the extension is published as a standalone package and is
 * forbidden from importing across the repo (pinned by its own structure test), so the types
 * cannot simply be shared. Nothing stopped the two copies drifting, and both had to be edited by
 * hand when `toolCalls` was added. Drift here is quiet and bad: the renderer would compile
 * against a field the main process no longer sends, or silently stop rendering one it does.
 *
 * This compares the declarations as text rather than importing the extension copy, which would
 * reintroduce exactly the dependency the boundary exists to prevent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ELECTRON_CONTRACTS = ["intelligence-contract.ts", "mcp-contract.ts"].map(name => resolve(here, name));
const THEIA_CONTRACTS = resolve(here, "../theia-extensions/mission-control/src/common/mission-control-contracts.ts");

interface Declaration {
  readonly kind: "interface" | "type";
  readonly name: string;
  /** For an interface: `field?: type` entries. For a type alias: the single normalized value. */
  readonly members: ReadonlyArray<string>;
  readonly extends?: string;
}

/** Strips comments so wording differences between the copies are not treated as drift. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extracts exported type and interface declarations.
 *
 * Deliberately a small parser over a real TypeScript one: it must run in the plain test suite
 * with no extra dependency, and it fails loudly (empty members) rather than silently matching
 * if a declaration is shaped in a way it does not understand.
 */
function parseDeclarations(source: string): Map<string, Declaration> {
  const text = stripComments(source);
  const declarations = new Map<string, Declaration>();

  for (const match of text.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);/g)) {
    declarations.set(match[1]!, { kind: "type", name: match[1]!, members: [normalize(match[2]!)] });
  }

  for (const match of text.matchAll(/export\s+interface\s+(\w+)(\s+extends\s+[\w<>, ]+?)?\s*\{/g)) {
    const name = match[1]!;
    const bodyStart = match.index! + match[0].length;
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = text.slice(bodyStart, cursor - 1);
    // Split on top-level semicolons only, so an inline object type stays one member.
    const members: string[] = [];
    let buffer = "";
    let nested = 0;
    for (const character of body) {
      if (character === "{" || character === "<" || character === "(") nested += 1;
      if (character === "}" || character === ">" || character === ")") nested -= 1;
      if (character === ";" && nested === 0) {
        if (normalize(buffer)) members.push(normalize(buffer).replace(/^readonly\s+/, ""));
        buffer = "";
        continue;
      }
      buffer += character;
    }
    if (normalize(buffer)) members.push(normalize(buffer).replace(/^readonly\s+/, ""));
    declarations.set(name, {
      kind: "interface",
      name,
      members: members.sort(),
      ...(match[2] ? { extends: normalize(match[2].replace(/^\s*extends\s+/, "")) } : {}),
    });
  }

  return declarations;
}

async function loadElectronDeclarations(): Promise<Map<string, Declaration>> {
  const merged = new Map<string, Declaration>();
  for (const path of ELECTRON_CONTRACTS) {
    for (const [name, declaration] of parseDeclarations(await readFile(path, "utf8"))) merged.set(name, declaration);
  }
  return merged;
}

/**
 * Flattens inherited members so the comparison is about the shape a renderer sees.
 *
 * The two copies legitimately express the same shape differently: the electron copy uses
 * `extends McpServerInput`, while the Theia copy inlines those fields because it cannot import
 * across the boundary. Comparing declared members alone reports that as drift, which would be a
 * false alarm and would train someone to weaken this test.
 */
function resolveMembers(name: string, declarations: Map<string, Declaration>, seen = new Set<string>()): ReadonlyArray<string> {
  const declaration = declarations.get(name);
  if (!declaration || seen.has(name)) return [];
  seen.add(name);
  const inherited = declaration.extends
    ? declaration.extends.split(",").flatMap(parent => resolveMembers(parent.trim(), declarations, seen))
    : [];
  return [...new Set([...inherited, ...declaration.members])].sort();
}

describe("renderer contract parity", () => {
  it("declares every shared chat and tool DTO identically in both copies", async () => {
    const electron = await loadElectronDeclarations();
    const theia = parseDeclarations(await readFile(THEIA_CONTRACTS, "utf8"));

    const shared = [...electron.keys()].filter(name => theia.has(name)).sort();
    // Guards the guard: if the parser stops recognizing declarations, this fails rather than
    // passing an empty comparison and reporting parity that was never checked.
    expect(shared).toContain("IntelligenceMessage");
    expect(shared).toContain("IntelligenceToolCall");
    expect(shared).toContain("McpInvokeResult");
    expect(shared.length).toBeGreaterThan(15);

    const drift = shared
      .map(name => ({
        name,
        kinds: [electron.get(name)!.kind, theia.get(name)!.kind] as const,
        electron: resolveMembers(name, electron),
        theia: resolveMembers(name, theia),
      }))
      .filter(entry => entry.kinds[0] !== entry.kinds[1] || entry.electron.join(" | ") !== entry.theia.join(" | "))
      .map(entry => `${entry.name}\n  electron: ${entry.electron.join("; ")}\n  theia:    ${entry.theia.join("; ")}`);

    expect(drift).toEqual([]);
  });

  it("keeps the tool record shape the renderer depends on", async () => {
    const electron = await loadElectronDeclarations();
    // Pinned explicitly: the interface separating Orrery-authored records from model-authored
    // text is a security boundary, so a field being renamed or dropped should fail here too.
    expect(electron.get("IntelligenceToolCall")!.members).toEqual([
      "detail?: string",
      'outcome: "ran" | "error" | "denied" | "skipped"',
      "name: string",
      "serverId: string",
    ].sort());
    expect(electron.get("IntelligenceMessage")!.members).toContain("toolCalls?: ReadonlyArray<IntelligenceToolCall>");
  });
});
