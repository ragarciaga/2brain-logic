import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A git command failed. It carries the subcommand name, the exit code and one boolean derived from
 * stderr (`permissionDenied`). The stderr text, the command line and the underlying error are
 * dropped on purpose, because a remote URL may hold credentials and git echoes it in its messages.
 */
export class GitError extends Error {
  readonly subcommand: string;
  readonly exitCode: number | null;
  readonly permissionDenied: boolean;

  constructor(subcommand: string, exitCode: number | null, permissionDenied = false) {
    super(`git ${subcommand} failed (exit ${exitCode ?? "unknown"})`);
    this.name = "GitError";
    this.subcommand = subcommand;
    this.exitCode = exitCode;
    this.permissionDenied = permissionDenied;
  }
}

export interface GitAuthor {
  name: string;
  email: string;
}

function committerEnv(author: GitAuthor): Record<string, string> {
  return { GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
}

export interface RunOptions {
  /** Aborting it stops the child; the call then fails with `GitError(sub, null)`. */
  signal?: AbortSignal;
  /** Kill the child after this many milliseconds; the call then also fails with `GitError(sub, null)`. */
  timeoutMs?: number;
}

/** Run git with an argument array (never a shell string) and return trimmed stdout. */
export async function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  options: RunOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      // Last, so no caller can override it: a path is a file name, never a glob or pathspec magic.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, GIT_LITERAL_PATHSPECS: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    const exitCode = typeof code === "number" ? code : null;
    // Only a boolean leaves this block; the stderr text is never stored.
    const permissionDenied =
      exitCode === 128 && typeof stderr === "string" && /Permission denied/.test(stderr);
    throw new GitError(args[0] ?? "unknown", exitCode, permissionDenied);
  }
}

/**
 * Like `runGit`, but returns stdout as raw bytes and never trims. Needed for `-z` output, where a
 * leading space or newline is part of a file name.
 */
export async function runGitBuffer(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  options: RunOptions = {},
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, GIT_LITERAL_PATHSPECS: "1" },
      maxBuffer: 16 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new GitError(args[0] ?? "unknown", typeof code === "number" ? code : null);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Clone `remote` into `dir` when `dir` is not a repository yet. */
export async function ensureClone(dir: string, remote?: string): Promise<void> {
  if (await exists(join(dir, ".git"))) {
    return;
  }
  if (!remote) {
    throw new Error("VAULT_DIR is not a git repository and VAULT_REMOTE is not set");
  }
  await runGit(process.cwd(), ["clone", "--", remote, dir]);
}

/** Pull with rebase. `author` supplies the committer identity a rebase may need. */
export async function pullRebase(dir: string, author?: GitAuthor): Promise<void> {
  await runGit(dir, ["pull", "--rebase"], author ? committerEnv(author) : {});
}

/** Stage one file, commit it as `author` and return the new commit sha. */
export async function commitFile(
  dir: string,
  relPath: string,
  message: string,
  author: GitAuthor,
): Promise<string> {
  await runGit(dir, ["add", "--", relPath]);
  await runGit(dir, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    ...committerEnv(author),
  });
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/** Commit what is staged as `author` and return the new commit sha. */
export async function commitIndex(
  dir: string,
  message: string,
  author: GitAuthor,
): Promise<string> {
  await runGit(dir, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    ...committerEnv(author),
  });
  return runGit(dir, ["rev-parse", "HEAD"]);
}

export async function push(dir: string): Promise<void> {
  await runGit(dir, ["push", "origin", "HEAD"]);
}

