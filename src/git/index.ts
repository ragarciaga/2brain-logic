import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A git command failed. It carries only the subcommand name and the exit code: stderr, the
 * command line and the underlying error are dropped on purpose, because a remote URL may hold
 * credentials and git echoes it in its messages.
 */
export class GitError extends Error {
  readonly subcommand: string;
  readonly exitCode: number | null;

  constructor(subcommand: string, exitCode: number | null) {
    super(`git ${subcommand} failed (exit ${exitCode ?? "unknown"})`);
    this.name = "GitError";
    this.subcommand = subcommand;
    this.exitCode = exitCode;
  }
}

export interface GitAuthor {
  name: string;
  email: string;
}

function committerEnv(author: GitAuthor): Record<string, string> {
  return { GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
}

/** Run git with an argument array (never a shell string) and return trimmed stdout. */
export async function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      // Last, so no caller can override it: a path is a file name, never a glob or pathspec magic.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, GIT_LITERAL_PATHSPECS: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new GitError(args[0] ?? "unknown", typeof code === "number" ? code : null);
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
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
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

export interface GitApi {
  pullRebase: typeof pullRebase;
  commitFile: typeof commitFile;
  push: typeof push;
  headSha: typeof headSha;
  unstageFile: typeof unstageFile;
}

export const defaultGit: GitApi = { pullRebase, commitFile, push, headSha, unstageFile };
