import { access } from "node:fs/promises";
import { join } from "node:path";
import { type CliIo, initVault, TEMPLATE_DIR } from "../cli.js";
import { CONFIG_FILE, ConfigInvalidError, loadVaultConfig } from "../config/vault-config.js";
import {
  addPaths,
  classifyRemoteError,
  cloneInto,
  commitPaths,
  currentBranch,
  type GitAuthor,
  GitError,
  hasCommits,
  lsRemote,
  originUrl,
  pushBranch,
} from "../git/index.js";

export type BootstrapCode =
  | "done"
  | "remote_unreachable"
  | "remote_auth_failed"
  | "push_refused"
  | "project_not_writable"
  | "vault_remote_mismatch"
  | "config_invalid";

export interface BootstrapResult {
  code: BootstrapCode;
  /** A fixed sentence; never holds the remote, git output or a path. */
  fix: string;
  /** True when this call committed and pushed the template. */
  seeded: boolean;
  /** Set only on `config_invalid`: the config file, relative to the vault. */
  file?: string;
  /** Set only on `config_invalid`: the dot-joined key path, control characters replaced by `?`. */
  keyPath?: string;
}

export interface BootstrapDeps {
  cloneInto: typeof cloneInto;
  lsRemote: typeof lsRemote;
  addPaths: typeof addPaths;
  commitPaths: typeof commitPaths;
  pushBranch: typeof pushBranch;
  initVault: typeof initVault;
  originUrl: typeof originUrl;
  hasCommits: typeof hasCommits;
  currentBranch: typeof currentBranch;
  loadVaultConfig: typeof loadVaultConfig;
}

export const defaultBootstrapDeps: BootstrapDeps = {
  cloneInto,
  lsRemote,
  addPaths,
  commitPaths,
  pushBranch,
  initVault,
  originUrl,
  hasCommits,
  currentBranch,
  loadVaultConfig,
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
export const FIX_MISMATCH =
  "VAULT_DIR holds a clone of another repository; set VAULT_REMOTE to its origin or use an empty vault directory, then re-run setup";
export const FIX_CONFIG = "correct the named key in the vault config, then re-run setup";

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

const mismatch = (): BootstrapResult => ({
  code: "vault_remote_mismatch",
  fix: FIX_MISMATCH,
  seeded: false,
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Copy the missing template files, commit only those and push to `branch`. */
async function seedTemplate(
  opts: BootstrapOptions,
  deps: BootstrapDeps,
  branch: string,
): Promise<BootstrapResult> {
  const env = opts.gitEnv ?? {};
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
    await deps.pushBranch(opts.vaultDir, branch, env);
  } catch (error) {
    // The commit stays local; T12 handles the re-run push.
    if (error instanceof GitError) return { code: "push_refused", fix: FIX_AUTH, seeded: false };
    throw error;
  }
  return { code: "done", fix: "", seeded: true };
}

/**
 * Make `vaultDir` a clone of `remote`.
 * - No clone yet: clone. An existing clone whose origin is not exactly `remote` (or has none) is
 *   `vault_remote_mismatch`, before any remote call.
 * - Empty remote and no local commits: one commit with the vault template, pushed to `main`.
 * - Otherwise, no `.2brain/config.yaml`: copy the missing template files, commit them and push to
 *   the current branch (a detached HEAD, or a local-only history on an empty remote, is a mismatch).
 * - Valid config: nothing to do. Invalid config: `config_invalid` with the file and key path.
 * Results carry fixed fix lines only: no git output, no remote URL, no parser detail.
 */
export async function bootstrapVault(
  opts: BootstrapOptions,
  deps: BootstrapDeps = defaultBootstrapDeps,
): Promise<BootstrapResult> {
  const env = opts.gitEnv ?? {};
  let branches: string[];
  let localCommits: boolean;
  try {
    if (!(await exists(join(opts.vaultDir, ".git")))) {
      await deps.cloneInto(opts.remote, opts.vaultDir, env);
    }
  } catch (error) {
    return remoteFailure(error);
  }
  try {
    if ((await deps.originUrl(opts.vaultDir, env)) !== opts.remote) return mismatch();
  } catch {
    return mismatch();
  }
  try {
    branches = await deps.lsRemote(opts.vaultDir, "origin", env);
    localCommits = await deps.hasCommits(opts.vaultDir);
  } catch (error) {
    return remoteFailure(error);
  }
  if (branches.length === 0 && !localCommits) return seedTemplate(opts, deps, "main");

  if (await exists(join(opts.vaultDir, CONFIG_FILE))) {
    try {
      await deps.loadVaultConfig(opts.vaultDir);
    } catch (error) {
      const keyPath = error instanceof ConfigInvalidError ? error.keyPath : "";
      return {
        code: "config_invalid",
        fix: FIX_CONFIG,
        file: CONFIG_FILE,
        keyPath: keyPath.replace(CONTROL_CHARS, "?"),
        seeded: false,
      };
    }
    return { code: "done", fix: "", seeded: false };
  }
  // No config: only a vault with a remote history can be filled in.
  if (branches.length === 0) return mismatch();
  let branch: string;
  try {
    branch = await deps.currentBranch(opts.vaultDir);
  } catch {
    return mismatch();
  }
  return seedTemplate(opts, deps, branch);
}
