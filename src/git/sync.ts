import { access, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { isSafePathSegment } from "../vault/note-schema.js";
import {
  commitIndex,
  type GitApi,
  type GitAuthor,
  GitError,
  runGit,
  runGitBuffer,
} from "./index.js";

const MAX_NAME_BYTES = 255;
const CHUNK = 100;
const MAX_SUFFIX = 1000;

/**
 * The name of a conflict copy: `<stem> (conflict <day>)<ext>` for n=1 and
 * `<stem> (conflict <day> <n>)<ext>` for n>=2, in the folder of `relPath`. The stem is cut by code
 * points so the file name stays within 255 UTF-8 bytes. Throws a plain `Error` when the result
 * would not be a safe file name.
 */
export function conflictCopyName(relPath: string, day: string, n: number): string {
  const slash = relPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : relPath.slice(0, slash + 1);
  const base = relPath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  let stem = dot > 0 ? base.slice(0, dot) : base;
  const suffix = n <= 1 ? ` (conflict ${day})` : ` (conflict ${day} ${n})`;
  const chars = [...stem];
  while (chars.length > 0 && Buffer.byteLength(chars.join("") + suffix + ext) > MAX_NAME_BYTES) {
    chars.pop();
  }
  stem = chars.join("").replace(/[. ]+$/, "");
  if (stem === "") throw new Error("Cannot name a conflict copy");
  const name = stem + suffix + ext;
  if (!isSafePathSegment(name)) throw new Error("Cannot name a conflict copy");
  return dir + name;
}

export interface SyncOptions {
  git: Pick<GitApi, "pullRebase" | "push">;
  author: GitAuthor;
  now: () => Date;
  /** Scrub the text of a conflict copy. May throw; it is called before anything is changed. */
  prepareCopy: (text: string) => string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rebaseInProgress(dir: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const rel = await runGit(dir, ["rev-parse", "--git-path", name]);
    if (await exists(resolve(dir, rel))) return true;
  }
  return false;
}

/** A path name in git output is not valid UTF-8, so it cannot be handled safely as text. */
class NameDecodeError extends Error {}

function splitNul(buffer: Buffer): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new NameDecodeError("Path name is not valid UTF-8");
  }
  const parts = text.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

async function changedPaths(dir: string, from: string, to: string): Promise<string[]> {
  return splitNul(await runGitBuffer(dir, ["diff", "--name-only", "-z", "--no-renames", from, to]));
}

interface Entry {
  mode: string;
  oid: string;
}

/** Blob and gitlink entries of `paths` at `rev`; a path with no such entry is absent. */
async function readEntries(dir: string, rev: string, paths: string[]): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>();
  for (const group of chunks(paths)) {
    const out = await runGitBuffer(dir, ["ls-tree", "-z", rev, "--", ...group]);
    for (const record of splitNul(out)) {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (mode === undefined || oid === undefined || (type !== "blob" && type !== "commit"))
        continue;
      map.set(record.slice(tab + 1), { mode, oid });
    }
  }
  return map;
}

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  return a?.mode === b?.mode && a?.oid === b?.oid;
}

async function deepestRealAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Every ancestor directory of every path, as `a`, `a/b` for `a/b/c`. */
function ancestorDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    let slash = path.indexOf("/");
    while (slash !== -1) {
      dirs.add(path.slice(0, slash));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return dirs;
}

/** True when a path changed on one side is a directory that the other side's changes put files in. */
function hasDirectoryFileClash(localChanged: string[], upstreamChanged: string[]): boolean {
  const upstreamDirs = ancestorDirs(upstreamChanged);
  const localDirs = ancestorDirs(localChanged);
  return (
    localChanged.some((p) => upstreamDirs.has(p)) || upstreamChanged.some((p) => localDirs.has(p))
  );
}

/**
 * Paths of the local tree that upstream did not change and that are no longer in the index. Any
 * such path would be committed as a deletion the service did not choose.
 */
