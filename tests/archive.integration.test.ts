import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGit, ensureClone, type GitApi, GitError } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import { stringifyNote } from "../src/vault/frontmatter.js";
import { NoteNotFoundError } from "../src/vault/operations.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";

const TOKEN = "fictional-archive-token-0123456789-abcdefghij";

let fixture: GitFixture;
let gitCalls: string[];
let logs: string[];
let sleeps: number[];

function spyGit(overrides: Partial<GitApi> = {}): GitApi {
  const spied = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(defaultGit)) {
    spied[name] = (...args: unknown[]) => {
      gitCalls.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...(spied as unknown as GitApi), ...overrides };
}

function makeWriter(overrides: Partial<GitApi> = {}) {
  return createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: spyGit(overrides),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
}

function makeApp(overrides: Partial<GitApi> = {}) {
  return createApp({
    writer: makeWriter(overrides),
    ingestToken: TOKEN,
    log: (message) => logs.push(message),
  });
}

function send(
  app: ReturnType<typeof createApp>,
  path: string,
  method: string,
  payload: unknown,
): Promise<Response> | Response {
  return app.request(path, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
}

function archive(app: ReturnType<typeof createApp>, payload: unknown) {
  return send(app, "/notes/archive", "POST", payload);
}

function remoteSha(): string {
  return git(fixture.remote, ["rev-parse", "main"]);
}

function head(): string {
  return git(fixture.vaultDir, ["rev-parse", "HEAD"]);
}

function vaultFile(path: string): Buffer {
  return readFileSync(join(fixture.vaultDir, path));
}

function vaultHas(path: string): boolean {
  return existsSync(join(fixture.vaultDir, path));
}

function status(): string {
  return git(fixture.vaultDir, ["status", "--porcelain"]);
}

const VALID = { type: "idea", area: "personal", date: "2026-10-31", source: "manual" };
let cloneCounter = 0;

/** Commit `files` from a second clone, push, and bring them into the vault clone. */
function seed(files: Record<string, string>): void {
  cloneCounter += 1;
  const dir = fixture.cloneElsewhere(`seed-${cloneCounter}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
  git(dir, ["commit", "-m", "seed notes"]);
  git(dir, ["push", "origin", "main"]);
  git(fixture.vaultDir, ["pull", "--ff-only"]);
}

/** CRLF, a leading blank line, a trailing space: bytes that a rewrite would change. */
const BODY = "\nLine one\r\nLine two \r\n\r\n  indented\n";

function noteText(title = "alpha"): string {
  return stringifyNote({ ...VALID, title }, BODY);
}

function seedNote(path = "inbox/a.md"): string {
  const text = noteText();
  seed({ [path]: text });
  return text;
}

function movedOrPushed(): boolean {
  return gitCalls.some((call) => call === "moveFile" || call === "commitPaths" || call === "push");
}

beforeEach(async () => {
  fixture = createGitFixture();
  gitCalls = [];
  logs = [];
  sleeps = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

describe("POST /notes/archive against a real remote", () => {
  it("R7.1: moves the note to archive/<path> byte-identical as a pure rename, commits and pushes", async () => {
    const original = seedNote();
    const before = head();
    const response = await archive(makeApp(), { path: "inbox/a.md" });
    expect(response.status).toBe(200);
    const after = head();
    expect(after).not.toBe(before);
    expect(await response.json()).toEqual({ ok: true, path: "archive/inbox/a.md", commit: after });
    expect(vaultFile("archive/inbox/a.md").toString()).toBe(original);
    expect(vaultHas("inbox/a.md")).toBe(false);
    expect(remoteSha()).toBe(after);
    expect(git(fixture.remote, ["log", "-1", "--format=%s", "main"])).toBe(
      "2brain: archive inbox/a.md -> archive/inbox/a.md",
    );
    expect(
      git(fixture.vaultDir, ["diff-tree", "-r", "-M", "--name-status", "HEAD~1", "HEAD"]),
    ).toBe("R100\tinbox/a.md\tarchive/inbox/a.md");
    expect(status()).toBe("");
  });

  it("R7.1: honours a non-default archive_folder, and archive/ is then an ordinary folder", async () => {
    seed({
      ".2brain/config.yaml": "vault:\n  archive_folder: old/stuff\n",
      "inbox/a.md": noteText(),
      "archive/x.md": noteText("x"),
    });
    const app = makeApp();
    const first = await archive(app, { path: "inbox/a.md" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ path: "old/stuff/inbox/a.md" });
    const second = await archive(app, { path: "archive/x.md" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ path: "old/stuff/archive/x.md" });
    expect(vaultFile("old/stuff/inbox/a.md").toString()).toBe(noteText());
    expect(vaultHas("inbox/a.md")).toBe(false);
    expect(vaultHas("archive/x.md")).toBe(false);
    expect(remoteSha()).toBe(head());
  });

  it("R7.1: archives an immutable_body (transcript) note without touching its bytes", async () => {
    const text = stringifyNote({ ...VALID, type: "meeting", title: "t" }, "Speaker: hello\r\n");
    seed({ "inbox/t.md": text });
    const response = await archive(makeApp(), { path: "inbox/t.md" });
    expect(response.status).toBe(200);
    expect(vaultFile("archive/inbox/t.md").toString()).toBe(text);
  });

  it("R7.1: a file named like a glob moves alone", async () => {
    seed({ "inbox/[ab].md": noteText("glob"), "inbox/a.md": noteText("plain") });
    const response = await archive(makeApp(), { path: "inbox/[ab].md" });
    expect(response.status).toBe(200);
    expect(vaultHas("inbox/[ab].md")).toBe(false);
    expect(vaultHas("inbox/a.md")).toBe(true);
    expect(vaultHas("archive/inbox/[ab].md")).toBe(true);
    expect(vaultHas("archive/inbox/a.md")).toBe(false);
  });

  it("R7.2: a note already in the archive folder gives 409 already_archived and moves nothing", async () => {
    seedNote("archive/inbox/a.md");
    const before = head();
    const remoteBefore = remoteSha();
    const response = await archive(makeApp(), { path: "archive/inbox/a.md" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "already_archived" });
    expect(vaultHas("archive/inbox/a.md")).toBe(true);
    expect(vaultHas("archive/archive/inbox/a.md")).toBe(false);
    expect(head()).toBe(before);
    expect(remoteSha()).toBe(remoteBefore);
    expect(movedOrPushed()).toBe(false);
  });

  it("R7.2: a prefix without a slash is not the archive folder", async () => {
    seedNote("archive-notes/a.md");
    const response = await archive(makeApp(), { path: "archive-notes/a.md" });
    expect(response.status).toBe(200);
    expect(vaultHas("archive/archive-notes/a.md")).toBe(true);
  });

  it("R7.2: an existing target gives 409 archive_target_exists, both files untouched", async () => {
    const mine = noteText("mine");
    const other = noteText("other");
    seed({ "inbox/a.md": mine, "archive/inbox/a.md": other });
    const before = head();
    const response = await archive(makeApp(), { path: "inbox/a.md" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "archive_target_exists" });
    expect(vaultFile("inbox/a.md").toString()).toBe(mine);
    expect(vaultFile("archive/inbox/a.md").toString()).toBe(other);
    expect(head()).toBe(before);
    expect(movedOrPushed()).toBe(false);
  });

  it("R7.2: a file where a target directory is needed gives 409 archive_target_exists", async () => {
    seed({ "inbox/a.md": noteText(), "archive/inbox": "i am a file\n" });
    const before = head();
    const response = await archive(makeApp(), { path: "inbox/a.md" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "archive_target_exists" });
    expect(vaultHas("inbox/a.md")).toBe(true);
    expect(head()).toBe(before);
    expect(movedOrPushed()).toBe(false);
  });

  it("D1: a missing path, a directory and an untracked file give 404 note_not_found", async () => {
    seedNote("inbox/keep.md");
    mkdirSync(join(fixture.vaultDir, "dir.md"));
    writeFileSync(join(fixture.vaultDir, "inbox", "untracked.md"), noteText());
    const app = makeApp();
    for (const path of ["inbox/missing.md", "dir.md", "inbox/untracked.md", "nodir/x.md"]) {
      const response = await archive(app, { path });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "note_not_found" });
    }
    expect(vaultHas("inbox/untracked.md")).toBe(true);
    expect(movedOrPushed()).toBe(false);
  });

  describe("D1: symlinks", () => {
    it("a symlink source gives 400 unsafe_path", async () => {
      seedNote("inbox/keep.md");
      const outside = join(fixture.root, "outside.md");
      writeFileSync(outside, noteText());
      symlinkSync(outside, join(fixture.vaultDir, "inbox", "ln.md"));
      const response = await archive(makeApp(), { path: "inbox/ln.md" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(movedOrPushed()).toBe(false);
      expect(vaultHas("archive")).toBe(false);
    });

    it("a source directory symlinked inside the vault gives 400 unsafe_path", async () => {
      seedNote("real/a.md");
      symlinkSync(join(fixture.vaultDir, "real"), join(fixture.vaultDir, "alias"));
      const response = await archive(makeApp(), { path: "alias/a.md" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(movedOrPushed()).toBe(false);
      expect(vaultHas("real/a.md")).toBe(true);
    });

    it("a symlink at the target gives 400 unsafe_path", async () => {
      seedNote();
      mkdirSync(join(fixture.vaultDir, "archive", "inbox"), { recursive: true });
      const outside = join(fixture.root, "outside.md");
      writeFileSync(outside, "outside\n");
      symlinkSync(outside, join(fixture.vaultDir, "archive", "inbox", "a.md"));
      const response = await archive(makeApp(), { path: "inbox/a.md" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(vaultHas("inbox/a.md")).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("outside\n");
      expect(movedOrPushed()).toBe(false);
    });

    it("an archive directory that is a symlink inside the vault gives 400 unsafe_path", async () => {
      seedNote();
      mkdirSync(join(fixture.vaultDir, "elsewhere"));
      symlinkSync(join(fixture.vaultDir, "elsewhere"), join(fixture.vaultDir, "archive"));
      const response = await archive(makeApp(), { path: "inbox/a.md" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(vaultHas("inbox/a.md")).toBe(true);
      expect(readdirSync(join(fixture.vaultDir, "elsewhere"))).toEqual([]);
      expect(movedOrPushed()).toBe(false);
    });

    it("an archive directory symlinked outside the vault gives 400 unsafe_path", async () => {
      seedNote();
      const outsideDir = join(fixture.root, "outside-dir");
      mkdirSync(outsideDir);
      symlinkSync(outsideDir, join(fixture.vaultDir, "archive"));
      const response = await archive(makeApp(), { path: "inbox/a.md" });
      expect(response.status).toBe(400);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(vaultHas("inbox/a.md")).toBe(true);
      expect(movedOrPushed()).toBe(false);
    });
  });

  it("D2: a commit that fails with HEAD unmoved puts the note back byte-identical", async () => {
    const original = seedNote();
    const before = head();
    const remoteBefore = remoteSha();
    const response = await archive(
      makeApp({
        commitPaths: async () => {
          throw new GitError("commit", 1);
        },
      }),
      { path: "inbox/a.md" },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
    expect(vaultFile("inbox/a.md").toString()).toBe(original);
    expect(vaultHas("archive/inbox/a.md")).toBe(false);
    expect(status()).toBe("");
    expect(head()).toBe(before);
    expect(remoteSha()).toBe(remoteBefore);
    expect(gitCalls.filter((call) => call === "moveFile")).toHaveLength(2);
  });

  it("D2: a commit that lands and then fails keeps the move", async () => {
    seedNote();
    const before = head();
    const response = await archive(
      makeApp({
        commitPaths: async (...args) => {
          await defaultGit.commitPaths(...args);
          throw new GitError("commit", 1);
        },
      }),
      { path: "inbox/a.md" },
    );
    expect(response.status).toBe(500);
    expect(head()).not.toBe(before);
    expect(vaultHas("archive/inbox/a.md")).toBe(true);
    expect(vaultHas("inbox/a.md")).toBe(false);
    expect(gitCalls.filter((call) => call === "moveFile")).toHaveLength(1);
  });

  it("D3: a push that always fails gives 502 push_pending, and the next write delivers the move", async () => {
    seedNote();
    const remoteBefore = remoteSha();
    const response = await archive(
      makeApp({
        push: async () => {
          throw new GitError("push", 128);
        },
      }),
      { path: "inbox/a.md" },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "push_pending",
      path: "archive/inbox/a.md",
      commit: head(),
    });
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(remoteSha()).toBe(remoteBefore);
    expect(vaultHas("archive/inbox/a.md")).toBe(true);

    const created = await send(makeApp(), "/notes", "POST", {
      path: "inbox/b.md",
      frontmatter: { ...VALID, title: "beta" },
      body: "b\n",
    });
    expect(created.status).toBe(201);
    expect(remoteSha()).toBe(head());
    const log = git(fixture.remote, ["log", "--format=%s", "main"]);
    expect(log).toContain("2brain: archive inbox/a.md -> archive/inbox/a.md");
    const tree = git(fixture.remote, ["ls-tree", "-r", "--name-only", "main"]);
    expect(tree).toContain("archive/inbox/a.md");
    expect(tree.split("\n")).not.toContain("inbox/a.md");
  });

  it("D4: an invalid config gives 503 config_invalid with no move", async () => {
    seed({ ".2brain/config.yaml": "vault:\n  archive_folder: 42\n", "inbox/a.md": noteText() });
    const before = head();
    const response = await archive(makeApp(), { path: "inbox/a.md" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "config_invalid",
      keyPath: "vault.archive_folder",
    });
    expect(vaultHas("inbox/a.md")).toBe(true);
    expect(head()).toBe(before);
    expect(gitCalls).not.toContain("moveFile");
  });

  it("D4: a bad body gives 400 invalid_body with no git call", async () => {
    seedNote();
    gitCalls.length = 0;
    const app = makeApp();
    for (const body of [
      { path: "../a.md" },
      { path: "inbox/a.txt" },
      { path: "inbox/a.md", force: true },
    ]) {
      const response = await archive(app, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("invalid_body");
    }
    expect(gitCalls).toEqual([]);
  });

  it("D4: a path that matches a scrub rule gives 400 unsafe_path with no git call", async () => {
    const secret = ["ghp", "D".repeat(36)].join("_");
    gitCalls.length = 0;
    const response = await archive(makeApp(), { path: `inbox/${secret}.md` });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
    expect(gitCalls).toEqual([]);
  });

  it("D5: archive and then patch of the same path, not awaited, run in order", async () => {
    seedNote();
    const writer = makeWriter();
    const archiving = writer.archive({ path: "inbox/a.md" });
    const patching = writer.patch({ path: "inbox/a.md", set: { title: "beta" } });
    expect(await archiving).toMatchObject({ path: "archive/inbox/a.md" });
    await expect(patching).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});

describe("R7.3: nothing in the service deletes a vault file", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const DELETE_PRIMITIVE =
    /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\b|["'](?:rm|clean|rmdir)["']/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith(".ts") ? [full] : [];
    });
  }

  /** Every delete primitive of src/**, exact lines, with why each is not a vault deletion. */
  const ALLOWED: Array<{ file: string; line: string; reason: string }> = [
    {
      file: "vault/write-note.ts",
      line: 'import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";',
      reason: "import for the cleanup below",
    },
    {
      file: "vault/write-note.ts",
      line: "await unlink(target).catch((e: NodeJS.ErrnoException) => {",
      reason: "after a failed commit, removes only the file the same create call just wrote",
    },
    {
      file: "git/sync.ts",
      line: 'import { access, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";',
      reason: "import for the cleanup below",
    },
    {
      file: "git/sync.ts",
      line: 'await runGit(dir, ["rm", "-q", "-f", "--ignore-unmatch", "--", ...group]);',
      reason:
        "replays a deletion already in the remote history while rebuilding the index on top of upstream; the service chooses no deletion",
    },
    {
      file: "git/sync.ts",
      line: "for (const file of written) await unlink(file).catch(() => undefined);",
      reason: "removes only the conflict copies the same failed rebuild wrote",
    },
    {
      file: "auth/oauth/store.ts",
      line: "unlink,",
      reason: "OAuth store temp files; openStore refuses a store directory inside VAULT_DIR",
    },
    {
      file: "auth/oauth/store.ts",
      line: "if (TEMP_PATTERN.test(name)) await unlink(path.join(real, name)).catch(() => undefined);",
      reason: "OAuth store temp file cleanup outside the vault",
    },
    {
      file: "auth/oauth/store.ts",
      line: "if (ownsTemp) await unlink(temp).catch(() => undefined);",
      reason: "OAuth store temp file cleanup outside the vault",
    },
    {
      file: "install/ssh.ts",
      line: "rmSync,",
      reason: "import for the installer temp cleanup below",
    },
    {
      file: "install/ssh.ts",
      line: "unlinkSync,",
      reason: "import for the installer rollback below",
    },
    {
      file: "install/ssh.ts",
      line: "rmSync(tmp, { force: true });",
      reason: "installer known_hosts temp file in the project secrets dir, never a vault file",
    },
    {
      file: "install/ssh.ts",
      line: "rmSync(tmpDir, { recursive: true, force: true });",
      reason:
        "installer removes only the .keygen- temp dir it just created in secrets/, never a vault file",
    },
    {
      file: "install/ssh.ts",
      line: "unlinkSync(finalPub);",
      reason:
        "installer rolls back the deploy_key.pub it just renamed when the private key rename fails, never a vault file",
    },
    {
      file: "install/doctor.ts",
      line: 'const NO_ENV_FILE_FIX = "no .env in the project directory: run docker compose run --rm setup";',
      reason: "text of a doctor fix line (the docker --rm flag); it deletes nothing",
    },
    {
      file: "install/env-file.ts",
      line: 'import { chmod, lstat, open, rename, unlink } from "node:fs/promises";',
      reason: "import for the temp file cleanup below",
    },
    {
      file: "install/setup.ts",
      line: 'import { chmod, lchown, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";',
      reason: "import for the lock cleanup below",
    },
    {
      file: "install/setup.ts",
      line: "if (lockPath !== undefined) await unlink(lockPath).catch(() => {});",
      reason: "installer removes the secrets/.setup.lock file it created, never a vault file",
    },
    {
      file: "install/setup.ts",
      line: '"start the service with docker compose up -d --build, then run docker compose run --rm doctor";',
      reason: "text of the final setup line (the docker --rm flag); it deletes nothing",
    },
    {
      file: "install/env-file.ts",
      line: "if (ownsTemp) await unlink(temp).catch(() => {});",
      reason: "installer .env temp file cleanup in the project directory, never in a vault",
    },
  ];

  it("finds exactly the allowlisted delete primitives in src/**", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (DELETE_PRIMITIVE.test(line)) found.push(`${rel}: ${line}`);
      }
    }
    const allowed = ALLOWED.map((entry) => `${entry.file}: ${entry.line}`);
    expect(found.sort()).toEqual(allowed.sort());
    for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it("the router has no DELETE route", () => {
    const app = makeApp();
    expect(app.routes.map((route) => route.method)).not.toContain("DELETE");
  });
});
