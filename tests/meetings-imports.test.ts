import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { describe, expect, it } from "vitest";

// R9.1: the meeting flow imports nothing from src/llm/ and no model SDK, directly or through
// any file it imports. Static analysis of the source text, so it also covers `import type`.

const ROOT = join(import.meta.dirname, "..");

const STATIC_IMPORT = /^\s*(?:import|export)\s(?:[^;"'`]*?\sfrom\s*)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']/g;
const ANY_DYNAMIC = /\bimport\(/g;

function read(file: string): string {
  return readFileSync(join(ROOT, ...file.split("/")), "utf8");
}

function specifiers(file: string): string[] {
  const text = read(file);
  const found = [...text.matchAll(STATIC_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map(
    (m) => m[1],
  );
  const literal = [...text.matchAll(DYNAMIC_IMPORT)].length;
  const total = [...text.matchAll(ANY_DYNAMIC)].length;
  if (total !== literal) throw new Error(`${file}: import() with a non-literal specifier`);
  return found.filter((s): s is string => s !== undefined);
}

/** Every file reachable from `roots` by relative imports, plus the bare and node: specifiers. */
function walk(roots: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      if (!spec.endsWith(".js")) throw new Error(`${file}: "${spec}" does not end in .js`);
      const target = posix.join(posix.dirname(file), `${spec.slice(0, -3)}.ts`);
      if (!existsSync(join(ROOT, ...target.split("/")))) {
        throw new Error(`${file}: "${spec}" resolves to missing ${target}`);
      }
      queue.push(target);
    }
  }
  return { files, packages };
}

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => posix.join(dir, f.split(sep).join("/")));
}

const MEETING_ROOTS = [
  ...tsFilesUnder("src/meetings"),
  ...tsFilesUnder("src/sources/fireflies"),
  ...tsFilesUnder("src/sources/gemini"),
  "src/vault/write-meeting.ts",
  "src/server/app.ts",
];

describe("R9.1: the meeting flow never imports a model", () => {
  const graph = walk(MEETING_ROOTS);

  it("reaches no file under src/llm/", () => {
    expect([...graph.files].filter((f) => f.startsWith("src/llm/"))).toEqual([]);
  });

  it("reaches no @anthropic-ai package", () => {
    expect([...graph.packages].filter((p) => p.startsWith("@anthropic-ai/"))).toEqual([]);
  });

  it("no visited file mentions @anthropic-ai/ (catches createRequire loads)", () => {
    expect([...graph.files].filter((f) => read(f).includes("@anthropic-ai/"))).toEqual([]);
  });

  it("control: the walk follows multiline and re-export imports", () => {
    for (const file of ["src/vault/write-note.ts", "src/git/sync.ts", "src/vault/scrub/rules.ts"]) {
      expect(graph.files.has(file), file).toBe(true);
    }
  });

  it("control: the walker finds an import type edge into src/llm/", () => {
    expect(walk(["src/llm/mock.ts"]).files.has("src/llm/index.ts")).toBe(true);
  });

  it("control: the roots are not empty", () => {
    expect(tsFilesUnder("src/meetings").length).toBeGreaterThanOrEqual(8);
  });
});
