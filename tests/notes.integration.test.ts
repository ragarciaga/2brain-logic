import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGit, ensureClone, type GitApi } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import { parseNote } from "../src/vault/frontmatter.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";

let fixture: GitFixture;
let gitCalls: string[];
let logs: string[];

function spyGit(): GitApi {
  return {
    pullRebase: (...args) => {
      gitCalls.push("pullRebase");
      return defaultGit.pullRebase(...args);
    },
    commitFile: (...args) => {
      gitCalls.push("commitFile");
      return defaultGit.commitFile(...args);
    },
    push: (...args) => {
      gitCalls.push("push");
      return defaultGit.push(...args);
    },
  };
}

function makeWriter() {
  return createNoteWriter({ vaultDir: fixture.vaultDir, author: TEST_AUTHOR, git: spyGit() });
}

function makeApp() {
  return createApp({ writer: makeWriter(), log: (message) => logs.push(message) });
}

function post(app: ReturnType<typeof createApp>, payload: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

function remoteSha(): string {
  return git(fixture.remote, ["rev-parse", "main"]);
}

function remoteFile(path: string): string {
  return gitRaw(fixture.remote, ["show", `main:${path}`]);
}

function listVault(): string[] {
  return readdirSync(fixture.vaultDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => !entry.startsWith(".git"))
    .sort();
}

beforeEach(async () => {
  fixture = createGitFixture();
  gitCalls = [];
  logs = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

describe("ensureClone", () => {
  it("clones into an empty directory", () => {
    expect(readdirSync(fixture.vaultDir)).toContain("README.md");
  });

  it("does not clone again when the directory is already a repository", async () => {
    await expect(
      ensureClone(fixture.vaultDir, join(fixture.root, "nowhere.git")),
    ).resolves.toBeUndefined();
    expect(readdirSync(fixture.vaultDir)).toContain("README.md");
  });

  it("throws when there is neither a repository nor a remote", async () => {
    await expect(ensureClone(join(fixture.root, "other"), undefined)).rejects.toThrow(
      /VAULT_REMOTE/,
    );
  });
});

describe("POST /notes against a real remote", () => {
  it("D3: writes, commits as the configured author and pushes to remote main", async () => {
    const app = makeApp();
    const input = {
      path: "Inbox/idea.md",
      frontmatter: { title: "Idea", tags: ["a", "b"] },
      body: "First line\n\nSecond line\n",
    };
    const response = await post(app, input);
    expect(response.status).toBe(201);
    const result = (await response.json()) as { ok: boolean; path: string; commit: string };
    expect(result.ok).toBe(true);
    expect(result.path).toBe("Inbox/idea.md");
    expect(result.commit).toBe(remoteSha());

    const parsed = parseNote(remoteFile("Inbox/idea.md"));
    expect(parsed.data).toEqual(input.frontmatter);
    expect(parsed.content).toBe(input.body);

    const author = git(fixture.remote, ["log", "-1", "--format=%an <%ae>", "main"]);
    expect(author).toBe(`${TEST_AUTHOR.name} <${TEST_AUTHOR.email}>`);
  });

  it("D4: pulls with rebase first, so another clone's commit stays an ancestor", async () => {
    const other = fixture.cloneElsewhere("other");
    writeFileSync(join(other, "from-other.md"), "other\n");
    git(other, ["add", "from-other.md"]);
    git(other, ["commit", "-m", "other writer"]);
    git(other, ["push", "origin", "main"]);
    const otherSha = git(other, ["rev-parse", "HEAD"]);

    const response = await post(makeApp(), { path: "mine.md", frontmatter: {}, body: "mine\n" });
    expect(response.status).toBe(201);
    const { commit } = (await response.json()) as { commit: string };
    // Throws (non-zero exit) unless otherSha is an ancestor of our pushed commit.
    git(fixture.remote, ["merge-base", "--is-ancestor", otherSha, commit]);
    expect(remoteSha()).toBe(commit);
    expect(gitCalls[0]).toBe("pullRebase");
  });

  describe("D5: a malformed request changes nothing and never reaches git", () => {
    const cases: Array<[string, unknown]> = [
      ["non-JSON text", "not json at all"],
      ["missing body", { path: "a.md", frontmatter: {} }],
      ["frontmatter not an object", { path: "a.md", frontmatter: "x", body: "b" }],
      ["a .. segment", { path: "a/../b.md", frontmatter: {}, body: "b" }],
      ["an absolute path", { path: "/tmp/b.md", frontmatter: {}, body: "b" }],
      ["not .md", { path: "a/b.txt", frontmatter: {}, body: "b" }],
      ["a .git segment", { path: ".git/x.md", frontmatter: {}, body: "b" }],
      ["a nested dot segment", { path: "a/.obsidian/x.md", frontmatter: {}, body: "b" }],
      ["a NUL in the path", { path: "a\u0000b.md", frontmatter: {}, body: "b" }],
      ["a control character in the path", { path: "a\tb.md", frontmatter: {}, body: "b" }],
    ];

    it.each(cases)("%s", async (_name, payload) => {
      const shaBefore = remoteSha();
      const listingBefore = listVault();
      const response = await post(makeApp(), payload);
      expect(response.status).toBe(400);
      expect(gitCalls).toEqual([]);
      expect(remoteSha()).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
    });
  });

  it("D6: an existing path returns 409 and makes no commit", async () => {
    const app = makeApp();
    const first = await post(app, { path: "dup.md", frontmatter: { v: 1 }, body: "one\n" });
    expect(first.status).toBe(201);
    const shaBefore = remoteSha();

    const second = await post(app, { path: "dup.md", frontmatter: { v: 2 }, body: "two\n" });
    expect(second.status).toBe(409);
    expect(remoteSha()).toBe(shaBefore);
    expect(parseNote(remoteFile("dup.md")).data).toEqual({ v: 1 });
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("D6: a path that exists only on the remote returns 409 after the pull", async () => {
    const shaBefore = remoteSha();
    const response = await post(makeApp(), { path: "README.md", frontmatter: {}, body: "x\n" });
    expect(response.status).toBe(409);
    expect(remoteSha()).toBe(shaBefore);
  });

  it("D7: two concurrent valid POSTs both return 201 and both notes reach the remote", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      post(app, { path: "a.md", frontmatter: { n: "a" }, body: "a\n" }),
      post(app, { path: "b.md", frontmatter: { n: "b" }, body: "b\n" }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(parseNote(remoteFile("a.md")).data).toEqual({ n: "a" });
    expect(parseNote(remoteFile("b.md")).data).toEqual({ n: "b" });
  });

  it("D16: a ---js body is stored as content, not frontmatter, and runs no code", async () => {
    const body = "---js\nglobalThis.__pwnedIntegration = true\n---\nreal\n";
    const response = await post(makeApp(), { path: "inj.md", frontmatter: {}, body });
    expect(response.status).toBe(201);
    const stored = remoteFile("inj.md");
    expect(stored.startsWith("---\n")).toBe(true);
    const viaDefaultMatter = matter(stored);
    expect(viaDefaultMatter.data).toEqual({});
    expect(viaDefaultMatter.content).toBe(body);
    expect((globalThis as Record<string, unknown>).__pwnedIntegration).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["no trailing newline", "no newline"],
    ["one trailing newline", "a\n"],
    ["two trailing newlines", "a\n\n"],
    ["CRLF", "a\r\nb\r\n"],
  ])("D3: the %s body is stored exactly as sent", async (name, body) => {
    const slug = name.replaceAll(" ", "-");
    for (const [kind, frontmatter] of [
      ["empty", {}],
      ["full", { title: "T", n: 2 }],
    ] as const) {
      const path = `rt/${slug}-${kind}.md`;
      const response = await post(makeApp(), { path, frontmatter, body });
      expect(response.status).toBe(201);
      const parsed = parseNote(remoteFile(path));
      expect(parsed.data).toEqual(frontmatter);
      expect(parsed.content).toBe(body);
    }
  });

  it("D16: a body that starts with its own fence round-trips with the input frontmatter", async () => {
    const body = "---\nk: v\n---\ntext\n";
    const response = await post(makeApp(), { path: "fence.md", frontmatter: { a: 1 }, body });
    expect(response.status).toBe(201);
    const parsed = parseNote(remoteFile("fence.md"));
    expect(parsed.data).toEqual({ a: 1 });
    expect(parsed.content).toBe(body);
  });

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "2brain-outside-"));
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it("rejects a parent directory symlinked outside the vault and writes nothing there", async () => {
      symlinkSync(outside, join(fixture.vaultDir, "link"));
      const shaBefore = remoteSha();
      const response = await post(makeApp(), { path: "link/x.md", frontmatter: {}, body: "x\n" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(readdirSync(outside)).toEqual([]);
      expect(remoteSha()).toBe(shaBefore);
      expect(logs.join("\n")).not.toContain(outside);
    });

    it("does not let mkdir -p create directories outside the vault through a symlink", async () => {
      symlinkSync(outside, join(fixture.vaultDir, "link"));
      const response = await post(makeApp(), {
        path: "link/new/deeper/x.md",
        frontmatter: {},
        body: "x\n",
      });
      expect(response.status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(outside, "new"))).toBe(false);
    });

    it("rejects a symlink to a file at the target path without writing through it", async () => {
      const victim = join(outside, "victim.md");
      writeFileSync(victim, "keep\n");
      symlinkSync(victim, join(fixture.vaultDir, "ln.md"));
      const response = await post(makeApp(), { path: "ln.md", frontmatter: {}, body: "x\n" });
      expect(response.status).toBe(409);
      expect(readdirSync(outside)).toEqual(["victim.md"]);
    });
  });

  it("D19: a failing push leaks no URL marker into the response, logs or error", async () => {
    const marker = "SECRETMARKER";
    const badUrl = `file://${join(fixture.root, `missing-${marker}`, "r.git")}`;
    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl]);

    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];

    const response = await post(makeApp(), { path: "p.md", frontmatter: {}, body: "x\n" });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(marker);
    expect(logs.join("\n")).not.toContain(marker);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
    }
    expect(logs).toEqual(["write_failed: git push exit 128"]);

    let caught: unknown;
    try {
      await createNoteWriter({
        vaultDir: fixture.vaultDir,
        author: TEST_AUTHOR,
        git: defaultGit,
      }).write({ path: "q.md", frontmatter: {}, body: "x\n" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).not.toContain(marker);
    expect(inspect(err, { depth: 5 })).not.toContain(marker);
    expect(err.cause).toBeUndefined();
  });
});
