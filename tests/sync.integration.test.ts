import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone, type GitApi, GitError } from "../src/git/index.js";
import { conflictCopyName } from "../src/git/sync.js";
import { createApp } from "../src/server/app.js";
import { stringifyNote } from "../src/vault/frontmatter.js";
import { isSafePathSegment } from "../src/vault/note-schema.js";
import { scrub, scrubFrontmatter } from "../src/vault/scrub/index.js";
import { createNoteWriter, type Scrubber } from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";

const TOKEN = "fictional-integration-token-0123456789-abcdef";
const DAY = "2026-10-31";
// Built from parts at runtime: the CI secret scan reads every commit.
const ANT = ["sk", "ant", "api03", "A".repeat(24)].join("-");

let fixture: GitFixture;
let gitCalls: string[];
let logs: string[];
let clock: () => Date;
let counter = 0;

function spyGit(overrides: Partial<GitApi> = {}): GitApi {
  return {
    ...defaultGit,
    pullRebase: (...args) => {
      gitCalls.push("pullRebase");
      return defaultGit.pullRebase(...args);
    },
    ...overrides,
  };
}

function makeApp(overrides: Partial<GitApi> = {}, scrubber?: Scrubber) {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: spyGit(overrides),
    now: clock,
    log: (message) => logs.push(message),
    ...(scrubber ? { scrubber } : {}),
  });
  return createApp({ writer, ingestToken: TOKEN, log: (message) => logs.push(message) });
}

function post(app: ReturnType<typeof createApp>, payload: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
}

const VALID = { type: "idea", area: "personal", date: "2026-10-31", source: "manual" };

function note(path: string, extra: Record<string, unknown> = {}, body = "x\n") {
  return { path, frontmatter: { ...VALID, ...extra }, body };
}

function bytes(body: string, extra: Record<string, unknown> = {}): string {
  return stringifyNote({ ...VALID, ...extra }, body);
}

function writeIn(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
}

/** Commit files in the vault clone without pushing. */
function localCommit(files: Record<string, string>): string {
  writeIn(fixture.vaultDir, files);
  git(fixture.vaultDir, ["commit", "-m", "local"]);
  return git(fixture.vaultDir, ["rev-parse", "HEAD"]);
}

