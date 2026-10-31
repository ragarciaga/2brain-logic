import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ConfigInvalidError,
  loadVaultConfig,
  type VaultConfig,
} from "../../config/vault-config.js";
import { GitError, logChangedPaths } from "../../git/index.js";
import { parseNote } from "../../vault/frontmatter.js";
import { NoteInput } from "../../vault/note-schema.js";
import { isInside, realpathOfDeepestAncestor } from "../../vault/write-note.js";
// Types only: server.ts imports READ_TOOLS from this module.
import type { McpServerDeps, McpToolDefinition } from "../server.js";

/**
 * The read tools: `search`, `read` and `recent` (R8.1 to R8.4).
 *
 * - Each call runs on the writer's queue after a pull (`withPulled`), so it sees the latest
 *   commit and waits for a write in flight. A failed pull still answers, with `stale: true`.
 * - Every answer is `{ ok: true, ... }` or `{ ok: false, error }` with a fixed code. Error text
 *   never carries a path, rg or git output or note content. Handlers never throw.
 * - Tools never write. `ctx.http` is never read.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 90;
export const MAX_QUERY_LENGTH = 200;
/** The same cap as an ingest body. */
export const MAX_READ_BYTES = 1024 * 1024;
const SNIPPET_BYTES = 200;
const SNIPPET_LEAD_BYTES = 60;
const RG_MAX_BUFFER = 1024 * 1024;
const DAY_MS = 86_400_000;

export type ReadError =
  | "search_failed"
  | "search_timeout"
  | "unsafe_path"
  | "note_not_found"
  | "note_too_large"
  | "git_failed"
  | "config_invalid"
  | "internal_error";

export interface SearchHit {
  path: string;
  title: string;
  line: number;
  snippet: string;
}

export interface RecentNote {
  path: string;
  title: string;
  type: string | null;
  date: string;
}

type Failure = { ok: false; error: ReadError };
export type SearchOutcome = { ok: true; results: SearchHit[] } | Failure;
export type ReadOutcome =
  | { ok: true; path: string; frontmatter: Record<string, unknown> | null; body: string }
  | Failure;
export type RecentOutcome = { ok: true; notes: RecentNote[] } | Failure;

const fail = (error: ReadError): Failure => ({ ok: false, error });

export interface ReadToolOptions {
  /** Test seam for the clock. */
  now?: () => Date;
  /** Test seam: how long one rg run may take. */
  searchTimeoutMs?: number;
  /** Test seam: the ripgrep binary. */
  rgPath?: string;
}

function isArchived(path: string, config: VaultConfig): boolean {
  const archive = config.vault.archive_folder;
  return path === archive || path.startsWith(`${archive}/`);
}

/** A note path every tool may list: it passes the ingest path rule and is not archived. */
function isListable(path: string, config: VaultConfig): boolean {
  return NoteInput.shape.path.safeParse(path).success && !isArchived(path, config);
}

/** True when `real` is inside the real vault root and no segment below it starts with a dot. */
function isVisibleInside(realRoot: string, real: string): boolean {
  return (
    isInside(realRoot, real) &&
    !relative(realRoot, real)
      .split(sep)
      .some((segment) => segment.startsWith("."))
  );
}

/**
 * The real path of a regular file (not a symlink) whose real location is inside the vault and
 * outside dot folders, or undefined. The realpath check catches a parent directory that was
 * swapped for a symlink out of the vault.
 */
async function listableFile(root: string, path: string): Promise<string | undefined> {
  try {
    const target = resolve(root, path);
    if (!(await lstat(target)).isFile()) return undefined;
    const real = await realpath(target);
    return isVisibleInside(await realpath(root), real) ? real : undefined;
  } catch {
    return undefined;
  }
}

const stem = (path: string): string => basename(path, ".md");

/** Frontmatter and title of a stored note; a file that cannot be read or parsed has neither. */
async function readTitle(
  real: string,
  path: string,
): Promise<{ title: string; data: Record<string, unknown> }> {
  try {
    const bytes = await readFile(real);
    const { data } = parseNote(bytes.toString("utf8"));
    const title = data.title;
    return { title: typeof title === "string" && title !== "" ? title : stem(path), data };
  } catch {
    return { title: stem(path), data: {} };
  }
}

/** Escape glob metacharacters so a configured folder name is matched literally. */
function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);
}

