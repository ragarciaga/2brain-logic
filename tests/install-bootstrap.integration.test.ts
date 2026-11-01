import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../src/cli.js";
import { cloneInto, GitError, originUrl } from "../src/git/index.js";
import {
  type BootstrapDeps,
  bootstrapVault,
  defaultBootstrapDeps,
} from "../src/install/vault-bootstrap.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const AUTHOR = { name: "Seed Author", email: "seed-author@example.com" };
const MARKER = "SECRETMARKER4242";

let fixture: GitFixture;
let empty: string;

beforeEach(() => {
  fixture = createGitFixture();
  empty = join(fixture.root, "empty.git");
  mkdirSync(empty);
  git(fixture.root, ["init", "--bare", "--initial-branch=trunk", empty]);
});

afterEach(() => {
  fixture.cleanup();
});

function templateFiles(): string[] {
  return git(TEMPLATE_DIR, ["ls-files", "--others", "--cached", "--exclude-standard", "."])
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
}

describe("bootstrapVault", () => {
  it("clones when there is no clone", async () => {
    await bootstrapVault({ remote: empty, vaultDir: fixture.vaultDir, author: AUTHOR });
    expect(existsSync(join(fixture.vaultDir, ".git"))).toBe(true);
    expect(await originUrl(fixture.vaultDir)).toBe(empty);
  });

  it("seeds an empty remote with one commit holding only the template", async () => {
    const deps: BootstrapDeps = {
      ...defaultBootstrapDeps,
      cloneInto: async (remote, dir, env) => {
        await cloneInto(remote, dir, env);
        writeFileSync(join(dir, "stray.txt"), "not template\n");
      },
    };
    const result = await bootstrapVault(
      { remote: empty, vaultDir: fixture.vaultDir, author: AUTHOR },
      deps,
    );
    expect(result).toEqual({ code: "done", fix: "", seeded: true });
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    expect(git(fixture.vaultDir, ["symbolic-ref", "--short", "HEAD"])).toBe("trunk");
    expect(git(empty, ["rev-parse", "main"])).toBe(head);
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%an|%ae|%cn|%ce|%s"])).toBe(
      "Seed Author|seed-author@example.com|Seed Author|seed-author@example.com|2brain: seed vault template",
    );
    expect(git(fixture.vaultDir, ["rev-list", "--count", "HEAD"])).toBe("1");
    const committed = git(fixture.vaultDir, ["show", "--name-only", "--format=", "HEAD"])
      .split("\n")
      .sort();
    expect(committed).toEqual(templateFiles());
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("?? stray.txt");
  });

  it("maps clone failures to codes without leaking the remote or git output", async () => {
    const captured: string[] = [];
    const missing = join(fixture.root, `missing-${MARKER}.git`);
    const unreachable = await bootstrapVault({
      remote: missing,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    const denied = await bootstrapVault(
      { remote: `${empty}-${MARKER}`, vaultDir: fixture.vaultDir, author: AUTHOR },
      {
        ...defaultBootstrapDeps,
        cloneInto: async () => {
          throw new GitError("clone", 128, true);
        },
      },
    );
    expect(unreachable.code).toBe("remote_unreachable");
    expect(denied.code).toBe("remote_auth_failed");
    for (const result of [unreachable, denied]) {
      expect(result.fix.length).toBeGreaterThan(0);
      expect(result.seeded).toBe(false);
      captured.push(JSON.stringify(result));
    }
    expect(captured.join("\n")).not.toContain(MARKER);
    expect(existsSync(join(fixture.vaultDir, ".git"))).toBe(false);
  });

  it("leaves a non-empty remote untouched", async () => {
    const seed = git(fixture.remote, ["rev-parse", "main"]);
    const result = await bootstrapVault({
      remote: fixture.remote,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
    });
    expect(result).toEqual({ code: "done", fix: "", seeded: false });
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(seed);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(seed);
    expect(git(fixture.vaultDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("keeps the commit when the push is refused", async () => {
    const result = await bootstrapVault(
      { remote: empty, vaultDir: fixture.vaultDir, author: AUTHOR },
      {
        ...defaultBootstrapDeps,
        pushBranch: async () => {
          throw new GitError("push", 1);
        },
      },
    );
    expect(result.code).toBe("push_refused");
    expect(result.fix.length).toBeGreaterThan(0);
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe("2brain: seed vault template");
    expect(git(empty, ["for-each-ref"])).toBe("");
  });

  it("returns project_not_writable when the template copy fails", async () => {
    const result = await bootstrapVault({
      remote: empty,
      vaultDir: fixture.vaultDir,
      author: AUTHOR,
      templateDir: join(fixture.root, "no-template"),
    });
    expect(result.code).toBe("project_not_writable");
    expect(git(empty, ["for-each-ref"])).toBe("");
  });
});
