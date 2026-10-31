import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGit, ensureClone, type GitApi, GitError, runGit } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import { parseNote, stringifyNote } from "../src/vault/frontmatter.js";
import { ScrubError, scrub, scrubFrontmatter } from "../src/vault/scrub/index.js";
import { createSourceIndex } from "../src/vault/source-index.js";
import {
  createNoteWriter,
  PushPendingError,
  type Scrubber,
  ScrubFailedError,
  scrubNote,
} from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";

const TOKEN = "fictional-integration-token-0123456789-abcdef";

let fixture: GitFixture;
let gitCalls: string[];
let logs: string[];
let sleeps: number[];

function spyGit(overrides: Partial<GitApi> = {}): GitApi {
  return {
    ...defaultGit,
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
    headSha: (...args) => {
      gitCalls.push("headSha");
      return defaultGit.headSha(...args);
    },
    unstageFile: (...args) => {
      gitCalls.push("unstageFile");
      return defaultGit.unstageFile(...args);
    },
    ...overrides,
  };
}

function makeWriter(overrides: Partial<GitApi> = {}) {
  return createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: spyGit(overrides),
    sleep: recordSleep,
  });
}

function recordSleep(ms: number): Promise<void> {
  sleeps.push(ms);
  return Promise.resolve();
}

function makeApp(overrides: Partial<GitApi> = {}) {
  return createApp({
    writer: makeWriter(overrides),
    ingestToken: TOKEN,
    log: (message) => logs.push(message),
  });
}