/** Commit files from a second clone and push. */
function remoteCommit(files: Record<string, string>): string {
  counter += 1;
  const dir = fixture.cloneElsewhere(`other-${counter}`);
  writeIn(dir, files);
  git(dir, ["commit", "-m", "remote"]);
  git(dir, ["push", "origin", "main"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function remoteFile(path: string): string {
  return gitRaw(fixture.remote, ["show", `main:${path}`]);
}

function remoteFiles(): string[] {
  return git(fixture.remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
}

function rebaseDirs(): boolean {
  return (
    existsSync(join(fixture.vaultDir, ".git", "rebase-merge")) ||
    existsSync(join(fixture.vaultDir, ".git", "rebase-apply"))
  );
}

function expectVaultMatchesRemote(): void {
  expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(
    git(fixture.remote, ["rev-parse", "main"]),
  );
  expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  expect(rebaseDirs()).toBe(false);
}

const LOCAL = bytes("local\n");
const REMOTE = bytes("remote\n");
const COPY = `inbox/a (conflict ${DAY}).md`;

beforeEach(async () => {
  fixture = createGitFixture();
  gitCalls = [];
  logs = [];
  clock = () => new Date(`${DAY}T12:00:00Z`);
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  fixture.cleanup();
});

describe("conflictCopyName", () => {
  it("numbers the suffix inside the parentheses", () => {
    expect(conflictCopyName("inbox/a.md", DAY, 1)).toBe(`inbox/a (conflict ${DAY}).md`);
    expect(conflictCopyName("inbox/a.md", DAY, 2)).toBe(`inbox/a (conflict ${DAY} 2).md`);
    expect(conflictCopyName("inbox/a.md", DAY, 3)).toBe(`inbox/a (conflict ${DAY} 3).md`);
  });

  it("keeps any extension, or none, and the folder", () => {
    expect(conflictCopyName("a/b/c.d.txt", DAY, 1)).toBe(`a/b/c.d (conflict ${DAY}).txt`);
    expect(conflictCopyName("noext", DAY, 1)).toBe(`noext (conflict ${DAY})`);
  });

  it("cuts a long multibyte stem at a code point to at most 255 bytes", () => {
    const name = conflictCopyName(`inbox/${"é".repeat(125)}.md`, DAY, 1);
    const base = name.slice("inbox/".length);
    expect(Buffer.byteLength(base)).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(base)).toBeGreaterThan(253);
    expect(base.endsWith(` (conflict ${DAY}).md`)).toBe(true);
    expect(base).not.toContain("�");
    expect(isSafePathSegment(base)).toBe(true);
  });

  it("strips dots left at the end of a cut stem", () => {
    // 255 - len(" (conflict 2026-10-31)") - len(".md") = 230 bytes of stem fit
    const name = conflictCopyName(`${"x".repeat(229)}.${"y".repeat(5)}.md`, DAY, 1);
    expect(name).toBe(`${"x".repeat(229)} (conflict ${DAY}).md`);
  });

  it("refuses a name that cannot be made safe", () => {
    expect(() => conflictCopyName("inbox/.hidden.md", DAY, 1)).toThrow();
  });
});

describe("syncBeforeWrite through the note writer", () => {
  it("R8.1: keeps the local version as a conflict copy, pushes, logs a count and completes", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });

    const response = await post(makeApp(), note("inbox/b.md"));
    expect(response.status).toBe(201);
    expect(remoteFile("inbox/a.md")).toBe(REMOTE);
    expect(remoteFile(COPY)).toBe(LOCAL);
    expect(remoteFile("inbox/b.md")).toBe(bytes("x\n"));
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(
      git(fixture.vaultDir, ["rev-parse", "HEAD"]),
    );
    expect(git(fixture.vaultDir, ["log", "-2", "--format=%s", "HEAD"]).split("\n")[1]).toBe(
      "2brain: keep conflicting versions (1 files)",
    );
    expect(logs).toContain("conflicts_kept: 1");
    for (const line of logs) {
      expect(line).not.toContain("a.md");
      expect(line).not.toContain("local");
    }
  });

  it("R8.1: several conflicts keep local-only and remote-only changes at their own paths", async () => {
    localCommit({
      "inbox/a1.md": bytes("local1\n"),
      "inbox/a2.md": bytes("local2\n"),
      "inbox/only-local.md": bytes("ol\n"),
    });
    remoteCommit({
      "inbox/a1.md": bytes("remote1\n"),
      "inbox/a2.md": bytes("remote2\n"),
      " lead.md": bytes("rl\n"),
    });

    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(logs).toContain("conflicts_kept: 2");
    expect(remoteFile("inbox/a1.md")).toBe(bytes("remote1\n"));
    expect(remoteFile("inbox/a2.md")).toBe(bytes("remote2\n"));
    expect(remoteFile(`inbox/a1 (conflict ${DAY}).md`)).toBe(bytes("local1\n"));
    expect(remoteFile(`inbox/a2 (conflict ${DAY}).md`)).toBe(bytes("local2\n"));
    expect(remoteFile("inbox/only-local.md")).toBe(bytes("ol\n"));
    expect(remoteFile(" lead.md")).toBe(bytes("rl\n"));
    expectVaultMatchesRemote();
  });

  it("treats paths as literals, never as globs", async () => {
    remoteCommit({ "a.md": "base\n", "[ab].md": "base\n" });
    git(fixture.vaultDir, ["pull", "--rebase"]);
    localCommit({ "[ab].md": "local\n" });
    remoteCommit({ "a.md": "remote-a\n", "[ab].md": "remote-ab\n" });

    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(remoteFiles().filter((p) => p.includes("conflict"))).toEqual([
      `[ab] (conflict ${DAY}).md`,
    ]);
    expect(remoteFile("a.md")).toBe("remote-a\n");
    expect(remoteFile("[ab].md")).toBe("remote-ab\n");
    expect(remoteFile(`[ab] (conflict ${DAY}).md`)).toBe("local\n");
  });

  it("names the copy with the UTC day of the injected clock", async () => {
    clock = () => new Date("2030-01-02T23:30:00Z");
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });
    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(remoteFile("inbox/a (conflict 2030-01-02).md")).toBe(LOCAL);
  });

  it("D2: a taken conflict name gets a number and is never overwritten", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE, [COPY]: bytes("taken\n") });

    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(remoteFile(COPY)).toBe(bytes("taken\n"));
    expect(remoteFile(`inbox/a (conflict ${DAY} 2).md`)).toBe(LOCAL);
  });

  it("R8.2: leaves no rebase state and the next write is an ordinary one", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });
    const app = makeApp();
    expect((await post(app, note("inbox/b.md"))).status).toBe(201);
    expectVaultMatchesRemote();

    gitCalls = [];
    expect((await post(app, note("inbox/c.md"))).status).toBe(201);
    expect(gitCalls[0]).toBe("pullRebase");
    expect(logs.filter((l) => l.startsWith("conflicts_kept"))).toHaveLength(1);
    expectVaultMatchesRemote();
  });

  it("a request for the conflicting path itself is a 409 and the copy stays on the remote", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });
    const response = await post(makeApp(), note("inbox/a.md", {}, "local\n"));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("note_exists");
    expect(remoteFile(COPY)).toBe(LOCAL);
  });

  describe("D1: failures that are not a rebase conflict", () => {
    it("a pull from an unreachable remote is 500 write_failed and changes nothing", async () => {
      const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
      git(fixture.vaultDir, ["remote", "set-url", "origin", join(fixture.root, "missing.git")]);
      const response = await post(makeApp(), note("inbox/b.md"));
      expect(response.status).toBe(500);
      expect(logs.some((l) => /^write_failed: git pull exit \d+$/.test(l))).toBe(true);
      expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
      expect(rebaseDirs()).toBe(false);
    });

    it("a pull error with no rebase in progress is rethrown", async () => {
      const response = await post(
        makeApp({
          pullRebase: async () => {
            throw new GitError("pull", 1);
          },
        }),
        note("inbox/b.md"),
      );
      expect(response.status).toBe(500);
      expect(logs).toContain("write_failed: git pull exit 1");
    });
  });

  describe("D3: the scrub", () => {
    it("redacts a secret in the copy before it reaches the remote", async () => {
      localCommit({ "inbox/a.md": bytes(`has ${ANT}\n`) });
      remoteCommit({ "inbox/a.md": REMOTE });
      expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
      expect(remoteFile(COPY)).toBe(bytes("has [REDACTED:anthropic_key]\n"));
      expect(gitRaw(fixture.remote, ["log", "-p", "main"])).not.toContain(ANT);
      expect(logs.join("\n")).not.toContain(ANT);
    });

    it("a scrubber failure is 500 scrub_failed and restores the local state", async () => {
      const local = localCommit({ "inbox/a.md": bytes("LOCALMARK\n") });
      const remote = remoteCommit({ "inbox/a.md": REMOTE });
      const failing: Scrubber = {
        scrub: (text) => {
          if (text.includes("LOCALMARK")) throw new Error("boom");
          return scrub(text);
        },
        scrubFrontmatter: (data) => scrubFrontmatter(data),
      };
      const response = await post(makeApp({}, failing), note("inbox/b.md"));
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toBe("scrub_failed");
      expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(local);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(rebaseDirs()).toBe(false);
      expect(git(fixture.remote, ["rev-parse", "main"])).toBe(remote);
    });
  });

  it.skipIf(process.platform === "win32")(
    "a failure after the rebuild started puts the vault back at the local commit",
    async () => {
      const local = localCommit({ "inbox/a.md": LOCAL });
      remoteCommit({ "inbox/a.md": REMOTE });
      const hook = join(fixture.vaultDir, ".git", "hooks", "pre-commit");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);

      const app = makeApp();
      expect((await post(app, note("inbox/b.md"))).status).toBe(500);
      expect(logs.some((l) => /^write_failed: git commit exit \d+$/.test(l))).toBe(true);
      expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(local);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(existsSync(join(fixture.vaultDir, COPY))).toBe(false);
      expect(rebaseDirs()).toBe(false);

      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      expect((await post(app, note("inbox/b.md"))).status).toBe(201);
      expect(remoteFile(COPY)).toBe(LOCAL);
      expect(remoteFile("inbox/a.md")).toBe(REMOTE);
    },
  );

  describe("upstream deletions and renames", () => {
    function otherClone(): string {
      counter += 1;
      return fixture.cloneElsewhere(`other-${counter}`);
    }

    it("keeps the conflict copy when upstream also deletes a tracked file", async () => {
      remoteCommit({ "inbox/del.md": bytes("d\n") });
      git(fixture.vaultDir, ["pull", "--rebase"]);
      localCommit({ "inbox/a.md": LOCAL });
      const other = otherClone();
      writeIn(other, { "inbox/a.md": REMOTE });
      git(other, ["rm", "-q", "inbox/del.md"]);
      git(other, ["commit", "-m", "remote"]);
      git(other, ["push", "origin", "main"]);

      expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
      expect(remoteFiles()).not.toContain("inbox/del.md");
      expect(remoteFile(COPY)).toBe(LOCAL);
      expectVaultMatchesRemote();
    });

    it("keeps the conflict copy when upstream also renames a tracked file", async () => {
      remoteCommit({ "inbox/old.md": bytes("r\n") });
      git(fixture.vaultDir, ["pull", "--rebase"]);
      localCommit({ "inbox/a.md": LOCAL });
      const other = otherClone();
      writeIn(other, { "inbox/a.md": REMOTE });
      git(other, ["mv", "inbox/old.md", "inbox/new.md"]);
      git(other, ["commit", "-am", "remote"]);
      git(other, ["push", "origin", "main"]);

      expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
      expect(remoteFiles()).not.toContain("inbox/old.md");
      expect(remoteFile("inbox/new.md")).toBe(bytes("r\n"));
      expect(remoteFile(COPY)).toBe(LOCAL);
      expectVaultMatchesRemote();
    });
  });

  describe("cases the rebuild refuses and leaves untouched", () => {
    function expectUntouched(local: string, keptPath: string, upstream: string): void {
      // The rebuild starts with a soft reset to upstream; a refusal must come before it.
      expect(git(fixture.vaultDir, ["reflog", "show", "HEAD"])).not.toContain(
        `reset: moving to ${upstream}`,
      );
      expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(local);
      expect(existsSync(join(fixture.vaultDir, keptPath))).toBe(true);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(rebaseDirs()).toBe(false);
    }

    it("a local file under a directory that upstream made a file", async () => {
      const local = localCommit({ "Folder/note.md": LOCAL, "inbox/a.md": LOCAL });
      const up = remoteCommit({ Folder: "file\n", "inbox/a.md": REMOTE });
      const response = await post(makeApp(), note("inbox/b.md"));
      expect(response.status).toBe(500);
      expect(logs.some((l) => /^write_failed: git pull exit \d+$/.test(l))).toBe(true);
      expectUntouched(local, "Folder/note.md", up);
    });

    it("a local file where upstream put a directory", async () => {
      const local = localCommit({ Folder: "file\n", "inbox/a.md": LOCAL });
      const up = remoteCommit({ "Folder/note.md": REMOTE, "inbox/a.md": REMOTE });
      const response = await post(makeApp(), note("inbox/b.md"));
      expect(response.status).toBe(500);
      expect(logs.some((l) => /^write_failed: git pull exit \d+$/.test(l))).toBe(true);
      expectUntouched(local, "Folder", up);
    });

    it("a remote-only file name that is not valid UTF-8", async (ctx) => {
      const local = localCommit({ "inbox/a.md": LOCAL });
      counter += 1;
      const other = fixture.cloneElsewhere(`other-${counter}`);
      writeIn(other, { "inbox/a.md": REMOTE });
      try {
        writeFileSync(
          Buffer.concat([Buffer.from(`${other}/inbox/`), Buffer.from([0xff, 0x2e, 0x6d, 0x64])]),
          "x\n",
        );
      } catch {
        ctx.skip();
        return;
      }
      git(other, ["add", "-A"]);
      git(other, ["commit", "-m", "remote"]);
      git(other, ["push", "origin", "main"]);
      const up = git(other, ["rev-parse", "HEAD"]);

      const response = await post(makeApp(), note("inbox/b.md"));
      expect(response.status).toBe(500);
      expect(logs.some((l) => /^write_failed: git pull exit \d+$/.test(l))).toBe(true);
      expectUntouched(local, "inbox/a.md", up);
    });
  });

  it("D2: an untracked file at the conflict name is never overwritten", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });
    writeFileSync(join(fixture.vaultDir, COPY), "untracked\n");

    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(remoteFile(`inbox/a (conflict ${DAY} 2).md`)).toBe(LOCAL);
    expect(readFileSync(join(fixture.vaultDir, COPY), "utf8")).toBe("untracked\n");
    expect(remoteFiles()).not.toContain(COPY);
  });

  it("makes no copy and counts nothing for a path both sides changed identically", async () => {
    localCommit({ "inbox/a.md": LOCAL, "inbox/same.md": bytes("same\n") });
    remoteCommit({ "inbox/a.md": REMOTE, "inbox/same.md": bytes("same\n") });

    expect((await post(makeApp(), note("inbox/b.md"))).status).toBe(201);
    expect(logs).toContain("conflicts_kept: 1");
    expect(remoteFiles().filter((p) => p.includes("conflict"))).toEqual([COPY]);
    expect(remoteFile("inbox/same.md")).toBe(bytes("same\n"));
  });

  it("a push failure after the conflict commit is retried by the next write", async () => {
    localCommit({ "inbox/a.md": LOCAL });
    remoteCommit({ "inbox/a.md": REMOTE });
    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", join(fixture.root, "no.git")]);
    const app = makeApp();
    expect((await post(app, note("inbox/b.md"))).status).toBe(500);
    expect(logs.some((l) => /^write_failed: git push exit \d+$/.test(l))).toBe(true);

    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", fixture.remote]);
    expect((await post(app, note("inbox/c.md"))).status).toBe(201);
    expect(remoteFile("inbox/a.md")).toBe(REMOTE);
    expect(remoteFile(COPY)).toBe(LOCAL);
  });

  describe("D5: both versions carry the same source_id", () => {
    it("names the copy that sorts first, and answers note_exists at the original path", async () => {
      localCommit({ "inbox/a.md": bytes("local\n", { source_id: "s-1" }) });
      remoteCommit({ "inbox/a.md": bytes("remote\n", { source_id: "s-1" }) });
      const app = makeApp();

      const dup = await post(app, note("inbox/c.md", { source_id: "s-1" }));
      expect(dup.status).toBe(409);
      expect(await dup.json()).toMatchObject({ error: "duplicate_source", path: COPY });

      const exists = await post(app, note("inbox/a.md", { source_id: "s-1" }, "local\n"));
      expect(exists.status).toBe(409);
      expect(((await exists.json()) as { error: string }).error).toBe("note_exists");

      expect((await post(app, note("inbox/d.md"))).status).toBe(201);
    });
  });
});
