import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_AUTHOR = { name: "Test Author", email: "author@example.com" };

const ISOLATION_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;

/** Run git synchronously in tests (fixtures and assertions only; production uses src/git/). */
export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return gitRaw(cwd, args, env).trim();
}

/** Like `git`, but keeps the output exactly as git printed it (trailing newline included). */
export function gitRaw(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Seed",
      GIT_AUTHOR_EMAIL: "seed@example.com",
      GIT_COMMITTER_NAME: "Seed",
      GIT_COMMITTER_EMAIL: "seed@example.com",
      ...env,
    },
  });
}

export interface GitFixture {
  root: string;
  /** Bare repository acting as the remote. */
  remote: string;
  /** Path where the service clones the vault (does not exist yet). */
  vaultDir: string;
  /** Make another clone of the remote, as a second writer would have. */
  cloneElsewhere(name: string): string;
  cleanup(): void;
}

/**
 * A bare remote with one seed commit on `main`. Git config is isolated from the machine
 * (empty global file, no system file) for the whole process until `cleanup`.
 */
export function createGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "2brain-fixture-"));
  const emptyConfig = join(root, "empty-gitconfig");
  writeFileSync(emptyConfig, "");
  const previous: Record<string, string | undefined> = {};
  for (const key of ISOLATION_KEYS) previous[key] = process.env[key];
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(root, "seed");
  git(root, ["clone", remote, seed]);
  git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["push", "origin", "main"]);

  return {
    root,
    remote,
    vaultDir: join(root, "vault"),
    cloneElsewhere(name) {
      const dir = join(root, name);
      git(root, ["clone", remote, dir]);
      return dir;
    },
    cleanup() {
      for (const key of ISOLATION_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