function post(app: ReturnType<typeof createApp>, payload: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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

/** The four required properties with valid values under the default config. */
const VALID = { type: "idea", area: "personal", date: "2026-10-31", source: "manual" };

/** A valid create request at `path` (a type folder of the default config); `extra` is merged in. */
function note(path: string, extra: Record<string, unknown> = {}, body = "x\n") {
  return { path, frontmatter: { ...VALID, ...extra }, body };
}

let cloneCounter = 0;

/** Commit `files` (path to content) from a second clone and push; returns the new sha. */
function pushFromElsewhere(name: string, files: Record<string, string>): string {
  cloneCounter += 1;
  const dir = fixture.cloneElsewhere(`${name}-${cloneCounter}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
  git(dir, ["commit", "-m", `${name} config`]);
  git(dir, ["push", "origin", "main"]);
  return git(dir, ["rev-parse", "HEAD"]);
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
    const input = note(
      "inbox/idea.md",
      { title: "Idea", tags: ["a", "b"] },
      "First line\n\nSecond line\n",
    );
    const response = await post(app, input);
    expect(response.status).toBe(201);
    const result = (await response.json()) as { ok: boolean; path: string; commit: string };
    expect(result.ok).toBe(true);
    expect(result.path).toBe("inbox/idea.md");
    expect(result.commit).toBe(remoteSha());

    const parsed = parseNote(remoteFile("inbox/idea.md"));
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

    const response = await post(makeApp(), note("inbox/mine.md", {}, "mine\n"));
    expect(response.status).toBe(201);
    const { commit } = (await response.json()) as { commit: string };
    // Throws (non-zero exit) unless otherSha is an ancestor of our pushed commit.
    git(fixture.remote, ["merge-base", "--is-ancestor", otherSha, commit]);
    expect(remoteSha()).toBe(commit);
    expect(gitCalls[0]).toBe("pullRebase");
  });

  describe("D1: a request without a valid token changes nothing and never reaches git", () => {
    const variants: Array<[string, Record<string, string>]> = [
      ["no header", {}],
      ["a Basic scheme", { authorization: `Basic ${TOKEN}` }],
      ["a wrong token of the same length", { authorization: `Bearer ${TOKEN.slice(0, -1)}X` }],
      ["a token of a different length", { authorization: `Bearer ${TOKEN}X` }],
    ];

    it.each(variants)("%s returns 401", async (_name, extra) => {
      const shaBefore = remoteSha();
      const listingBefore = listVault();
      const response = await makeApp().request("/notes", {
        method: "POST",
        body: JSON.stringify({ path: "denied.md", frontmatter: {}, body: "x\n" }),
        headers: { "content-type": "application/json", ...extra },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
      expect(gitCalls).toEqual([]);
      expect(remoteSha()).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
    });
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
    const first = await post(app, note("inbox/dup.md", { v: 1 }, "one\n"));
    expect(first.status).toBe(201);
    const shaBefore = remoteSha();

    const second = await post(app, note("inbox/dup.md", { v: 2 }, "two\n"));
    expect(second.status).toBe(409);
    expect(remoteSha()).toBe(shaBefore);
    expect(parseNote(remoteFile("inbox/dup.md")).data).toEqual({ ...VALID, v: 1 });
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("D6: a path that exists only on the remote returns 409 after the pull", async () => {
    const shaBefore = pushFromElsewhere("remote-only", { "inbox/remote.md": "remote\n" });
    const response = await post(makeApp(), note("inbox/remote.md"));
    expect(response.status).toBe(409);
    expect(remoteSha()).toBe(shaBefore);
    expect(remoteFile("inbox/remote.md")).toBe("remote\n");
  });

  it("D7: two concurrent valid POSTs both return 201 and both notes reach the remote", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      post(app, note("inbox/a.md", { n: "a" }, "a\n")),
      post(app, note("inbox/b.md", { n: "b" }, "b\n")),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(parseNote(remoteFile("inbox/a.md")).data).toEqual({ ...VALID, n: "a" });
    expect(parseNote(remoteFile("inbox/b.md")).data).toEqual({ ...VALID, n: "b" });
  });

  it("D16: a ---js body is stored as content, not frontmatter, and runs no code", async () => {
    const body = "---js\nglobalThis.__pwnedIntegration = true\n---\nreal\n";
    const response = await post(makeApp(), note("inbox/inj.md", {}, body));
    expect(response.status).toBe(201);
    const stored = remoteFile("inbox/inj.md");
    expect(stored.startsWith("---\n")).toBe(true);
    const viaDefaultMatter = matter(stored);
    expect(viaDefaultMatter.data).toEqual(VALID);
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
    for (const [kind, extra] of [
      ["minimal", {}],
      ["full", { title: "T", n: 2 }],
    ] as const) {
      const path = `inbox/${slug}-${kind}.md`;
      const sent = note(path, extra, body);
      const response = await post(makeApp(), sent);
      expect(response.status).toBe(201);
      const parsed = parseNote(remoteFile(path));
      expect(parsed.data).toEqual(sent.frontmatter);
      expect(parsed.content).toBe(body);
    }
  });

  it("D16: a body that starts with its own fence round-trips with the input frontmatter", async () => {
    const body = "---\nk: v\n---\ntext\n";
    const sent = note("inbox/fence.md", { a: 1 }, body);
    const response = await post(makeApp(), sent);
    expect(response.status).toBe(201);
    const parsed = parseNote(remoteFile("inbox/fence.md"));
    expect(parsed.data).toEqual(sent.frontmatter);
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
      symlinkSync(outside, join(fixture.vaultDir, "inbox"));
      const shaBefore = remoteSha();
      const response = await post(makeApp(), note("inbox/x.md"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
      expect(readdirSync(outside)).toEqual([]);
      expect(remoteSha()).toBe(shaBefore);
      expect(logs.join("\n")).not.toContain(outside);
    });

    it("does not let mkdir -p create directories outside the vault through a symlink", async () => {
      symlinkSync(outside, join(fixture.vaultDir, "inbox"));
      const response = await post(makeApp(), note("inbox/new/deeper/x.md"));
      expect(response.status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(outside, "new"))).toBe(false);
    });

    it("rejects a symlink to a file at the target path without writing through it", async () => {
      const victim = join(outside, "victim.md");
      writeFileSync(victim, "keep\n");
      mkdirSync(join(fixture.vaultDir, "inbox"));
      symlinkSync(victim, join(fixture.vaultDir, "inbox", "ln.md"));
      const response = await post(makeApp(), note("inbox/ln.md"));
      expect(response.status).toBe(409);
      expect(readdirSync(outside)).toEqual(["victim.md"]);
    });
  });

  describe.skipIf(process.platform === "win32")("D4: a symlink at the target is never read", () => {
    it("a symlink whose size and pointed-to bytes equal the request is still 409", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "2brain-outside-"));
      try {
        mkdirSync(join(outsideDir, "d".repeat(100)));
        const victim = join(outsideDir, "d".repeat(100), "v.md");
        // The link's size is the length of its target path, so size the body to match it.
        const base = stringifyNote(note("inbox/ln.md").frontmatter, "").length;
        const body = "z".repeat(victim.length - base);
        const sent = note("inbox/ln.md", {}, body);
        const bytes = stringifyNote(sent.frontmatter, sent.body);
        expect(bytes.length).toBe(victim.length);
        writeFileSync(victim, bytes);
        mkdirSync(join(fixture.vaultDir, "inbox"));
        symlinkSync(victim, join(fixture.vaultDir, "inbox", "ln.md"));
        const response = await post(makeApp(), sent);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ ok: false, error: "note_exists" });
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("the vault config is read again after every pull", () => {
    const invalidConfigs: Array<[string, string, string]> = [
      ["an unknown key", "vault:\n  colour: blue\n", "vault.colour"],
      ["a wrong type", "vault:\n  archive_folder: 42\n", "vault.archive_folder"],
    ];

    it.each(invalidConfigs)(
      "R2.3: %s gives 503 and changes nothing",
      async (_name, yaml, keyPath) => {
        const configSha = pushFromElsewhere("bad", { ".2brain/config.yaml": yaml });
        const response = await post(makeApp(), note("inbox/blocked.md"));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          ok: false,
          error: "config_invalid",
          file: ".2brain/config.yaml",
          keyPath,
        });
        expect(gitCalls).toEqual(["pullRebase"]);
        expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(configSha);
        expect(remoteSha()).toBe(configSha);
        expect(existsSync(join(fixture.vaultDir, "inbox"))).toBe(false);
        expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
        expect(logs).toEqual([`config_invalid: .2brain/config.yaml at ${keyPath}`]);
      },
    );

    it("D1: after a 503, a fixing commit from another clone makes the next POST 201 without a restart", async () => {
      pushFromElsewhere("bad", { ".2brain/config.yaml": "vault:\n  colour: blue\n" });
      const app = makeApp();
      const sent = note("inbox/later.md");
      expect((await post(app, sent)).status).toBe(503);

      pushFromElsewhere("fix", { ".2brain/config.yaml": "version: 1\n" });
      const response = await post(app, sent);
      expect(response.status).toBe(201);
      const { commit } = (await response.json()) as { commit: string };
      expect(remoteSha()).toBe(commit);
      expect(parseNote(remoteFile("inbox/later.md")).content).toBe("x\n");
    });

    it("R2.4: a change to the areas pushed from another clone applies to the next create", async () => {
      const app = makeApp();
      const sent = note("travel/projects/trip.md", { type: "project", area: "travel" });

      const shaBefore = remoteSha();
      const before = await post(app, sent);
      expect(before.status).toBe(400);
      expect(await before.json()).toEqual({
        ok: false,
        error: "invalid_frontmatter",
        missing: [],
        invalid: ["area"],
      });
      expect(existsSync(join(fixture.vaultDir, "travel"))).toBe(false);
      expect(remoteSha()).toBe(shaBefore);
      expect(gitCalls).toEqual(["pullRebase"]);

      pushFromElsewhere("areas", { ".2brain/config.yaml": "areas:\n  - personal\n  - travel\n" });
      const after = await post(app, sent);
      expect(after.status).toBe(201);
      const { commit } = (await after.json()) as { commit: string };
      expect(commit).toBe(remoteSha());
      const stored = parseNote(remoteFile("travel/projects/trip.md"));
      expect(stored.data).toEqual(sent.frontmatter);
      expect(stored.content).toBe(sent.body);
    });
  });

  describe("R3: frontmatter and folder validation", () => {
    /** POST `payload`, expect the exact 400 body and a vault, remote and log left untouched. */
    async function expectRejected(
      payload: unknown,
      expectedBody: unknown,
      logLine: string,
    ): Promise<string> {
      const shaBefore = remoteSha();
      const listingBefore = listVault();
      const response = await post(makeApp(), payload);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(expectedBody);
      expect(gitCalls).toEqual(["pullRebase"]);
      expect(remoteSha()).toBe(shaBefore);
      expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(logs).toEqual([logLine]);
      return `${text}\n${logs.join("\n")}`;
    }

    const invalidFrontmatter = (missing: string[], invalid: string[]) => ({
      ok: false,
      error: "invalid_frontmatter",
      missing,
      invalid,
    });

    it.each(["type", "area", "date", "source"])(
      "R3.1: a create missing only %s returns 400 naming it",
      async (name) => {
        const sent = note("inbox/m.md");
        delete (sent.frontmatter as Record<string, unknown>)[name];
        await expectRejected(sent, invalidFrontmatter([name], []), "invalid_frontmatter rejected");
      },
    );

    it("R3.1: empty frontmatter lists all four in the order type, area, date, source", async () => {
      await expectRejected(
        { path: "inbox/m.md", frontmatter: {}, body: "x\n" },
        invalidFrontmatter(["type", "area", "date", "source"], []),
        "invalid_frontmatter rejected",
      );
    });

    it("R3.1: the names follow the properties mapping of the pushed config", async () => {
      pushFromElsewhere("names", {
        ".2brain/config.yaml":
          "properties:\n  type: kind\n  area: domain\n  date: day\n  source: origin\n",
      });
      git(fixture.vaultDir, ["pull", "--rebase"]);
      await expectRejected(
        { path: "inbox/m.md", frontmatter: { ...VALID }, body: "x\n" },
        invalidFrontmatter(["kind", "domain", "day", "origin"], []),
        "invalid_frontmatter rejected",
      );
      gitCalls = [];
      logs = [];
      await expectRejected(
        {
          path: "inbox/m.md",
          frontmatter: { kind: "idea", domain: "personal", day: "2026-10-31" },
          body: "x\n",
        },
        invalidFrontmatter(["origin"], []),
        "invalid_frontmatter rejected",
      );
    });

    it.each([
      ["an unknown type", { type: "memo" }, "type"],
      ["an unknown area", { area: "garden" }, "area"],
      ["a date that is not a calendar date", { date: "2026-02-30" }, "date"],
      ["a date in another format", { date: "31/10/2026" }, "date"],
    ])("R3.2/R3.3: %s returns 400 with the property in invalid", async (_name, extra, property) => {
      await expectRejected(
        note("inbox/m.md", extra),
        invalidFrontmatter([], [property]),
        "invalid_frontmatter rejected",
      );
    });

    it("D1: no frontmatter value from the request reaches the body or the log", async () => {
      const output = await expectRejected(
        note("inbox/m.md", {
          type: "VALUEMARKER-type",
          area: "VALUEMARKER-area",
          date: "VALUEMARKER-date",
          source: "VALUEMARKER-source",
          title: "VALUEMARKER-title",
        }),
        invalidFrontmatter([], ["type", "area", "date"]),
        "invalid_frontmatter rejected",
      );
      expect(output).not.toContain("VALUEMARKER");
      expect(output).not.toContain("manual");
    });

    it("R3.4: a path outside the type folder returns 400 wrong_folder with the folder", async () => {
      await expectRejected(
        note("notes/x.md"),
        { ok: false, error: "wrong_folder", expected: "inbox" },
        "wrong_folder rejected",
      );
    });

    it("R3.4: {area} in the folder is expanded with the note's area", async () => {
      await expectRejected(
        note("personal/meetings/x.md", { type: "meeting", area: "work" }),
        { ok: false, error: "wrong_folder", expected: "work/meetings" },
        "wrong_folder rejected",
      );
    });

    it("D1: a wrong_folder response and log carry no frontmatter value", async () => {
      const output = await expectRejected(
        note("VALUEMARKER/x.md", { title: "VALUEMARKER-title" }),
        { ok: false, error: "wrong_folder", expected: "inbox" },
        "wrong_folder rejected",
      );
      expect(output).not.toContain("VALUEMARKER");
      expect(output).not.toContain("manual");
    });

    it("R3.4: a note inside its expanded type folder is accepted", async () => {
      const sent = note("work/meetings/x.md", { type: "meeting", area: "work" });
      const response = await post(makeApp(), sent);
      expect(response.status).toBe(201);
      expect(parseNote(remoteFile("work/meetings/x.md")).data).toEqual(sent.frontmatter);
    });

    it("R3.4: a type without a folder accepts any safe path", async () => {
      pushFromElsewhere("folderless", {
        ".2brain/config.yaml": "types:\n  scrap:\n    value: scrap-note\n",
      });
      // The type key (scrap) differs from its value (scrap-note): validation must store the
      // value the request sent, never rewrite it to the config key.
      const sent = note("anywhere/x.md", { type: "scrap-note" });
      const response = await post(makeApp(), sent);
      expect(response.status).toBe(201);
      const stored = parseNote(remoteFile("anywhere/x.md"));
      expect(stored.data).toEqual(sent.frontmatter);
      expect(stored.content).toBe(sent.body);
    });
  });

  describe("R4: secret scrub", () => {
    // Built from parts at runtime: the CI secret scan reads every commit.
    const ANT = ["sk", "ant", "api03", "A".repeat(24)].join("-");
    const GHP = ["ghp", "B".repeat(36)].join("_");

    function appWith(scrubber: Scrubber) {
      return createApp({
        writer: createNoteWriter({
          vaultDir: fixture.vaultDir,
          author: TEST_AUTHOR,
          git: spyGit(),
          scrubber,
        }),
        ingestToken: TOKEN,
        log: (message) => logs.push(message),
      });
    }

    it("R4.1/R4.3: body secrets are stored as placeholders and counted", async () => {
      const response = await post(makeApp(), note("inbox/s.md", {}, `a ${ANT} b ${ANT}\n`));
      expect(response.status).toBe(201);
      const text = await response.text();
      expect(JSON.parse(text).redactions).toEqual([{ rule: "anthropic_key", count: 2 }]);
      const stored = remoteFile("inbox/s.md");
      expect(parseNote(stored).content).toBe(
        "a [REDACTED:anthropic_key] b [REDACTED:anthropic_key]\n",
      );
      expect(stored).not.toContain(ANT);
      expect(gitRaw(fixture.remote, ["log", "-p", "main"])).not.toContain(ANT);
      expect(text).not.toContain(ANT);
      expect(logs).toEqual(["redacted: anthropic_key=2"]);
    });

    it("R4.1: top-level and nested frontmatter strings are scrubbed, the rest is unchanged", async () => {
      const sent = note("inbox/f.md", {
        ref: `see ${GHP}`,
        links: { primary: GHP, other: "https://example.com" },
        tags: ["a", `t ${GHP}`],
      });
      const response = await post(makeApp(), sent);
      expect(response.status).toBe(201);
      const stored = remoteFile("inbox/f.md");
      expect(stored).not.toContain(GHP);
      expect(parseNote(stored).data).toEqual({
        ...sent.frontmatter,
        ref: "see [REDACTED:github_token]",
        links: { primary: "[REDACTED:github_token]", other: "https://example.com" },
        tags: ["a", "t [REDACTED:github_token]"],
      });
      expect(((await response.json()) as { redactions: unknown }).redactions).toEqual([
        { rule: "github_token", count: 3 },
      ]);
    });

    it("R4.3: body and frontmatter counts are combined, sorted by rule id, one log line", async () => {
      const response = await post(
        makeApp(),
        note("inbox/b.md", { ref: `x ${GHP}`, links: { primary: GHP } }, `${GHP}\n${ANT}\n`),
      );
      expect(response.status).toBe(201);
      const text = await response.text();
      expect(JSON.parse(text).redactions).toEqual([
        { rule: "anthropic_key", count: 1 },
        { rule: "github_token", count: 3 },
      ]);
      expect(logs).toEqual(["redacted: anthropic_key=1, github_token=3"]);
      for (const output of [text, ...logs]) {
        expect(output).not.toContain(ANT);
        expect(output).not.toContain(GHP);
      }
    });

    it("R4.3: with nothing to redact the body has no redactions key and nothing is logged", async () => {
      const response = await post(makeApp(), note("inbox/n.md"));
      expect(response.status).toBe(201);
      const json = (await response.json()) as { commit: string };
      expect(json).toEqual({ ok: true, path: "inbox/n.md", commit: remoteSha() });
      expect(logs).toEqual([]);
    });

    it("R4.3: the writer result has no redactions key when nothing was redacted", async () => {
      const result = await makeWriter().write(note("inbox/w.md"));
      expect(Object.keys(result).sort()).toEqual(["commit", "path"]);
    });

    // The path check runs `scrub` first, so a failing `scrub` stops before any git call.
    const failures: Array<[string, Scrubber, string[]]> = [
      [
        "ScrubError from scrub",
        {
          scrub: () => {
            throw new ScrubError("x");
          },
          scrubFrontmatter: (data) => scrubFrontmatter(data),
        },
        [],
      ],
      [
        "RangeError from scrubFrontmatter",
        {
          scrub: (text) => scrub(text),
          scrubFrontmatter: () => {
            throw new RangeError(`MARK${GHP}`);
          },
        },
        ["pullRebase"],
      ],
      [
        "an Error thrown from scrub of the body only",
        {
          scrub: (text) => {
            if (text !== "inbox/sub/x.md") throw new RangeError(`MARK${GHP}`);
            return scrub(text);
          },
          scrubFrontmatter: (data) => scrubFrontmatter(data),
        },
        ["pullRebase"],
      ],
      [
        "a string thrown from scrub",
        {
          scrub: () => {
            throw `MARK${GHP}`;
          },
          scrubFrontmatter: (data) => scrubFrontmatter(data),
        },
        [],
      ],
    ];

    it.each(failures)(
      "R4.4: %s gives 500 scrub_failed and writes nothing",
      async (_n, scrubber, expectedCalls) => {
        const shaBefore = remoteSha();
        const listingBefore = listVault();
        const response = await post(appWith(scrubber), note("inbox/sub/x.md", {}, `${ANT}\n`));
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ ok: false, error: "scrub_failed" });
        expect(gitCalls).toEqual(expectedCalls);
        expect(remoteSha()).toBe(shaBefore);
        expect(listVault()).toEqual(listingBefore);
        expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
        expect(logs).toEqual(["scrub_failed"]);
        for (const output of [text, ...logs]) {
          expect(output).not.toContain("MARK");
          expect(output).not.toContain(ANT);
        }
      },
    );

    it("R4.4: a scrubber result whose hits are not iterable gives ScrubFailedError", () => {
      const malformed: Scrubber = {
        scrub: (text) => ({ text, hits: 5 as unknown as Map<string, number> }),
        scrubFrontmatter: (data) => ({ data, hits: new Map() }),
      };
      expect(() => scrubNote(malformed, {}, "x")).toThrow(ScrubFailedError);
    });

    it("R4.1: a path that matches a scrub rule gives 400 unsafe_path and leaks nowhere", async () => {
      const shaBefore = remoteSha();
      const listingBefore = listVault();
      const response = await post(makeApp(), note(`inbox/${GHP}.md`));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: "unsafe_path" });
      expect(gitCalls).toEqual([]);
      expect(remoteSha()).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(logs).toEqual(["unsafe_path rejected"]);
      const history = gitRaw(fixture.remote, ["log", "--all", "-p", "--format=%B%n%s"]);
      for (const output of [text, ...logs, history]) expect(output).not.toContain(GHP);
    });

    it("R4.4: the real scrubber on a 200,000-level object or a cycle gives ScrubFailedError", async () => {
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 200_000; i++) {
        const next: Record<string, unknown> = {};
        cursor.n = next;
        cursor = next;
      }
      cursor.leaf = GHP;
      const cyclic: Record<string, unknown> = { leaf: GHP };
      cyclic.self = cyclic;

      const shaBefore = remoteSha();
      const listingBefore = listVault();
      for (const extra of [{ deep }, { cyclic }]) {
        let caught: unknown;
        try {
          await makeWriter().write(note("inbox/sub/y.md", extra));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ScrubFailedError);
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).message).toBe("Secret scrub failed");
        expect(inspect(caught, { depth: 5 })).not.toContain(GHP);
      }
      expect(remoteSha()).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    });

    it("D1: a source that is valid as sent but invalid once redacted gives 400 and writes nothing", async () => {
      pushFromElsewhere("sources", { ".2brain/config.yaml": `sources:\n  - ${GHP}\n` });
      git(fixture.vaultDir, ["pull", "--rebase"]);
      const shaBefore = remoteSha();
      const listingBefore = listVault();
      const response = await post(makeApp(), note("inbox/d.md", { source: GHP }));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: "invalid_frontmatter",
        missing: [],
        invalid: ["source"],
      });
      expect(text).not.toContain(GHP);
      expect(remoteSha()).toBe(shaBefore);
      expect(listVault()).toEqual(listingBefore);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
      expect(logs).toEqual(["invalid_frontmatter rejected"]);
    });
  });

  describe("T10: idempotent create and source id dedupe", () => {
    const SECRET = ["sk", "ant", "api03", "C".repeat(24)].join("-");

    function commitCount(): number {
      return git(fixture.vaultDir, ["log", "--format=%s"])
        .split("\n")
        .filter((line) => line.startsWith("2brain: add")).length;
    }

    it("R5.1 (a): the same create twice gives 201 then 200 unchanged with no commit or push", async () => {
      const app = makeApp();
      const sent = note("inbox/a.md", { source_id: "ff-1" }, "body\n");
      expect((await post(app, sent)).status).toBe(201);
      gitCalls = [];
      const shaBefore = remoteSha();
      const second = await post(app, sent);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        ok: true,
        path: "inbox/a.md",
        commit: null,
        unchanged: true,
      });
      expect(gitCalls).not.toContain("commitFile");
      expect(gitCalls).not.toContain("push");
      expect(remoteSha()).toBe(shaBefore);
      expect(commitCount()).toBe(1);
    });

    it("R5.1: a retry carrying a secret compares the scrubbed bytes and reports redactions", async () => {
      const app = makeApp();
      const sent = note("inbox/s.md", {}, `key ${SECRET}\n`);
      expect((await post(app, sent)).status).toBe(201);
      logs = [];
      const second = await post(app, sent);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        ok: true,
        path: "inbox/s.md",
        commit: null,
        unchanged: true,
        redactions: [{ rule: "anthropic_key", count: 1 }],
      });
      expect(logs).toEqual(["redacted: anthropic_key=1"]);
      expect(commitCount()).toBe(1);
    });

    it("R5.1 (b): after a failed push, a retry stays 502 with the same commit and makes no new commit", async () => {
      const badUrl = `file://${join(fixture.root, "missing", "r.git")}`;
      git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl]);
      const app = makeApp();
      const sent = note("inbox/b.md");
      const first = await post(app, sent);
      expect(first.status).toBe(502);
      const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
      expect(await first.json()).toEqual({
        ok: false,
        error: "push_pending",
        path: "inbox/b.md",
        commit: head,
      });
      gitCalls = [];
      const retry = await post(app, sent);
      expect(retry.status).toBe(502);
      expect(((await retry.json()) as { commit: string }).commit).toBe(head);
      expect(gitCalls).not.toContain("commitFile");
      expect(commitCount()).toBe(1);
    });

    it("R5.1 (b): once the push works again, the retry is 200 unchanged and delivers the pending commit", async () => {
      const badUrl = `file://${join(fixture.root, "missing", "r.git")}`;
      git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl]);
      const app = makeApp();
      const sent = note("inbox/b.md");
      expect((await post(app, sent)).status).toBe(502);
      git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", fixture.remote]);
      gitCalls = [];
      const retry = await post(app, sent);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        ok: true,
        path: "inbox/b.md",
        commit: null,
        unchanged: true,
      });
      expect(gitCalls).not.toContain("commitFile");
      expect(gitCalls.filter((c) => c === "push")).toHaveLength(1);
      expect(remoteSha()).toBe(git(fixture.vaultDir, ["rev-parse", "HEAD"]));
      expect(commitCount()).toBe(1);
    });

    it("R5.1: an identical file that HEAD does not track is committed and pushed, answering 201", async () => {
      const sent = note("inbox/u.md", {}, "crash\n");
      mkdirSync(join(fixture.vaultDir, "inbox"), { recursive: true });
      writeFileSync(
        join(fixture.vaultDir, "inbox", "u.md"),
        stringifyNote(sent.frontmatter, sent.body),
      );
      const response = await post(makeApp(), sent);
      expect(response.status).toBe(201);
      expect(remoteFile("inbox/u.md")).toBe(stringifyNote(sent.frontmatter, sent.body));
      expect(remoteSha()).toBe(git(fixture.vaultDir, ["rev-parse", "HEAD"]));
      expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe("2brain: add inbox/u.md");
      expect(commitCount()).toBe(1);
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    });

    it("R5.1: a failing commit of an untracked identical file leaves the file in place", async () => {
      const sent = note("inbox/u.md", {}, "crash\n");
      mkdirSync(join(fixture.vaultDir, "inbox"), { recursive: true });
      writeFileSync(
        join(fixture.vaultDir, "inbox", "u.md"),
        stringifyNote(sent.frontmatter, sent.body),
      );
      const app = makeApp({
        commitFile: () => Promise.reject(new GitError("commit", 1)),
      });
      expect((await post(app, sent)).status).toBe(500);
      expect(existsSync(join(fixture.vaultDir, "inbox", "u.md"))).toBe(true);
    });

    it("R5.1 (c): identical bytes that arrived by pull give 200 unchanged, different bytes 409", async () => {
      const sent = note("inbox/c.md", { source_id: "c-1" }, "same\n");
      const bytes = stringifyNote(sent.frontmatter, sent.body);
      const shaBefore = pushFromElsewhere("same", { "inbox/c.md": bytes });
      const app = makeApp();
      const same = await post(app, sent);
      expect(same.status).toBe(200);
      expect(((await same.json()) as { unchanged: boolean }).unchanged).toBe(true);
      expect(remoteSha()).toBe(shaBefore);

      const other = await post(app, note("inbox/c.md", { source_id: "c-1" }, "sama\n"));
      expect(other.status).toBe(409);
      expect(await other.json()).toEqual({ ok: false, error: "note_exists" });
      expect(remoteSha()).toBe(shaBefore);
    });

    it.each([
      ["the default name", "source_id", undefined],
      [
        "an owner name from the pushed config",
        "origin_id",
        "properties:\n  source_id: origin_id\n",
      ],
    ])(
      "R5.2 (d): a second path with the same id gives 409 duplicate_source (%s)",
      async (_n, name, config) => {
        if (config !== undefined) pushFromElsewhere("cfg", { ".2brain/config.yaml": config });
        const app = makeApp();
        expect((await post(app, note("inbox/a.md", { [name]: "ff-1" }))).status).toBe(201);
        const headBefore = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
        const shaBefore = remoteSha();
        logs = [];
        const response = await post(app, note("inbox/b.md", { [name]: "ff-1" }));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          ok: false,
          error: "duplicate_source",
          path: "inbox/a.md",
        });
        expect(existsSync(join(fixture.vaultDir, "inbox", "b.md"))).toBe(false);
        expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(headBefore);
        expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
        expect(remoteSha()).toBe(shaBefore);
        expect(logs).toEqual(["duplicate_source rejected"]);
      },
    );

    it("R5.2: a numeric source id matches the same id sent as a string", async () => {
      const app = makeApp();
      expect((await post(app, note("inbox/a.md", { source_id: 42 }))).status).toBe(201);
      const response = await post(app, note("inbox/b.md", { source_id: "42" }));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe("duplicate_source");
    });

    it("R5.2 (e): retrying the first path is 200 unchanged; other bytes there are 409 note_exists", async () => {
      const app = makeApp();
      const sent = note("inbox/a.md", { source_id: "ff-1" }, "one\n");
      expect((await post(app, sent)).status).toBe(201);
      expect((await post(app, sent)).status).toBe(200);
      const changed = await post(app, note("inbox/a.md", { source_id: "ff-1" }, "two\n"));
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({ ok: false, error: "note_exists" });
    });

    it("D1 (f): the index sees a pulled note and the service's own earlier commit", async () => {
      const app = makeApp();
      expect((await post(app, note("inbox/a.md", { source_id: "ff-1" }))).status).toBe(201);
      pushFromElsewhere("remote-note", {
        "inbox/r.md": stringifyNote({ ...VALID, source_id: "gm-7" }, "r\n"),
      });
      const pulled = await post(app, note("inbox/x.md", { source_id: "gm-7" }));
      expect(pulled.status).toBe(409);
      expect(await pulled.json()).toEqual({
        ok: false,
        error: "duplicate_source",
        path: "inbox/r.md",
      });
      const own = await post(app, note("inbox/y.md", { source_id: "ff-1" }));
      expect(own.status).toBe(409);
      expect(((await own.json()) as { path: string }).path).toBe("inbox/a.md");
    });

    it("a vault over the index limits fails closed with 500 write_failed", async () => {
      const app = createApp({
        writer: createNoteWriter({
          vaultDir: fixture.vaultDir,
          author: TEST_AUTHOR,
          git: spyGit(),
          sourceIndex: createSourceIndex({ maxEntries: 1 }),
        }),
        ingestToken: TOKEN,
        log: (message) => logs.push(message),
      });
      const response = await post(app, note("inbox/a.md", { source_id: "ff-1" }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
      expect(logs).toEqual(["write_failed: source index limit"]);
      expect(existsSync(join(fixture.vaultDir, "inbox", "a.md"))).toBe(false);
    });

    it("D3 (h): a commit that fails before or after add leaves no file and the retry is 201", async () => {
      const variants: Array<[string, Partial<GitApi>]> = [
        [
          "throws before add",
          {
            commitFile: async () => {
              throw new GitError("add", 1);
            },
          },
        ],
        [
          "adds then throws",
          {
            commitFile: async (dir, relPath) => {
              await runGit(dir, ["add", "--", relPath]);
              throw new GitError("commit", 1);
            },
          },
        ],
      ];
      for (const [i, [, overrides]] of variants.entries()) {
        const path = `inbox/h${i}.md`;
        const failing = makeApp(overrides);
        expect((await post(failing, note(path))).status).toBe(500);
        expect(existsSync(join(fixture.vaultDir, path))).toBe(false);
        expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
        expect((await post(makeApp(), note(path))).status).toBe(201);
      }
    });

    it("D3 (h): a failed commit at a path tracked in HEAD but missing from the tree stages no deletion", async () => {
      pushFromElsewhere("tracked", { "inbox/t.md": "tracked\n" });
      git(fixture.vaultDir, ["pull", "--rebase"]);
      // A dirty tree would fail the pull, so the file goes missing right after the pull.
      const app = makeApp({
        pullRebase: async (...args) => {
          await defaultGit.pullRebase(...args);
          rmSync(join(fixture.vaultDir, "inbox", "t.md"));
        },
        commitFile: async (dir, relPath) => {
          await runGit(dir, ["add", "--", relPath]);
          throw new GitError("commit", 1);
        },
      });
      expect((await post(app, note("inbox/t.md"))).status).toBe(500);
      expect(logs).toEqual(["write_failed: git commit exit 1"]);
      expect(git(fixture.vaultDir, ["diff", "--cached", "--name-status"])).toBe("");
      expect(git(fixture.vaultDir, ["ls-tree", "-r", "--name-only", "HEAD", "inbox/t.md"])).toBe(
        "inbox/t.md",
      );
    });

    it("D3 (h): a commit that lands and then throws keeps the file tracked and the tree clean", async () => {
      const app = makeApp({
        commitFile: async (...args) => {
          await defaultGit.commitFile(...args);
          throw new GitError("rev-parse", 1);
        },
      });
      expect((await post(app, note("inbox/k.md"))).status).toBe(500);
      expect(existsSync(join(fixture.vaultDir, "inbox", "k.md"))).toBe(true);
      expect(git(fixture.vaultDir, ["ls-files", "inbox/k.md"])).toBe("inbox/k.md");
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    });
  });

  describe("T12: push retries and pending commits", () => {
    const badUrl = () => `file://${join(fixture.root, "missing", "r.git")}`;
    const setBad = () => git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl()]);
    const setGood = () =>
      git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", fixture.remote]);
    const head = () => git(fixture.vaultDir, ["rev-parse", "HEAD"]);

    it("a first push that works waits for nothing", async () => {
      expect((await post(makeApp(), note("inbox/ok.md"))).status).toBe(201);
      expect(sleeps).toEqual([]);
    });

    it("one failure then success waits 1000 ms once", async () => {
      let calls = 0;
      const app = makeApp({
        push: (dir) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new GitError("push", 128));
          return defaultGit.push(dir);
        },
      });
      expect((await post(app, note("inbox/r1.md"))).status).toBe(201);
      expect(sleeps).toEqual([1000]);
    });

    it("D1: success on the 3rd retry is 201 with waits 1000, 2000, 4000", async () => {
      let calls = 0;
      const app = makeApp({
        push: (dir) => {
          calls += 1;
          if (calls <= 3) return Promise.reject(new GitError("push", 128));
          return defaultGit.push(dir);
        },
      });
      const response = await post(app, note("inbox/r3.md"));
      expect(response.status).toBe(201);
      expect(calls).toBe(4);
      expect(sleeps).toEqual([1000, 2000, 4000]);
      expect(remoteSha()).toBe(head());
    });

    it("R8.3: a push that never lands is 502 push_pending with the local commit after 4 attempts", async () => {
      setBad();
      const before = remoteSha();
      const response = await post(makeApp(), note("inbox/never.md"));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        ok: false,
        error: "push_pending",
        path: "inbox/never.md",
        commit: head(),
      });
      expect(gitCalls.filter((c) => c === "push")).toHaveLength(4);
      expect(sleeps).toEqual([1000, 2000, 4000]);
      expect(remoteSha()).toBe(before);
    });

    it("a null exit code is transient and retried", async () => {
      let calls = 0;
      const app = makeApp({
        push: (dir) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new GitError("push", null));
          return defaultGit.push(dir);
        },
      });
      expect((await post(app, note("inbox/nocode.md"))).status).toBe(201);
      expect(sleeps).toEqual([1000]);
    });

    it("an error that is not a GitError is not retried and is a 500", async () => {
      const app = makeApp({ push: () => Promise.reject(new Error("boom")) });
      expect((await post(app, note("inbox/boom.md"))).status).toBe(500);
      expect(sleeps).toEqual([]);
    });

    it("D2: a push rejected after the pull is not retried; the next write pushes both commits", async () => {
      let once = true;
      const app = makeApp({
        pullRebase: async (...args) => {
          await defaultGit.pullRebase(...args);
          if (once) {
            once = false;
            pushFromElsewhere("moved", { "inbox/elsewhere.md": "elsewhere\n" });
          }
        },
      });
      const first = await post(app, note("inbox/rej.md"));
      expect(first.status).toBe(502);
      expect(((await first.json()) as { error: string }).error).toBe("push_pending");
      expect(gitCalls.filter((c) => c === "push")).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(logs).toContain("push_pending: git push exit 1");

      const second = await post(app, note("inbox/after.md"));
      expect(second.status).toBe(201);
      expect(remoteSha()).toBe(head());
      expect(remoteFile("inbox/rej.md")).toBe(stringifyNote(VALID, "x\n"));
      expect(remoteFile("inbox/after.md")).toBe(stringifyNote(VALID, "x\n"));
      expect(remoteFile("inbox/elsewhere.md")).toBe("elsewhere\n");
    });

    it("R8.4: a write after a push_pending pushes the pending commit with the new one in one push", async () => {
      setBad();
      const app = makeApp();
      expect((await post(app, note("inbox/p1.md"))).status).toBe(502);
      setGood();
      gitCalls = [];
      sleeps = [];
      expect((await post(app, note("inbox/p2.md"))).status).toBe(201);
      expect(gitCalls.filter((c) => c === "push")).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(remoteSha()).toBe(head());
      expect(remoteFile("inbox/p1.md")).toBe(stringifyNote(VALID, "x\n"));
      expect(remoteFile("inbox/p2.md")).toBe(stringifyNote(VALID, "x\n"));
    });

    it("D3: an unchanged create with the branch ahead whose push also fails is 502 with HEAD", async () => {
      setBad();
      const app = makeApp();
      const sent = note("inbox/ahead.md");
      expect((await post(app, sent)).status).toBe(502);
      sleeps = [];
      const again = await post(app, sent);
      expect(again.status).toBe(502);
      expect(await again.json()).toEqual({
        ok: false,
        error: "push_pending",
        path: "inbox/ahead.md",
        commit: head(),
      });
      expect(sleeps).toEqual([1000, 2000, 4000]);
    });

    it("D3: an unchanged create with the branch not ahead pushes nothing", async () => {
      const app = makeApp();
      const sent = note("inbox/level.md");
      expect((await post(app, sent)).status).toBe(201);
      gitCalls = [];
      expect((await post(app, sent)).status).toBe(200);
      expect(gitCalls).not.toContain("push");
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

    const response = await post(makeApp(), note("inbox/p.md"));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(marker);
    expect(logs.join("\n")).not.toContain(marker);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
    }
    expect(logs).toEqual(["push_pending: git push exit 128"]);

    let caught: unknown;
    try {
      await createNoteWriter({
        vaultDir: fixture.vaultDir,
        author: TEST_AUTHOR,
        git: defaultGit,
        sleep: recordSleep,
      }).write(note("inbox/q.md"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PushPendingError);
    const err = caught as Error;
    expect(err.message).not.toContain(marker);
    expect(inspect(err, { depth: 5 })).not.toContain(marker);
    expect(err.cause).toBeUndefined();
  });
});

