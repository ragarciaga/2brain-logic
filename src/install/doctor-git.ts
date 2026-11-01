import { access } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ConfigInvalidError, loadVaultConfig } from "../config/vault-config.js";
import {
  assertBranchName,
  GitError,
  lsRemote,
  pushDryRun,
  REMOTE_TIMEOUT_MS,
  runGit,
} from "../git/index.js";
import type { CheckOutcome, DoctorCheck } from "./doctor.js";

// Every fix line below is a fixed string. None holds raw git output, the remote URL or
// `VAULT_REMOTE`, and none contains the word "git": the redactor replaces the userinfo of
// `VAULT_REMOTE` (often "git") wherever it appears.
export const FIX_NO_CLONE = "the vault clone is missing: run setup";
export const FIX_NO_BRANCH = "the vault clone is not on a branch: run setup";
export const FIX_REMOTE_TIMEOUT = `the remote did not answer within ${REMOTE_TIMEOUT_MS / 1000} seconds: check the network and the host name in the remote address`;
export const FIX_REMOTE_AUTH =
  "the remote refused the deploy key: check secrets/deploy_key.pub is registered and the host key in secrets/known_hosts";
export const FIX_REMOTE_UNREACHABLE =
  "the remote did not answer: check the deploy key and the host key in secrets/known_hosts";
export const FIX_WRITE_ACCESS =
  "add secrets/deploy_key.pub to the repository as a deploy key with write access";

export interface GitCheckDeps {
  lsRemote(cwd: string, remote: string): Promise<string[]>;
  pushDryRun(dir: string): Promise<void>;
  currentBranch(dir: string): Promise<string>;
  loadVaultConfig(vaultDir: string): Promise<unknown>;
  hasClone(dir: string): Promise<boolean>;
}

const defaultDeps: GitCheckDeps = {
  lsRemote: (cwd, remote) => lsRemote(cwd, remote),
  pushDryRun: (dir) => pushDryRun(dir),
  currentBranch: (dir) => runGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  loadVaultConfig,
  hasClone: async (dir) => {
    try {
      await access(join(dir, ".git"));
      return true;
    } catch {
      return false;
    }
  },
};

class TimedOut extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut("timeout")), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

function isTimeout(err: unknown): boolean {
  return err instanceof TimedOut || (err instanceof GitError && err.exitCode === null);
}

const fail = (fix: string): CheckOutcome => ({ status: "fail", fix });

/** The read-only remote and vault checks: `remote_reachable`, `remote_pushable`, `vault_config`. */
export function createGitChecks(opts: {
  vaultDir: string;
  deps?: Partial<GitCheckDeps>;
}): DoctorCheck[] {
  const deps: GitCheckDeps = { ...defaultDeps, ...opts.deps };
  const dir = opts.vaultDir;

  const remoteReachable: DoctorCheck = {
    id: "remote_reachable",
    async run() {
      if (!(await deps.hasClone(dir))) return fail(FIX_NO_CLONE);
      try {
        await withTimeout(deps.lsRemote(dir, "origin"), REMOTE_TIMEOUT_MS);
        return { status: "pass" };
      } catch (err) {
        if (isTimeout(err)) return fail(FIX_REMOTE_TIMEOUT);
        if (err instanceof GitError) {
          return fail(err.permissionDenied ? FIX_REMOTE_AUTH : FIX_REMOTE_UNREACHABLE);
        }
        throw err;
      }
    },
  };

  const remotePushable: DoctorCheck = {
    id: "remote_pushable",
    async run() {
      if (!(await deps.hasClone(dir))) return fail(FIX_NO_CLONE);
      try {
        assertBranchName(await deps.currentBranch(dir));
      } catch {
        return fail(FIX_NO_BRANCH);
      }
      try {
        await withTimeout(deps.pushDryRun(dir), REMOTE_TIMEOUT_MS);
        return { status: "pass" };
      } catch (err) {
        if (isTimeout(err)) return fail(FIX_REMOTE_TIMEOUT);
        if (err instanceof GitError) return fail(FIX_WRITE_ACCESS);
        throw err;
      }
    },
  };

  const vaultConfig: DoctorCheck = {
    id: "vault_config",
    async run() {
      if (!(await deps.hasClone(dir))) return fail(FIX_NO_CLONE);
      try {
        await deps.loadVaultConfig(dir);
        return { status: "pass" };
      } catch (err) {
        if (err instanceof ConfigInvalidError) {
          return fail(
            err.keyPath === ""
              ? `${CONFIG_FILE} is not valid YAML: correct it or re-run setup`
              : `${CONFIG_FILE} is invalid at ${err.keyPath}: correct it or re-run setup`,
          );
        }
        return fail(`cannot read ${CONFIG_FILE}: check its permissions`);
      }
    },
  };

  return [remoteReachable, remotePushable, vaultConfig];
}
