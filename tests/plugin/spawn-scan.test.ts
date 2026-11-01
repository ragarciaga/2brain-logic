import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPluginFiles, PLUGIN_ROOT } from "./helpers/plugin-scan.js";

function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
}

/** Returns the text between the parentheses of the call that opens at `open`. */
function callBody(text: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Splits at top-level commas. */
function topLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim());
}

/** Problems found in the process-spawning calls of one source text. */
function scanSpawns(source: string): string[] {
  const text = strip(source);
  const problems: string[] = [];
  for (const m of text.matchAll(
    /(?<![.\w])(?:(?:cp|child_process|childProcess)\.)?exec(?:Sync)?\s*\(/g,
  )) {
    problems.push(`${m[0].trim()} runs a shell`);
  }
  for (const m of text.matchAll(/\b\w*(?:spawn|execFile|fork)\w*\s*\(/gi)) {
    const at = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", at) + 1;
    if (/\bfunction\s+$/.test(text.slice(lineStart, at))) continue;
    const args = topLevel(callBody(text, at + m[0].length - 1));
    const name = m[0].replace(/\s*\($/, "");
    const second = args[1] ?? "";
    if (!second || /^["'`]/.test(second)) problems.push(`${name}: no argument array`);
    const opts = args.find((a, i) => i >= 2 && a.startsWith("{")) ?? "";
    if (!/\bshell\s*:\s*false\b/.test(opts)) problems.push(`${name}: no shell: false`);
    if (!/\bwindowsHide\s*:\s*true\b/.test(opts)) problems.push(`${name}: no windowsHide: true`);
  }
  return problems;
}

describe("scanSpawns", () => {
  const ok = "spawn(cmd, [a], { shell: false, windowsHide: true, detached: true });";
  it("accepts a conforming call", () => {
    expect(scanSpawns(ok)).toStrictEqual([]);
    expect(
      scanSpawns(`const c = doSpawn(x, [\n"a", b(1)], { env, shell: false, windowsHide: true });`),
    ).toStrictEqual([]);
    expect(scanSpawns('import { spawn, execFile } from "node:child_process";')).toStrictEqual([]);
  });

  it.each([
    ["no shell", "spawn(cmd, [a], { windowsHide: true });"],
    ["shell true", "spawn(cmd, [a], { shell: true, windowsHide: true });"],
    ["no windowsHide", "execFile(cmd, [a], { shell: false });"],
    ["windowsHide false", "fork(cmd, [a], { shell: false, windowsHide: false });"],
    ["string command", 'spawn("ls -l", { shell: false, windowsHide: true });'],
    ["string second argument", 'execFile(cmd, "x y", { shell: false, windowsHide: true });'],
    ["no options", "spawn(cmd, [a]);"],
    ["exec", "exec(cmd);"],
    ["member exec", "cp.exec(cmd);"],
    ["execSync", "execSync(cmd);"],
    ["wrapped name", "doSpawn(cmd, [a], { windowsHide: true });"],
  ])("fails %s", (_name, sample) => {
    expect(scanSpawns(sample).length).toBeGreaterThan(0);
  });

  it("ignores calls inside comments", () => {
    expect(scanSpawns("// spawn(cmd)\n/* exec(cmd) */")).toStrictEqual([]);
  });
});

describe("plugin/scripts", () => {
  const files = listPluginFiles().filter((f) => /^scripts[\\/].*\.mjs$/.test(f));

  it("scans the real scripts", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith("headless.mjs"))).toBe(true);
  });

  it.each(files)("%s spawns only without a shell", (file) => {
    expect(scanSpawns(readFileSync(join(PLUGIN_ROOT, file), "utf8"))).toStrictEqual([]);
  });
});