function snippetOf(text: string, startByte: number): string {
  const line = text.replace(/\r?\n$/, "");
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= SNIPPET_BYTES) return line;
  let from = Math.max(0, Math.min(startByte, bytes.length) - SNIPPET_LEAD_BYTES);
  let to = Math.min(bytes.length, from + SNIPPET_BYTES);
  // Move both ends to code point boundaries (continuation bytes are 10xxxxxx).
  while (from < bytes.length && ((bytes[from] ?? 0) & 0xc0) === 0x80) from += 1;
  while (to > from && to < bytes.length && ((bytes[to] ?? 0) & 0xc0) === 0x80) to -= 1;
  return bytes.subarray(from, to).toString("utf8");
}

interface RgMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
}

export interface SearchParams {
  query: string;
  limit: number;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  rgPath: string;
}

/**
 * Run ripgrep over the vault as a fixed, case-insensitive string. The JS filters (path rule,
 * archive prefix, regular file) are the guard; the rg globs only save work.
 */
export function searchVault(
  root: string,
  config: VaultConfig,
  params: SearchParams,
): Promise<SearchOutcome> {
  const { query, limit, signal, timeoutMs, rgPath } = params;
  const args = [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--no-follow",
    "--no-config",
    "--no-messages",
    "--sort",
    "path",
    "--max-count",
    "1",
    "--max-filesize",
    "2M",
    "--glob",
    "*.md",
    "--glob",
    "!.git",
    "--glob",
    `!${escapeGlob(config.vault.archive_folder)}/**`,
    "--",
    query,
    ".",
  ];

  return new Promise<SearchOutcome>((done) => {
    const results: SearchHit[] = [];
    let ownKill = false;
    let buffered = "";
    let pending: Promise<void> = Promise.resolve();

    const child = execFile(
      rgPath,
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: RG_MAX_BUFFER,
        ...(signal ? { signal } : {}),
      },
      (error) => {
        void pending.then(() => {
          if (ownKill || error === null) return done({ ok: true, results });
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ ok: true, results });
          if (e.name === "AbortError" || e.code === "ABORT_ERR" || signal?.aborted || e.killed) {
            return done(fail("search_timeout"));
          }
          // Exit 1 is "no match". Exit 2 may carry partial results (an unreadable file).
          if ((e.code as unknown) === 1 || results.length > 0) return done({ ok: true, results });
          return done(fail("search_failed"));
        });
      },
    );

    const handleLine = async (line: string): Promise<void> => {
      if (ownKill || results.length >= limit) return;
      let record: RgMatch;
      try {
        record = JSON.parse(line) as RgMatch;
      } catch {
        return;
      }
      if (record.type !== "match") return;
      const raw = record.data?.path?.text;
      const text = record.data?.lines?.text;
      const lineNumber = record.data?.line_number;
      if (raw === undefined || text === undefined || typeof lineNumber !== "number") return;
      const path = raw.startsWith("./") ? raw.slice(2) : raw;
      if (!isListable(path, config)) return;
      const real = await listableFile(root, path);
      if (real === undefined || ownKill || results.length >= limit) return;
      const { title } = await readTitle(real, path);
      results.push({
        path,
        title,
        line: lineNumber,
        snippet: snippetOf(text, record.data?.submatches?.[0]?.start ?? 0),
      });
      if (results.length >= limit) {
        ownKill = true;
        child.kill();
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line !== "") pending = pending.then(() => handleLine(line));
        newline = buffered.indexOf("\n");
      }
    });
  });
}

/** Read one note by path. Refuses anything that resolves outside the vault or into a dot folder. */
export async function readVaultNote(root: string, path: string): Promise<ReadOutcome> {
  if (!NoteInput.shape.path.safeParse(path).success) return fail("unsafe_path");
  const target = resolve(root, path);
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    try {
      if (!isInside(realRoot, await realpathOfDeepestAncestor(target))) return fail("unsafe_path");
    } catch {
      return fail("note_not_found");
    }
    return fail("note_not_found");
  }
  if (!isVisibleInside(realRoot, real)) return fail("unsafe_path");
  const info = await stat(real);
  if (!info.isFile()) return fail("note_not_found");
  if (info.size > MAX_READ_BYTES) return fail("note_too_large");
  const bytes = await readFile(real);
  if (bytes.length > MAX_READ_BYTES) return fail("note_too_large");
  const text = bytes.toString("utf8");
  try {
    const parsed = parseNote(text);
    const frontmatter = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
    return { ok: true, path, frontmatter, body: parsed.content };
  } catch {
    return { ok: true, path, frontmatter: null, body: text };
  }
}

