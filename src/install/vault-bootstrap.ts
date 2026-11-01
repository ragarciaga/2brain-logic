import { access } from "node:fs/promises";
import { join } from "node:path";
import { type CliIo, initVault, TEMPLATE_DIR } from "../cli.js";
import {
  addPaths,
  classifyRemoteError,
  cloneInto,
  commitPaths,
  type GitAuthor,
  GitError,
  lsRemote,
  pushBranch,
} from "../git/index.js";

export type BootstrapCode =
  | "done"
  | "remote_unreachable"
  | "remote_auth_failed"
  | "push_refused"
  | "project_not_writable";

export interface BootstrapResult {
  code: BootstrapCode;
  /** A fixed sentence; never holds the remote, git output or a path. */
  fix: string;
  /** True when this call committed and pushed the template. */
  seeded: boolean;
}

export interface BootstrapDeps {
  cloneInto: typeof cloneInto;
  lsRemote: typeof lsRemote;
  addPaths: typeof addPaths;
  commitPaths: typeof commitPaths;
  pushBranch: typeof pushBranch;
  initVault: typeof initVault;
}

export const defaultBootstrapDeps: BootstrapDeps = {
  cloneInto,
  lsRemote,
  addPaths,
  commitPaths,
  pushBranch,
  initVault,
};

export interface BootstrapOptions {
  remote: string;
  vaultDir: string;
  author: GitAuthor;
  /** Extra git environment, for example GIT_SSH_COMMAND. */
  gitEnv?: Record<string, string>;
  templateDir?: string;
}

export const FIX_UNREACHABLE =
  "check VAULT_REMOTE, the network and secrets/known_hosts, then re-run setup";
export const FIX_AUTH =
  "add secrets/deploy_key.pub to the repository as a deploy key with write access, then re-run setup";
export const FIX_OWNERSHIP =
  "make the project directory writable by the current user, then re-run setup";

export const SEED_MESSAGE = "2brain: seed vault template";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function remoteFailure(error: unknown): BootstrapResult {
  const code = classifyRemoteError(error) ?? "remote_unreachable";
  return {
    code,
    fix: code === "remote_auth_failed" ? FIX_AUTH : FIX_UNREACHABLE,
    seeded: false,
  };
}

/**
 * Make `vaultDir` a clone of `remote`. An empty remote gets one commit with the vault template,
 * pushed to `main`. Results carry fixed fix lines only: no git output, no remote URL.
 */
export async function bootstrapVault(
  opts: BootstrapOptions,
  deps: BootstrapDeps = defaultBootstrapDeps,
): Promise<BootstrapResult> {
  const env = opts.gitEnv ?? {};
  let branches: string[];
  try {
    if (!(await exists(join(opts.vaultDir, ".git")))) {
      await deps.cloneInto(opts.remote, opts.vaultDir, env);
    }
    branches = await deps.lsRemote(opts.vaultDir, "origin", env);
  } catch (error) {
    return remoteFailure(error);
  }
  if (branches.length > 0) {
    // T11 adds the existing-vault rules (config checks, origin mismatch).
    return { code: "done", fix: "", seeded: false };
  }

  const copied: string[] = [];
  const captureIo: CliIo = {
    stdout(line) {
      if (line.startsWith("copied ")) copied.push(line.slice("copied ".length));
    },
    stderr() {},
    stdinIsTTY: false,
    readStdin: () => Promise.reject(new Error("stdin is not available")),
  };
  const exit = await deps.initVault(opts.vaultDir, captureIo, opts.templateDir ?? TEMPLATE_DIR);
  if (exit !== 0) return { code: "project_not_writable", fix: FIX_OWNERSHIP, seeded: false };
  if (copied.length === 0) return { code: "done", fix: "", seeded: false };

  await deps.addPaths(opts.vaultDir, copied);
  // Only the copied paths are committed: anything else already staged stays out.
  await deps.commitPaths(opts.vaultDir, copied, SEED_MESSAGE, opts.author);
  try {
    await deps.pushBranch(opts.vaultDir, "main", env);
  } catch (error) {
    // The commit stays local; T12 handles the re-run push.
    if (error instanceof GitError) return { code: "push_refused", fix: FIX_AUTH, seeded: false };
    throw error;
  }
  return { code: "done", fix: "", seeded: true };
}