/** The sha HEAD points to. */
export async function headSha(dir: string): Promise<string> {
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/**
 * Reset one path's index entry to HEAD; the working tree is untouched. A path that is not staged
 * is not an error. A path tracked in HEAD never ends up as a staged deletion.
 */
export async function unstageFile(dir: string, relPath: string): Promise<void> {
  await runGit(dir, ["reset", "-q", "--", relPath]);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Paths changed by commits made since `since` on HEAD, each with the committer date (ISO 8601) of
 * the newest commit that touched it, newest first. Renames are reported as a delete and an add; a
 * path whose name is not valid UTF-8 is skipped. A deleted path is still listed (the caller checks
 * the file).
 */
export async function logChangedPaths(
  dir: string,
  since: Date,
  signal?: AbortSignal,
): Promise<Array<{ path: string; date: string }>> {
  const stamp = since.toISOString().replace(/\.\d{3}Z$/, "Z");
  // A random marker per call: a committed file name cannot forge a record header it cannot know.
  const marker = randomBytes(12).toString("hex");
  const out = await runGitBuffer(
    dir,
    [
      "log",
      "-z",
      "--name-only",
      "--no-renames",
      `--format=%x1e${marker}%cI`,
      `--since=${stamp}`,
      "HEAD",
    ],
    {},
    signal ? { signal } : {},
  );
  return parseLogRecords(out, marker, since);
}

/**
 * Parse `git log -z --name-only --format=%x1e<marker>%cI` output. Tolerates the layout variants of
 * different git versions (date then NUL then optional newline, or newline then NUL). With `since`,
 * records older than it are dropped here too, so a `--since` that git misparsed cannot widen the
 * result.
 */
export function parseLogRecords(
  out: Buffer,
  marker: string,
  since?: Date,
): Array<{ path: string; date: string }> {
  const floor = since === undefined ? undefined : Math.floor(since.getTime() / 1000) * 1000;
  const seen = new Map<string, string>();
  for (const record of out.toString("latin1").split(`\x1e${marker}`).slice(1)) {
    // The date ends at the first NUL or newline; the names follow, NUL-separated.
    const end = record.search(/[\0\n]/);
    if (end < 0) continue;
    const date = record.slice(0, end);
    // Defense in depth next to the marker: a header must be a strict ISO 8601 committer date.
    if (!ISO_DATE.test(date)) continue;
    if (floor !== undefined && Date.parse(date) < floor) continue;
    // latin1 maps bytes 1:1, so names can be re-sliced into the original bytes and decoded strictly.
    const names = Buffer.from(record.slice(end).replace(/^[\0\n]+/, ""), "latin1");
    for (const raw of splitNul(names)) {
      let path: string;
      try {
        path = STRICT_UTF8.decode(raw);
      } catch {
        continue;
      }
      const known = seen.get(path);
      if (known === undefined || Date.parse(date) > Date.parse(known)) seen.set(path, date);
    }
  }
  return [...seen]
    .map(([path, date]) => ({ path, date }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= buffer.length; i += 1) {
    if (i === buffer.length || buffer[i] === 0) {
      if (i > start) parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

/**
 * Move a tracked file with `git mv` (staged rename, history kept). Never forced: an existing
 * target or an untracked source makes git fail instead of overwriting.
 */
export async function moveFile(dir: string, from: string, to: string): Promise<void> {
  await runGit(dir, ["mv", "--", from, to]);
}

/**
 * Commit only the named paths (whatever else is staged stays out) as `author` and return the new
 * commit sha. After a `moveFile`, name both the old and the new path to commit the rename.
 */
export async function commitPaths(
  dir: string,
  paths: string[],
  message: string,
  author: GitAuthor,
): Promise<string> {
  await runGit(dir, ["commit", "-m", message, "--", ...paths], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    ...committerEnv(author),
  });
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/** Upper bound for a command that talks to a remote during setup and doctor. */
export const REMOTE_TIMEOUT_MS = 15_000;

/** Upper bound for a setup push: a re-run may push more than a seed commit. */
export const PUSH_TIMEOUT_MS = 60_000;

/** Upper bound for the setup clone: a large vault can take far longer than a ls-remote. */
export const CLONE_TIMEOUT_MS = 120_000;

/** Clone `remote` into `dir` unconditionally (setup). A timed-out clone fails with `GitError("clone", null)`. */
export async function cloneInto(
  remote: string,
  dir: string,
  env: Record<string, string> = {},
  timeoutMs: number = CLONE_TIMEOUT_MS,
): Promise<void> {
  await runGit(process.cwd(), ["clone", "--", remote, dir], env, { timeoutMs });
}

/** True when the repository has at least one commit on any ref. */
export async function hasCommits(dir: string): Promise<boolean> {
  return (await runGit(dir, ["rev-list", "-n", "1", "--all"])) !== "";
}

/** The checked-out branch name; fails with `GitError` on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string> {
  return runGit(dir, ["symbolic-ref", "--short", "HEAD"]);
}

/** Branch names on `remote`, without the `refs/heads/` prefix. */
export async function lsRemote(
  cwd: string,
  remote: string,
  env: Record<string, string> = {},
): Promise<string[]> {
  const out = await runGit(cwd, ["ls-remote", "--heads", "--", remote], env, {
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (line.split("\t")[1] ?? "").replace(/^refs\/heads\//, ""))
    .filter((name) => name.length > 0);
}

/** Check that HEAD could be pushed to origin, without changing the remote. */
export async function pushDryRun(dir: string, env: Record<string, string> = {}): Promise<void> {
  await runGit(dir, ["push", "--dry-run", "origin", "HEAD"], env, {
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
}

/** Stage the named paths (literal file names, never pathspecs). */
export async function addPaths(dir: string, paths: string[]): Promise<void> {
  await runGit(dir, ["add", "--", ...paths]);
}

/** Refuse a branch name that could change the refspec or look like an option. */
function assertBranchName(branch: string): void {
  if (branch === "" || branch.startsWith("-") || branch.includes(":") || branch.includes("..")) {
    throw new Error("invalid branch name");
  }
}

/**
 * Push HEAD to `branch` on origin, bounded by `timeoutMs`: a timed-out push fails with
 * `GitError("push", null)`. A name that is empty, starts with `-` or contains `:` or `..`
 * is rejected with a plain `Error` before git runs.
 */
export async function pushBranch(
  dir: string,
  branch: string,
  env: Record<string, string> = {},
  timeoutMs: number = PUSH_TIMEOUT_MS,
): Promise<void> {
  assertBranchName(branch);
  await runGit(dir, ["push", "origin", `HEAD:refs/heads/${branch}`], env, { timeoutMs });
}

/** Number of local commits on HEAD that `origin/<branch>` does not have. Local only, no network. */
export async function commitsAhead(dir: string, branch: string): Promise<number> {
  assertBranchName(branch);
  const out = await runGit(dir, ["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`]);
  return Number(out);
}

/** The URL of the `origin` remote. */
export async function originUrl(dir: string, env: Record<string, string> = {}): Promise<string> {
  return runGit(dir, ["remote", "get-url", "origin"], env);
}

export type RemoteErrorCode = "remote_auth_failed" | "remote_unreachable";

/** Map a failed remote command to a code; `null` for an error that is not a `GitError`. */
export function classifyRemoteError(err: unknown): RemoteErrorCode | null {
  if (!(err instanceof GitError)) return null;
  return err.permissionDenied ? "remote_auth_failed" : "remote_unreachable";
}

export interface GitApi {
  pullRebase: typeof pullRebase;
  commitFile: typeof commitFile;
  push: typeof push;
  headSha: typeof headSha;
  unstageFile: typeof unstageFile;
  moveFile: typeof moveFile;
  commitPaths: typeof commitPaths;
}

export const defaultGit: GitApi = {
  pullRebase,
  commitFile,
  push,
  headSha,
  unstageFile,
  moveFile,
  commitPaths,
};