/** Notes whose last commit is within `days`, newest first. */
export async function recentNotes(
  root: string,
  config: VaultConfig,
  params: { days: number; limit: number; now: Date; signal?: AbortSignal | undefined },
): Promise<RecentOutcome> {
  const since = new Date(params.now.getTime() - params.days * DAY_MS);
  let changed: Array<{ path: string; date: string }>;
  try {
    changed = await logChangedPaths(root, since, params.signal);
  } catch (error) {
    if (error instanceof GitError) return fail("git_failed");
    throw error;
  }
  const notes: RecentNote[] = [];
  for (const { path, date } of changed) {
    if (notes.length >= params.limit) break;
    if (!isListable(path, config)) continue;
    const real = await listableFile(root, path);
    if (real === undefined) continue;
    const { title, data } = await readTitle(real, path);
    const type = data[config.properties.type];
    notes.push({ path, title, type: typeof type === "string" ? type : null, date });
  }
  return { ok: true, notes };
}

type Body = SearchOutcome | ReadOutcome | RecentOutcome;

function toResult(body: Body, stale: boolean) {
  const shaped = body.ok && stale ? { ...body, stale: true } : body;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(shaped) }],
    structuredContent: shaped as unknown as Record<string, unknown>,
    isError: !body.ok,
  };
}

/** Run one tool on the writer queue; every failure becomes a fixed code. */
async function guarded(
  deps: McpServerDeps,
  run: () => Promise<Body>,
): Promise<ReturnType<typeof toResult>> {
  try {
    return await deps.writer.withPulled(async ({ stale }) => {
      try {
        return toResult(await run(), stale);
      } catch (error) {
        return toResult(
          fail(error instanceof ConfigInvalidError ? "config_invalid" : "internal_error"),
          stale,
        );
      }
    });
  } catch {
    return toResult(fail("internal_error"), false);
  }
}

const positiveInt = (what: string) =>
  z
    .number({ message: `${what} must be a number` })
    .int({ message: `${what} must be an integer` })
    .positive({ message: `${what} must be positive` })
    .optional();

/** The three read tools. Options are test seams; production passes none. */
export function createReadTools(options: ReadToolOptions = {}): McpToolDefinition[] {
  const now = options.now ?? (() => new Date());
  const searchTimeoutMs = options.searchTimeoutMs ?? 2000;
  const rgPath = options.rgPath ?? "rg";

  const search: McpToolDefinition = {
    name: "search",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "search",
        {
          description:
            "Find notes containing a phrase (case-insensitive, literal text). Returns path, title, line number and a snippet.",
          inputSchema: z.object({
            query: z
              .string({ message: "query must be a string" })
              .min(1, { message: "query must not be empty" })
              .max(MAX_QUERY_LENGTH, { message: "query is too long" })
              // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
              .refine((q) => !/[\n\r\u0000]/.test(q), { message: "query must be a single line" }),
            limit: positiveInt("limit"),
          }),
        },
        (args, ctx) => {
          const root = resolve(deps.config.vaultDir);
          return guarded(deps, async () => {
            const config = await loadVaultConfig(root);
            return searchVault(root, config, {
              query: args.query,
              limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
              signal: ctx.mcpReq.signal,
              timeoutMs: searchTimeoutMs,
              rgPath,
            });
          });
        },
      );
    },
  };

  const read: McpToolDefinition = {
    name: "read",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "read",
        {
          description: "Read one note by its vault path. Returns its frontmatter and body.",
          inputSchema: z.object({
            path: z
              .string({ message: "path must be a string" })
              .min(1, { message: "path must not be empty" })
              .max(1024, { message: "path is too long" }),
          }),
        },
        (args) => guarded(deps, () => readVaultNote(resolve(deps.config.vaultDir), args.path)),
      );
    },
  };

  const recent: McpToolDefinition = {
    name: "recent",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "recent",
        {
          description: "List the notes most recently committed, newest first.",
          inputSchema: z.object({ days: positiveInt("days"), limit: positiveInt("limit") }),
        },
        (args, ctx) => {
          const root = resolve(deps.config.vaultDir);
          return guarded(deps, async () => {
            const config = await loadVaultConfig(root);
            return recentNotes(root, config, {
              days: Math.min(args.days ?? DEFAULT_DAYS, MAX_DAYS),
              limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
              now: now(),
              signal: ctx.mcpReq.signal,
            });
          });
        },
      );
    },
  };

  return [search, read, recent];
}

export const READ_TOOLS: readonly McpToolDefinition[] = Object.freeze(createReadTools());
