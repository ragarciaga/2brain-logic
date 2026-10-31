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

function splitNul(buffer: Buffer): string[] {
  const parts = buffer.toString("utf8").split("\0");
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

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

interface Copy {
  path: string;
  bytes: Buffer;
}

/**
 * Pull with rebase. When the pull stops on a rebase conflict, abort the rebase and rebuild one
 * commit on top of the remote: every remote version stays at its path, every local-only change is
 * kept, and each conflicting local version is added as a conflict copy next to it. The commit is
 * pushed. Nothing is deleted. A pull failure that is not a rebase conflict is rethrown unchanged.
 * Returns how many files conflicted.
 */
export async function syncBeforeWrite(
  dir: string,
  opts: SyncOptions,
): Promise<{ conflicts: number }> {
  try {
    await opts.git.pullRebase(dir, opts.author);
    return { conflicts: 0 };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (!(await rebaseInProgress(dir))) throw error;
    return resolveConflict(dir, opts, error);
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

  const localChanged = await changedPaths(dir, base, local);
  const upstreamChanged = await changedPaths(dir, base, upstream);
  const upstreamSet = new Set(upstreamChanged);
  const both = localChanged.filter((p) => upstreamSet.has(p));
  const localEntries = await readEntries(dir, local, both);
  const upstreamEntries = await readEntries(dir, upstream, both);
  const conflicting = both.filter((p) => !sameEntry(localEntries.get(p), upstreamEntries.get(p)));
  if (conflicting.length === 0) throw original;

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
    await runGit(dir, ["reset", "-q", "--soft", upstream]);
    const upstreamHas = await readEntries(dir, upstream, upstreamChanged);
    const present = upstreamChanged.filter((p) => upstreamHas.has(p));
    const gone = upstreamChanged.filter((p) => !upstreamHas.has(p));
    for (const group of chunks(present)) {
      await runGit(dir, ["checkout", "-q", upstream, "--", ...group]);
    }
    for (const group of chunks(gone)) {
      await runGit(dir, ["rm", "-q", "--ignore-unmatch", "--", ...group]);
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

    const staged = await runGitBuffer(dir, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.length === 0) return { conflicts: conflicting.length };
    await commitIndex(
      dir,
      `2brain: keep conflicting versions (${conflicting.length} files)`,
      opts.author,
    );
  } catch (error) {
    // Best effort: put the vault back where it was, then report the original problem.
    try {
      for (const file of written) await unlink(file).catch(() => undefined);
      await runGit(dir, ["reset", "-q", "--hard", local]);
    } catch {
      // swallowed on purpose
    }
    throw error;
  }
  await opts.git.push(dir);
  return { conflicts: conflicting.length };
}