export function missingLocalPaths(
  localTree: string[],
  upstreamTouched: Set<string>,
  indexed: Set<string>,
): string[] {
  return localTree.filter((p) => !upstreamTouched.has(p) && !indexed.has(p));
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

interface Copy {
  path: string;
  bytes: Buffer;
}

/** Waits before retry 1, 2 and 3 of a push (ms). One attempt plus one retry per entry. */
export const PUSH_RETRY_WAITS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Local ref that holds the pre-rebuild HEAD while a conflict rebuild runs. It is set by the rebuild
 * itself and removed when the rebuild ends; one that is found at the start of a sync means the
 * process died in the middle. It is never pushed (`push origin HEAD` sends only HEAD).
 */
const REBUILD_REF = "refs/2brain/rebuild-local";

export type PushOutcome =
  | { pushed: true; commit: string }
  | { pushed: false; commit: string; exitCode: number | null };

export interface PushRetryOptions {
  push: (dir: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  waits?: readonly number[];
}

/**
 * Push HEAD. A failure with exit code 1 is a ref rejection (the remote moved): it is not retried,
 * because the next pull rebases and the next write pushes. Any other git failure (exit 128, no
 * code) is treated as transient and retried after each wait in `waits`. Never throws for a
 * `GitError`; the outcome carries the HEAD sha at the time of the call and the last exit code, and
 * nothing else from git (no URL, no stderr). Other errors are rethrown.
 */
export async function pushWithRetry(dir: string, opts: PushRetryOptions): Promise<PushOutcome> {
  const waits = opts.waits ?? PUSH_RETRY_WAITS_MS;
  const commit = await runGit(dir, ["rev-parse", "HEAD"]);
  for (let attempt = 0; ; attempt++) {
    try {
      await opts.push(dir);
      return { pushed: true, commit };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const wait = waits[attempt];
      if (error.exitCode === 1 || wait === undefined) {
        return { pushed: false, commit, exitCode: error.exitCode };
      }
      await opts.sleep(wait);
    }
  }
}

/** Push (with retries) only when HEAD is ahead of `@{upstream}`; undefined when nothing is pending. */
export async function pushIfAhead(
  dir: string,
  opts: PushRetryOptions,
): Promise<PushOutcome | undefined> {
  const ahead = await runGit(dir, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (ahead === "0") return undefined;
  return pushWithRetry(dir, opts);
}

/** True when `relPath` is a file recorded in the HEAD commit. */
export async function trackedAtHead(dir: string, relPath: string): Promise<boolean> {
  return (await runGit(dir, ["ls-tree", "--name-only", "HEAD", "--", relPath])) !== "";
}

async function dropRebuildRef(dir: string): Promise<void> {
  await runGit(dir, ["update-ref", "-d", REBUILD_REF]);
}

/**
 * Pull with rebase. When the pull stops on a rebase conflict, abort the rebase and rebuild one
 * commit on top of the remote: every remote version stays at its path, every local-only change is
 * kept, and each conflicting local version is added as a conflict copy next to it. The rebuilt
 * commit is pushed once, without failing the sync; the write that follows pushes it again with
 * retries. Nothing is deleted. A pull failure that is not a rebase conflict is rethrown unchanged.
 * If a previous rebuild was interrupted (its marker ref exists), the vault is first put back at
 * the commit the marker holds, so the rebuild runs again from a clean state; `recovered` is then
 * true. Returns how many files conflicted.
 */
export async function syncBeforeWrite(
  dir: string,
  opts: SyncOptions,
): Promise<{ conflicts: number; recovered: boolean }> {
  let recovered = false;
  const marker = await runGit(dir, ["for-each-ref", "--format=%(objectname)", REBUILD_REF]);
  if (marker !== "") {
    await runGit(dir, ["reset", "-q", "--hard", marker]);
    await dropRebuildRef(dir);
    recovered = true;
  }
  try {
    await opts.git.pullRebase(dir, opts.author);
    return { conflicts: 0, recovered };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (!(await rebaseInProgress(dir))) throw error;
    return { ...(await resolveConflict(dir, opts, error)), recovered };
  }
}

async function resolveConflict(
  dir: string,
  opts: SyncOptions,
  original: GitError,
): Promise<{ conflicts: number }> {
  await runGit(dir, ["rebase", "--abort"]);
  if (await rebaseInProgress(dir)) throw original;

  const local = await runGit(dir, ["rev-parse", "HEAD"]);
  const upstream = await runGit(dir, ["rev-parse", "--verify", "@{upstream}"]);
  const base = await runGit(dir, ["merge-base", "HEAD", upstream]);

  let localChanged: string[];
  let upstreamChanged: string[];
  let localEntries: Map<string, Entry>;
  let conflicting: string[];
  try {
    localChanged = await changedPaths(dir, base, local);
    upstreamChanged = await changedPaths(dir, base, upstream);
    const upstreamSet = new Set(upstreamChanged);
    const both = localChanged.filter((p) => upstreamSet.has(p));
    localEntries = await readEntries(dir, local, both);
    const upstreamEntries = await readEntries(dir, upstream, both);
    conflicting = both.filter((p) => !sameEntry(localEntries.get(p), upstreamEntries.get(p)));
  } catch (error) {
    if (error instanceof NameDecodeError) throw original;
    throw error;
  }
  if (conflicting.length === 0) throw original;
  // A file on one side where the other side has a directory cannot be rebuilt in place.
  if (hasDirectoryFileClash(localChanged, upstreamChanged)) throw original;

  const day = opts.now().toISOString().slice(0, 10);
  const copies: Copy[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const path of conflicting) {
    const entry = localEntries.get(path);
    if (entry === undefined || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    try {
      conflictCopyName(path, day, 1);
    } catch {
      throw original;
    }
    const raw = await runGitBuffer(dir, ["cat-file", "blob", entry.oid]);
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      throw original;
    }
    // May throw (ScrubFailedError): nothing has been changed yet.
    const prepared = opts.prepareCopy(text);
    copies.push({ path, bytes: prepared === text ? raw : Buffer.from(prepared, "utf8") });
  }

  const written: string[] = [];
  const root = resolve(dir);
  try {
    await runGit(dir, ["update-ref", REBUILD_REF, local]);
    await runGit(dir, ["reset", "-q", "--soft", upstream]);
    const upstreamHas = await readEntries(dir, upstream, upstreamChanged);
    const present = upstreamChanged.filter((p) => upstreamHas.has(p));
    const gone = upstreamChanged.filter((p) => !upstreamHas.has(p));
    for (const group of chunks(present)) {
      await runGit(dir, ["checkout", "-q", upstream, "--", ...group]);
    }
    for (const group of chunks(gone)) {
      await runGit(dir, ["rm", "-q", "-f", "--ignore-unmatch", "--", ...group]);
    }

    const realRoot = await realpath(root);
    const chosen = new Set<string>();
    for (const copy of copies) {
      let rel: string | undefined;
      for (let n = 1; n <= MAX_SUFFIX; n++) {
        const candidate = conflictCopyName(copy.path, day, n);
        if (chosen.has(candidate)) continue;
        try {
          await lstat(resolve(root, candidate));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            rel = candidate;
            break;
          }
          throw error;
        }
      }
      if (rel === undefined) throw new Error("No free conflict copy name");
      chosen.add(rel);
      const target = resolve(root, rel);
      if (!inside(realRoot, await deepestRealAncestor(dirname(target)))) {
        throw new Error("Path escapes the vault");
      }
      await mkdir(dirname(target), { recursive: true });
      if (!inside(realRoot, await realpath(dirname(target)))) {
        throw new Error("Path escapes the vault");
      }
      await writeFile(target, copy.bytes, { flag: "wx" });
      written.push(target);
      await runGit(dir, ["add", "--", rel]);
    }

    // Every local path that upstream did not change must still be staged.
    const upstreamTouched = new Set(upstreamChanged);
    const localTree = splitNul(
      await runGitBuffer(dir, ["ls-tree", "-r", "-z", "--name-only", local]),
    );
    const indexed = new Set(splitNul(await runGitBuffer(dir, ["ls-files", "-z"])));
    if (missingLocalPaths(localTree, upstreamTouched, indexed).length > 0) throw original;

    const staged = await runGitBuffer(dir, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.length === 0) {
      await dropRebuildRef(dir);
      return { conflicts: conflicting.length };
    }
    await commitIndex(
      dir,
      `2brain: keep conflicting versions (${conflicting.length} files)`,
      opts.author,
    );
    await dropRebuildRef(dir);
  } catch (error) {
    // Best effort: put the vault back where it was, then report the original problem.
    try {
      for (const file of written) await unlink(file).catch(() => undefined);
      await runGit(dir, ["reset", "-q", "--hard", local]);
      await dropRebuildRef(dir);
    } catch {
      // swallowed on purpose
    }
    throw error instanceof NameDecodeError ? original : error;
  }
  // One attempt: the write's own push delivers this commit, with retries.
  try {
    await opts.git.push(dir);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  return { conflicts: conflicting.length };
}
