import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../src/cli.js";
import { ConfigInvalidError } from "../src/config/vault-config.js";
import { CLONE_TIMEOUT_MS, cloneInto } from "../src/git/index.js";
import {
  type BootstrapDeps,
  bootstrapVault,
  defaultBootstrapDeps,
  FIX_CONFIG,
  FIX_MISMATCH,
} from "../src/install/vault-bootstrap.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const AUTHOR = { name: "Seed Author", email: "seed-author@example.com" };
const MARKER = "SECRETMARKER4242";

let fixture: GitFixture;

beforeEach(() => {
  fixture = createGitFixture();
});

afterEach(() => {
  fixture.cleanup();
});

/** Commit `files` to the fixture remote on `branch` through a second clone. */
function pushFiles(files: Record<string, string>, branch = "main"): void {
  const other = fixture.cloneElsewhere(`writer-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(other, rel, ".."), { recursive: true });
    writeFileSync(join(other, rel), content);
    git(other, ["add", rel]);
  }
  git(other, ["commit", "-m", "files"]);
  git(other, ["push", "origin", `HEAD:refs/heads/${branch}`]);
}

function templateFiles(): string[] {
  return git(TEMPLATE_DIR, ["ls-files", "--others", "--cached", "--exclude-standard", "."])
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
}

function counting(): { deps: BootstrapDeps; calls: { ls: number; push: number; init: number } } {
  const calls = { ls: 0, push: 0, init: 0 };
  return {
    calls,
    deps: {
      ...defaultBootstrapDeps,
      lsRemote: (...a) => {
        calls.ls += 1;
        return defaultBootstrapDeps.lsRemote(...a);
      },
      pushBranch: (...a) => {
        calls.push += 1;
        return defaultBootstrapDeps.pushBranch(...a);
      },
      initVault: (...a) => {
        calls.init += 1;
        return defaultBootstrapDeps.initVault(...a);
      },
    },
  };
}

describe("bootstrapVault on an existing vault", () => {
  it("passes the clone timeout explicitly", async () => {
    const seen: unknown[] = [];
    await bootstrapVault(
      { remote: fixture.remote, vaultDir: fixture.vaultDir, author: AUTHOR },
      {
        ...defaultBootstrapDeps,
        cloneInto: async (remote, dir, env, timeoutMs) => {
          seen.push(timeoutMs);
          await cloneInto(remote, dir, env);
        },
      },
    );
    expect(seen).toEqual([CLONE_TIMEOUT_MS]);
  });

  it.each(["main", "trunk"])("fills missing template files (remote branch %s)", async (branch) => {
    pushFiles({ "notes/a.md": "note\n", "inbox/README.md": "custom\n" }, branch);
    if (branch !== "main") git(fixture.remote, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    const result = await bootstrapVault({
      remote: fixture.remote,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result).toEqual({ code: "done", fix: "", seeded: true });
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    expect(git(fixture.remote, ["rev-parse", branch])).toBe(head);
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%an|%ae|%s"])).toBe(
      "Seed Author|seed-author@example.com|2brain: seed vault template",
    );
    expect(
      git(fixture.vaultDir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort(),
    ).toEqual(templateFiles().filter((f) => f !== "inbox/README.md"));
    expect(readFileSync(join(fixture.vaultDir, "inbox/README.md"), "utf8")).toBe("custom\n");
    expect(readFileSync(join(fixture.vaultDir, "notes/a.md"), "utf8")).toBe("note\n");
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("a valid config is a no-op", async () => {
    pushFiles({ ".2brain/config.yaml": "version: 1\n" });
    await cloneInto(fixture.remote, fixture.vaultDir);
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    const count = git(fixture.vaultDir, ["rev-list", "--count", "HEAD"]);
    const result = await bootstrapVault({
      remote: fixture.remote,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result).toEqual({ code: "done", fix: "", seeded: false });
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["rev-list", "--count", "HEAD"])).toBe(count);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("an invalid config names the file and key without parser detail", async () => {
    pushFiles({ ".2brain/config.yaml": "version: 1\nvault:\n  bogus: 1\n" });
    const before = git(fixture.remote, ["rev-parse", "main"]);
    const result = await bootstrapVault({
      remote: fixture.remote,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result).toEqual({
      code: "config_invalid",
      fix: FIX_CONFIG,
      file: ".2brain/config.yaml",
      keyPath: "vault.bogus",
      seeded: false,
    });
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(before);
  });

  it("unparsable YAML gives an empty key path and never echoes the content", async () => {
    pushFiles({ ".2brain/config.yaml": `key: [unclosed\n${MARKER}: : :\n` });
    const result = await bootstrapVault({
      remote: fixture.remote,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result.code).toBe("config_invalid");
    expect(result.keyPath).toBe("");
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("replaces control characters in the key path", async () => {
    pushFiles({ ".2brain/config.yaml": "version: 1\n" });
    const result = await bootstrapVault(
      { remote: fixture.remote, vaultDir: fixture.vaultDir, author: AUTHOR },
      {
        ...defaultBootstrapDeps,
        loadVaultConfig: async () => {
          throw new ConfigInvalidError(".2brain/config.yaml", "a\u001b[31mb", "x");
        },
      },
    );
    expect(result.keyPath).toBe("a?[31mb");
  });

  it("an origin mismatch changes nothing and leaks no URL", async () => {
    const vault = join(fixture.root, `vault-${MARKER}`);
    await cloneInto(fixture.remote, vault);
    const otherRemote = join(fixture.root, `other-${MARKER}.git`);
    git(fixture.root, ["init", "--bare", otherRemote]);
    const head = git(vault, ["rev-parse", "HEAD"]);
    const remoteConfig = git(vault, ["config", "--get-regexp", "^remote"]);
    const { deps, calls } = counting();
    const result = await bootstrapVault(
      { remote: otherRemote, vaultDir: vault, author: AUTHOR },
      deps,
    );
    expect(result).toEqual({
      code: "vault_remote_mismatch",
      fix: FIX_MISMATCH,
      seeded: false,
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(calls).toEqual({ ls: 0, push: 0, init: 0 });
    expect(git(vault, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(vault, ["status", "--porcelain"])).toBe("");
    expect(git(vault, ["config", "--get-regexp", "^remote"])).toBe(remoteConfig);
  });

  it("a vault without origin is a mismatch", async () => {
    await cloneInto(fixture.remote, fixture.vaultDir);
    git(fixture.vaultDir, ["remote", "remove", "origin"]);
    const { deps, calls } = counting();
    const result = await bootstrapVault(
      { remote: fixture.remote, vaultDir: fixture.vaultDir, author: AUTHOR },
      deps,
    );
    expect(result.code).toBe("vault_remote_mismatch");
    expect(calls).toEqual({ ls: 0, push: 0, init: 0 });
  });

  it("local commits on an empty remote are never seeded as empty", async () => {
    const empty = join(fixture.root, "empty.git");
    git(fixture.root, ["init", "--bare", "--initial-branch=main", empty]);
    await cloneInto(empty, fixture.vaultDir);
    writeFileSync(join(fixture.vaultDir, "local.md"), "local\n");
    git(fixture.vaultDir, ["add", "local.md"]);
    git(fixture.vaultDir, ["commit", "-m", "local"]);
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    const { deps, calls } = counting();
    const result = await bootstrapVault(
      { remote: empty, vaultDir: fixture.vaultDir, author: AUTHOR },
      deps,
    );
    expect(result.code).toBe("vault_remote_mismatch");
    expect(calls.init).toBe(0);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(empty, ["for-each-ref"])).toBe("");
  });

  it("local commits on an empty remote with an invalid config give config_invalid", async () => {
    const empty = join(fixture.root, "empty.git");
    git(fixture.root, ["init", "--bare", "--initial-branch=main", empty]);
    await cloneInto(empty, fixture.vaultDir);
    mkdirSync(join(fixture.vaultDir, ".2brain"));
    writeFileSync(join(fixture.vaultDir, ".2brain/config.yaml"), "bogus: 1\n");
    git(fixture.vaultDir, ["add", "."]);
    git(fixture.vaultDir, ["commit", "-m", "local"]);
    const result = await bootstrapVault({
      remote: empty,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result.code).toBe("config_invalid");
    expect(result.keyPath).toBe("bogus");
  });

  it("a detached HEAD without config copies nothing", async () => {
    await cloneInto(fixture.remote, fixture.vaultDir);
    git(fixture.vaultDir, ["checkout", "--detach"]);
    const { deps, calls } = counting();
    const result = await bootstrapVault(
      { remote: fixture.remote, vaultDir: fixture.vaultDir, author: AUTHOR },
      deps,
    );
    expect(result.code).toBe("vault_remote_mismatch");
    expect(calls.init).toBe(0);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });
});
