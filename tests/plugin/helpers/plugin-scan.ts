import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_VAULT_CONFIG } from "../../../src/config/defaults.js";
import personNames from "../fixtures/person-names.json" with { type: "json" };

export type ScanFinding = { rule: string; match: string };

export const PLUGIN_ROOT = join(import.meta.dirname, "..", "..", "..", "plugin");

/** Fictional areas and folders that must never appear in plugin files. Not default names. */
export const FIXTURE_AREAS_AND_FOLDERS: readonly string[] = [
  "northwind",
  "contoso",
  "finanzas",
  "familia",
  "clientes",
  "reuniones",
  "bitacora",
];

const ALLOWED_HOST = "example.com";
const TLDS = "com|net|org|io|co|dev|app|ai";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === ALLOWED_HOST || h.endsWith(`.${ALLOWED_HOST}`);
}

function wholeWords(words: readonly string[]): RegExp {
  const alternatives = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

const NAME_PATTERN = wholeWords(personNames as string[]);
const DENYLIST_PATTERN = wholeWords(FIXTURE_AREAS_AND_FOLDERS);

const DEFAULT_AREAS = new Set<string>(DEFAULT_VAULT_CONFIG.areas);
const AREA_FOLDERS = new Set<string>(["sessions"]);
for (const type of Object.values(DEFAULT_VAULT_CONFIG.types)) {
  const folder = type.folder;
  if (folder?.startsWith("{area}/")) AREA_FOLDERS.add(folder.slice("{area}/".length));
}
const VAULT_PATH_PATTERN = new RegExp(
  `(?<![\\w.{}-])([\\w{}-]+)/(${[...AREA_FOLDERS].map(escapeRegExp).join("|")})(?![\\w-])`,
  "g",
);

export function scanOwnerData(text: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
    if (!isAllowedHost(m[1] ?? "")) found.push({ rule: "email", match: m[0] });
  }
  for (const m of text.matchAll(/\bhttps?:\/\/([^\s/:"'`)>\]?#]+)/gi)) {
    if (!isAllowedHost(m[1] ?? "")) found.push({ rule: "url-host", match: m[0] });
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b`, "gi"))) {
    if (!isAllowedHost(m[0])) found.push({ rule: "hostname", match: m[0] });
  }
  for (const m of text.matchAll(NAME_PATTERN)) found.push({ rule: "person-name", match: m[0] });
  for (const m of text.matchAll(VAULT_PATH_PATTERN)) {
    const first = m[1] ?? "";
    if (first === "{area}" || DEFAULT_AREAS.has(first)) continue;
    found.push({ rule: "vault-path", match: m[0] });
  }
  for (const m of text.matchAll(DENYLIST_PATTERN)) found.push({ rule: "denylist", match: m[0] });
  return found;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[^'"();]*?\s+)?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

/** Every module specifier a file loads with a literal string, in source order per pattern. */
export function importSpecifiers(text: string): string[] {
  return IMPORT_PATTERNS.flatMap((p) => [...text.matchAll(p)].map((m) => m[1] ?? ""));
}

export function scanImports(text: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const spec of importSpecifiers(text)) {
    if (spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../")) continue;
    found.push({ rule: "import", match: spec });
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(?!['"\s])[^)]*\)/g)) {
    found.push({ rule: "import-dynamic-specifier", match: m[0] });
  }
  return found;
}

const NETWORK_RULES: readonly (readonly [string, RegExp])[] = [
  ["net-module", /node:(?:http|https|http2|net|tls|dgram)\b/g],
  ["fetch", /\bfetch\(/g],
  ["websocket", /\bnew\s+WebSocket\b/g],
  ["eventsource", /\bnew\s+EventSource\b/g],
  ["xhr", /\bXMLHttpRequest\b/g],
  ["git-spawn", /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*['"`]git\b/g],
  ["vault-dir", /\.2brain\b/g],
  ["vault-env", /VAULT_/g],
];

export function scanNetwork(text: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const [rule, pattern] of NETWORK_RULES) {
    for (const m of text.matchAll(pattern)) found.push({ rule, match: m[0] });
  }
  return found;
}

/** Every file under plugin/, dot directories included, as POSIX paths relative to plugin/. */
export function listPluginFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(PLUGIN_ROOT, full).split(sep).join("/"));
    }
  };
  walk(PLUGIN_ROOT);
  return out.sort();
}

export function readPluginFile(path: string): string {
  return readFileSync(join(PLUGIN_ROOT, path), "utf8");
}