describe("withPulled on the write queue", () => {
  function loggedWriter(overrides: Partial<GitApi> = {}) {
    return createNoteWriter({
      vaultDir: fixture.vaultDir,
      author: TEST_AUTHOR,
      git: spyGit(overrides),
      sleep: recordSleep,
      log: (message) => logs.push(message),
    });
  }

  const settle = () => new Promise<void>((done) => setTimeout(done, 150));

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((done) => {
      open = done;
    });
    return { opened, open };
  }

  it("waits for a write in flight and then sees its commit", async () => {
    const hold = gate();
    const writer = loggedWriter({
      pullRebase: async (...args) => {
        gitCalls.push("pullRebase");
        await hold.opened;
        return defaultGit.pullRebase(...args);
      },
    });
    const order: string[] = [];
    const writing = writer.write(note("inbox/w.md")).then(() => order.push("write"));
    const reading = writer.withPulled(async () => {
      order.push("read");
      return existsSync(join(fixture.vaultDir, "inbox", "w.md"));
    });
    await settle();
    expect(order).toEqual([]);
    expect(gitCalls.filter((c) => c === "pullRebase")).toHaveLength(1);
    hold.open();
    await writing;
    expect(await reading).toBe(true);
    expect(order).toEqual(["write", "read"]);
  });

  it("holds the next write until the read function is done", async () => {
    const hold = gate();
    const writer = loggedWriter();
    const reading = writer.withPulled(async () => {
      await hold.opened;
      return "done";
    });
    const writing = writer.write(note("inbox/after.md"));
    await settle();
    expect(gitCalls.filter((c) => c === "pullRebase")).toHaveLength(1);
    expect(existsSync(join(fixture.vaultDir, "inbox", "after.md"))).toBe(false);
    hold.open();
    expect(await reading).toBe("done");
    expect((await writing).commit).toEqual(expect.any(String));
    expect(gitCalls.filter((c) => c === "pullRebase")).toHaveLength(2);
  });

  it("a failed pull runs the function with stale true and logs one fixed line", async () => {
    const writer = loggedWriter({
      pullRebase: async () => {
        throw new GitError("pull", 1);
      },
    });
    const seen = await writer.withPulled(async (state) => state);
    expect(seen).toEqual({ stale: true });
    expect(logs).toEqual(["read_pull_failed"]);
    const fresh = await loggedWriter().withPulled(async (state) => state);
    expect(fresh).toEqual({ stale: false });
  });

  it("a rejecting function rejects the call and the next write still commits", async () => {
    const writer = loggedWriter();
    await expect(
      writer.withPulled(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await writer.write(note("inbox/next.md"));
    expect(result.commit).toEqual(expect.any(String));
    expect(remoteFile("inbox/next.md")).toContain("x");
  });
});
