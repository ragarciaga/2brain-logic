import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGit, ensureClone, type GitApi, GitError } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import { parseNote, stringifyNote } from "../src/vault/frontmatter.js";
import { scrub, scrubFrontmatter } from "../src/vault/scrub/index.js";
import { createNoteWriter, type Scrubber } from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";

const TOKEN = "fictional-patch-token-0123456789-abcdefghij";

let fixture: GitFixture;
let gitCalls: string[];
let logs: string[];
let sleeps: number[];

function spyGit(overrides: Partial<GitApi> = {}): GitApi {
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

function makeApp(overrides: Partial<GitApi> = {}, scrubber?: Scrubber) {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: spyGit(overrides),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...(scrubber ? { scrubber } : {}),
  });
  return createApp({ writer, ingestToken: TOKEN, log: (message) => logs.push(message) });
}

function patch(app: ReturnType<typeof createApp>, payload: unknown) {
  return app.request("/notes", {
    method: "PATCH",
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

function head(): string {
  return git(fixture.vaultDir, ["rev-parse", "HEAD"]);
}

function vaultFile(path: string): Buffer {
  return readFileSync(join(fixture.vaultDir, path));
}

function status(): string {
  return git(fixture.vaultDir, ["status", "--porcelain"]);
}

/** Valid properties of a note of type idea under the default config. */
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

/** The original body used by the byte-for-byte checks: CRLF, a leading blank line, a trailing space. */
const BODY = "\nLine one\r\nLine two \r\n\r\n  indented\n";

function seedIdea(path = "inbox/a.md", extra: Record<string, unknown> = {}, body = BODY): string {
  const text = stringifyNote({ ...VALID, title: "alpha", ...extra }, body);
  seed({ [path]: text });
  return text;
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

describe("PATCH /notes against a real remote", () => {
  it("R6.1: merges a new key and an override, keeps the body bytes, commits and pushes", async () => {
    const original = seedIdea();
    const before = head();
    const response = await patch(makeApp(), {
      path: "inbox/a.md",
      set: { title: "beta", priority: 2 },
    });
    expect(response.status).toBe(200);
    const after = head();
    expect(after).not.toBe(before);
    expect(await response.json()).toEqual({ ok: true, path: "inbox/a.md", commit: after });
    const stored = parseNote(remoteFile("inbox/a.md"));
    expect(stored.data).toEqual({ ...VALID, title: "beta", priority: 2 });
    expect(Object.keys(stored.data)).toEqual([
      "type",
      "area",
      "date",
      "source",
      "title",
      "priority",
    ]);
    expect(stored.content).toBe(BODY);
    expect(remoteFile("inbox/a.md").endsWith(`---\n${BODY}`)).toBe(true);
    expect(original.endsWith(`---\n${BODY}`)).toBe(true);
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe("2brain: update inbox/a.md");
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%an <%ae>"])).toBe(
      `${TEST_AUTHOR.name} <${TEST_AUTHOR.email}>`,
    );
    expect(remoteSha()).toBe(after);
    expect(status()).toBe("");
  });

  it("a nested object in set replaces the whole value and null sets null", async () => {
    seedIdea("inbox/a.md", { meta: { a: 1, b: 2 }, note: "x" });
    const response = await patch(makeApp(), {
      path: "inbox/a.md",
      set: { meta: { c: 3 }, note: null },
    });
    expect(response.status).toBe(200);
    const data = parseNote(remoteFile("inbox/a.md")).data;
    expect(data.meta).toEqual({ c: 3 });
    expect(data).toHaveProperty("note", null);
  });

  it("a same-length value change is not unchanged", async () => {
    seedIdea("inbox/a.md", { title: "alpha" });
    const before = head();
    const response = await patch(makeApp(), { path: "inbox/a.md", set: { title: "bravo" } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commit: string | null; unchanged?: boolean };
    expect(body.unchanged).toBeUndefined();
    expect(body.commit).toBe(head());
    expect(head()).not.toBe(before);
    expect(parseNote(remoteFile("inbox/a.md")).data.title).toBe("bravo");
  });

  it("R6.1: a push that never lands gives 502 push_pending with the local commit and 3 waits", async () => {
    seedIdea();
    const badUrl = `file://${join(fixture.root, "missing", "r.git")}`;
    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl]);
    const response = await patch(makeApp(), { path: "inbox/a.md", set: { title: "beta" } });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "push_pending",
      path: "inbox/a.md",
      commit: head(),
    });
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(remoteSha()).not.toBe(head());
  });

  it("R6.5: once the push works again, an identical patch is 200 unchanged and delivers the commit", async () => {
    seedIdea();
    const badUrl = `file://${join(fixture.root, "missing", "r.git")}`;
    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", badUrl]);
    const app = makeApp();
    const sent = { path: "inbox/a.md", set: { title: "beta" } };
    expect((await patch(app, sent)).status).toBe(502);
    git(fixture.vaultDir, ["remote", "set-url", "--push", "origin", fixture.remote]);
    gitCalls = [];
    const retry = await patch(app, sent);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      ok: true,
      path: "inbox/a.md",
      commit: null,
      unchanged: true,
    });
    expect(gitCalls).not.toContain("commitFile");
    expect(remoteSha()).toBe(head());
  });

  it("R6.4: a missing path gives 404 note_not_found, nothing changes", async () => {
    seedIdea();
    const before = head();
    gitCalls = [];
    const response = await patch(makeApp(), { path: "inbox/none.md", set: { title: "x" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "note_not_found" });
    expect(head()).toBe(before);
    expect(gitCalls).not.toContain("commitFile");
    expect(existsSync(join(fixture.vaultDir, "inbox", "none.md"))).toBe(false);
  });

  it("R6.4: a missing parent directory gives 404 and creates nothing", async () => {
    const response = await patch(makeApp(), { path: "ghost/dir/x.md", set: { title: "x" } });
    expect(response.status).toBe(404);
    expect(existsSync(join(fixture.vaultDir, "ghost"))).toBe(false);
  });

  it("R6.4: a directory at the path gives 404", async () => {
    seed({ "inbox/dir.md/inner.md": "x\n" });
    const before = head();
    const response = await patch(makeApp(), { path: "inbox/dir.md", set: { title: "x" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "note_not_found" });
    expect(head()).toBe(before);
  });

  it("R6.5: a set equal to the current values of a hand-formatted note is 200 unchanged", async () => {
    const hand = [
      "---",
      "# kept as written",
      'type:   "person"',
      "area:  personal",
      'date: "2026-10-31"',
      "source:   manual",
      "tags: [a, b]",
      "---",
      "Body \r",
      "",
    ].join("\n");
    seed({ "people/ana.md": hand });
    const before = head();
    gitCalls = [];
    const response = await patch(makeApp(), {
      path: "people/ana.md",
      set: { type: "person", tags: ["a", "b"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "people/ana.md",
      commit: null,
      unchanged: true,
    });
    expect(vaultFile("people/ana.md").toString("utf8")).toBe(hand);
    expect(head()).toBe(before);
    expect(gitCalls).not.toContain("commitFile");
    expect(gitCalls).not.toContain("push");
    expect(remoteSha()).toBe(before);
  });

  it("an unquoted Obsidian date patches to 200 and stays the string 2026-10-31", async () => {
    const hand = "---\ntype: idea\narea: personal\ndate: 2026-10-31\nsource: manual\n---\nBody\n";
    seed({ "inbox/obs.md": hand });
    const response = await patch(makeApp(), { path: "inbox/obs.md", set: { title: "t" } });
    expect(response.status).toBe(200);
    const stored = parseNote(remoteFile("inbox/obs.md"));
    expect(stored.data.date).toBe("2026-10-31");
    expect(stored.data.title).toBe("t");
    expect(stored.content).toBe("Body\n");
    // The re-dump quotes the date-like string; the value is the same text.
    expect(remoteFile("inbox/obs.md")).toContain("\ndate: '2026-10-31'\n");
    expect(remoteFile("inbox/obs.md")).not.toContain("date: 2026-10-31");
  });

  it("an unquoted date in a no-op set is unchanged and the bytes stay", async () => {
    const hand = "---\ntype: idea\narea: personal\ndate: 2026-10-31\nsource: manual\n---\nBody\n";
    seed({ "inbox/obs.md": hand });
    const response = await patch(makeApp(), { path: "inbox/obs.md", set: { date: "2026-10-31" } });
    expect(await response.json()).toMatchObject({ unchanged: true, commit: null });
    expect(vaultFile("inbox/obs.md").toString("utf8")).toBe(hand);
  });

  const invalidSets: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "an unknown type",
      { type: "no-such" },
      { error: "invalid_frontmatter", missing: [], invalid: ["type"] },
    ],
    [
      "a bad date",
      { date: "2026-02-30" },
      { error: "invalid_frontmatter", missing: [], invalid: ["date"] },
    ],
    [
      "a type change out of its folder",
      { type: "person" },
      { error: "wrong_folder", expected: "people" },
    ],
  ];

  it.each(invalidSets)("R6.1: %s gives 400 and changes nothing", async (_name, set, expected) => {
    seedIdea();
    const before = head();
    const bytes = vaultFile("inbox/a.md");
    gitCalls = [];
    const response = await patch(makeApp(), { path: "inbox/a.md", set });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, ...expected });
    expect(vaultFile("inbox/a.md").equals(bytes)).toBe(true);
    expect(head()).toBe(before);
    expect(gitCalls).not.toContain("commitFile");
    expect(status()).toBe("");
  });

  it("D1: an invalid config gives 503 and no commit", async () => {
    seedIdea();
    seed({ ".2brain/config.yaml": "vault:\n  colour: blue\n" });
    const before = head();
    gitCalls = [];
    const response = await patch(makeApp(), { path: "inbox/a.md", set: { title: "x" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "config_invalid" });
    expect(head()).toBe(before);
    expect(gitCalls).not.toContain("commitFile");
  });

  it("an existing note that does not parse gives 400 invalid_frontmatter with empty lists", async () => {
    const broken = "---\nkey: [unclosed\n---\nBody\n";
    seed({ "inbox/broken.md": broken });
    const before = head();
    const response = await patch(makeApp(), { path: "inbox/broken.md", set: { title: "x" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_frontmatter",
      missing: [],
      invalid: [],
    });
    expect(vaultFile("inbox/broken.md").toString("utf8")).toBe(broken);
    expect(head()).toBe(before);
  });

  it("an existing note that is not UTF-8 gives 400 invalid_frontmatter and is not touched", async () => {
    const bytes = Buffer.concat([
      Buffer.from("---\ntype: idea\n---\nBody "),
      Buffer.from([0xff, 0xfe, 0x0a]),
    ]);
    seed({ "inbox/bin.md": bytes.toString("latin1") });
    // seed wrote latin1 text as UTF-8; write the raw invalid bytes over it and commit them
    writeFileSync(join(fixture.vaultDir, "inbox", "bin.md"), bytes);
    git(fixture.vaultDir, ["add", "inbox/bin.md"]);
    git(fixture.vaultDir, ["commit", "-m", "raw bytes"]);
    const before = head();
    const response = await patch(makeApp(), { path: "inbox/bin.md", set: { title: "x" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_frontmatter", invalid: [] });
    expect(vaultFile("inbox/bin.md").equals(bytes)).toBe(true);
    expect(head()).toBe(before);
  });

  const SECRET = ["ghp", "B".repeat(36)].join("_");

  it("R4.1: a secret in a top-level and a nested set value is stored redacted", async () => {
    seedIdea();
    const response = await patch(makeApp(), {
      path: "inbox/a.md",
      set: { title: `token ${SECRET}`, extra: { deep: [`x ${SECRET}`] } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "inbox/a.md",
      commit: head(),
      redactions: [{ rule: "github_token", count: 2 }],
    });
    const stored = remoteFile("inbox/a.md");
    expect(stored).not.toContain(SECRET);
    const data = parseNote(stored).data;
    expect(data.title).toBe("token [REDACTED:github_token]");
    expect(data.extra).toEqual({ deep: ["x [REDACTED:github_token]"] });
    expect(logs).toEqual(["redacted: github_token=2"]);
  });

  it("R4.1: a secret already in the stored body is left alone (only set is scrubbed)", async () => {
    const body = `kept ${SECRET}\n`;
    seedIdea("inbox/a.md", {}, body);
    const response = await patch(makeApp(), { path: "inbox/a.md", set: { title: "beta" } });
    expect(response.status).toBe(200);
    expect(parseNote(remoteFile("inbox/a.md")).content).toBe(body);
  });

  it("R4.1: a path with a secret gives 400 unsafe_path before any git work", async () => {
    const response = await patch(makeApp(), { path: `inbox/${SECRET}.md`, set: { a: 1 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
    expect(gitCalls).toEqual([]);
  });

  it("R4.1: a throwing scrubFrontmatter gives 500 scrub_failed, file and HEAD unchanged", async () => {
    seedIdea();
    const before = head();
    const bytes = vaultFile("inbox/a.md");
    const scrubber: Scrubber = {
      scrub: (text) => scrub(text),
      scrubFrontmatter: () => {
        throw new Error("boom");
      },
    };
    const response = await patch(makeApp({}, scrubber), {
      path: "inbox/a.md",
      set: { title: "beta" },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "scrub_failed" });
    expect(vaultFile("inbox/a.md").equals(bytes)).toBe(true);
    expect(head()).toBe(before);
  });

  it("D4: an alias-heavy stored note does not slow the patch and the scrubber gets only set", async () => {
    // Nine levels of anchors that each reference the previous one twice: about 2^9 leaves when
    // expanded, and the dumper would emit anchors for them.
    const lines = ["---", "type: idea", "area: personal", "date: 2026-10-31", "source: manual"];
    lines.push("l0: &a0 [x, x]");
    for (let i = 1; i < 9; i += 1) lines.push(`l${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    lines.push("---", "Body", "");
    seed({ "inbox/bomb.md": lines.join("\n") });
    const received: string[][] = [];
    const scrubber: Scrubber = {
      scrub: (text) => scrub(text),
      scrubFrontmatter: (data) => {
        received.push(Object.keys(data));
        return scrubFrontmatter(data);
      },
    };
    const response = await patch(makeApp({}, scrubber), {
      path: "inbox/bomb.md",
      set: { title: "t", n: 1 },
    });
    expect(response.status).toBe(200);
    expect(received).toEqual([["title", "n"]]);
  }, 10_000);

  it("D3: a symlink at the target pointing outside gives 400 unsafe_path, the outside file is untouched", async () => {
    seedIdea("inbox/keep.md");
    const outside = join(fixture.root, "outside.md");
    const outsideText = stringifyNote(VALID, "outside\n");
    writeFileSync(outside, outsideText);
    symlinkSync(outside, join(fixture.vaultDir, "inbox", "ln.md"));
    const response = await patch(makeApp(), { path: "inbox/ln.md", set: { title: "x" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
    expect(readFileSync(outside, "utf8")).toBe(outsideText);
  });

  it("D3: a parent directory symlinked outside gives 400 unsafe_path, the outside file is untouched", async () => {
    const outsideDir = join(fixture.root, "outside-dir");
    mkdirSync(outsideDir);
    const outsideText = stringifyNote(VALID, "outside\n");
    writeFileSync(join(outsideDir, "n.md"), outsideText);
    symlinkSync(outsideDir, join(fixture.vaultDir, "linked"));
    const response = await patch(makeApp(), { path: "linked/n.md", set: { title: "x" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "unsafe_path" });
    expect(readFileSync(join(outsideDir, "n.md"), "utf8")).toBe(outsideText);
  });

  it("D5: a commit that fails with HEAD unmoved restores the bytes and the index", async () => {
    seedIdea();
    const before = head();
    const bytes = vaultFile("inbox/a.md");
    const response = await patch(
      makeApp({
        commitFile: async (dir, relPath) => {
          // Stage the changed file like the real commit does, then fail without moving HEAD.
          git(dir, ["add", relPath]);
          throw new GitError("commit", 1);
        },
      }),
      { path: "inbox/a.md", set: { title: "beta" } },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
    expect(vaultFile("inbox/a.md").equals(bytes)).toBe(true);
    expect(status()).toBe("");
    expect(head()).toBe(before);
    expect(gitCalls).toContain("unstageFile");
  });

  it("D5: when the failed commit did move HEAD, the new bytes are kept", async () => {
    seedIdea();
    const response = await patch(
      makeApp({
        commitFile: async (...args) => {
          await defaultGit.commitFile(...args);
          throw new GitError("commit", 1);
        },
      }),
      { path: "inbox/a.md", set: { title: "beta" } },
    );
    expect(response.status).toBe(500);
    expect(parseNote(vaultFile("inbox/a.md").toString("utf8")).data.title).toBe("beta");
    expect(status()).toBe("");
  });

  it("409 duplicate_source: a set that gives source_id another note's value writes nothing", async () => {
    seedIdea("inbox/a.md", { source_id: "id-1" });
    seedIdea("inbox/b.md", { source_id: "id-2" });
    const before = head();
    const bytes = vaultFile("inbox/b.md");
    const response = await patch(makeApp(), { path: "inbox/b.md", set: { source_id: "id-1" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "duplicate_source",
      path: "inbox/a.md",
    });
    expect(vaultFile("inbox/b.md").equals(bytes)).toBe(true);
    expect(head()).toBe(before);
  });

  it("a set that repeats the note's own source_id is not a duplicate and still applies the rest", async () => {
    seedIdea("inbox/a.md", { source_id: "id-1" });
    const before = head();
    const response = await patch(makeApp(), {
      path: "inbox/a.md",
      set: { source_id: "id-1", title: "beta" },
    });
    expect(response.status).toBe(200);
    expect(head()).not.toBe(before);
    expect(await response.json()).toEqual({ ok: true, path: "inbox/a.md", commit: head() });
    const data = parseNote(remoteFile("inbox/a.md")).data;
    expect(data.title).toBe("beta");
    expect(data.source_id).toBe("id-1");
  });

  it("duplicate detection uses the source id property name from the vault config", async () => {
    seed({ ".2brain/config.yaml": "properties:\n  source_id: origin_id\n" });
    seedIdea("inbox/a.md", { origin_id: "id-1" });
    seedIdea("inbox/b.md", { origin_id: "id-2" });
    const before = head();
    const dup = await patch(makeApp(), { path: "inbox/b.md", set: { origin_id: "id-1" } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ ok: false, error: "duplicate_source", path: "inbox/a.md" });
    expect(head()).toBe(before);
    // The default name is just a property now: giving it a taken value is fine.
    const free = await patch(makeApp(), { path: "inbox/b.md", set: { source_id: "id-1" } });
    expect(free.status).toBe(200);
  });

  it("a set that gives source_id an unused value succeeds, and the index then finds it", async () => {
    seedIdea("inbox/a.md", { source_id: "id-1" });
    const app = makeApp();
    const first = await patch(app, { path: "inbox/a.md", set: { source_id: "id-9" } });
    expect(first.status).toBe(200);
    seedIdea("inbox/b.md", { source_id: "id-2" });
    const second = await patch(app, { path: "inbox/b.md", set: { source_id: "id-9" } });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ path: "inbox/a.md" });
  });

  it("the file mode and the body are kept; no other file is touched", async () => {
    seedIdea();
    seedIdea("inbox/other.md");
    const otherBefore = vaultFile("inbox/other.md");
    const mode = statSync(join(fixture.vaultDir, "inbox", "a.md")).mode;
    await patch(makeApp(), { path: "inbox/a.md", set: { title: "beta" } });
    expect(statSync(join(fixture.vaultDir, "inbox", "a.md")).mode).toBe(mode);
    expect(vaultFile("inbox/other.md").equals(otherBefore)).toBe(true);
    expect(git(fixture.vaultDir, ["show", "--name-only", "--format=", "HEAD"])).toBe("inbox/a.md");
  });

  describe("append", () => {
    const SECRET = ["ghp", "C".repeat(36)].join("_");
    const MEETING = { ...VALID, type: "meeting", title: "weekly" };
    const MEETING_PATH = "personal/meetings/m.md";

    function seedMeeting(body = "Transcript line\n"): string {
      const text = stringifyNote(MEETING, body);
      seed({ [MEETING_PATH]: text });
      return text;
    }

    function expectNothingWritten(before: string, original: Buffer, path: string) {
      expect(head()).toBe(before);
      expect(vaultFile(path).equals(original)).toBe(true);
      expect(gitCalls).not.toContain("commitFile");
      expect(gitCalls).not.toContain("push");
    }

    it("R6.2: adds the text after a body ending in a newline, earlier bytes unchanged, pushed", async () => {
      const original = Buffer.from(seedIdea());
      const before = head();
      const response = await patch(makeApp(), { path: "inbox/a.md", append: "new text" });
      expect(response.status).toBe(200);
      const after = head();
      expect(after).not.toBe(before);
      expect(await response.json()).toEqual({ ok: true, path: "inbox/a.md", commit: after });
      const stored = vaultFile("inbox/a.md");
      expect(stored.subarray(0, original.length).equals(original)).toBe(true);
      expect(stored.subarray(original.length).toString("utf8")).toBe("\nnew text");
      expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe("2brain: update inbox/a.md");
      expect(remoteSha()).toBe(after);
      expect(remoteFile("inbox/a.md")).toBe(stored.toString("utf8"));
      expect(status()).toBe("");
    });

    it("R6.2: a body without a final newline gets one blank line", async () => {
      seedIdea("inbox/a.md", {}, "Line one");
      const response = await patch(makeApp(), { path: "inbox/a.md", append: "new text" });
      expect(response.status).toBe(200);
      expect(parseNote(remoteFile("inbox/a.md")).content).toBe("Line one\n\nnew text");
    });

    it("set plus append merges the data and keeps the old body as a prefix", async () => {
      seedIdea();
      const response = await patch(makeApp(), {
        path: "inbox/a.md",
        set: { title: "beta" },
        append: "more",
      });
      expect(response.status).toBe(200);
      const stored = parseNote(remoteFile("inbox/a.md"));
      expect(stored.data.title).toBe("beta");
      expect(stored.content.startsWith(BODY)).toBe(true);
      expect(stored.content.endsWith("more")).toBe(true);
    });

    it("append only keeps a hand-formatted frontmatter comment", async () => {
      const text =
        "---\n# keep me\ntype: idea\narea: personal\ndate: 2026-10-31\nsource: manual\n---\nBody\n";
      seed({ "inbox/h.md": text });
      const response = await patch(makeApp(), { path: "inbox/h.md", append: "tail" });
      expect(response.status).toBe(200);
      expect(remoteFile("inbox/h.md")).toBe(`${text}\ntail`);
    });

    it("R6.3: append to a meeting is 409 immutable_body and writes nothing, empty append too", async () => {
      const original = Buffer.from(seedMeeting());
      const before = head();
      gitCalls = [];
      for (const append of ["added", ""]) {
        const response = await patch(makeApp(), { path: MEETING_PATH, append });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ ok: false, error: "immutable_body" });
      }
      expectNothingWritten(before, original, MEETING_PATH);
    });

    it("R6.3: set alone on a meeting is 200 and the body is unchanged", async () => {
      seedMeeting();
      const response = await patch(makeApp(), { path: MEETING_PATH, set: { title: "renamed" } });
      expect(response.status).toBe(200);
      const stored = parseNote(remoteFile(MEETING_PATH));
      expect(stored.data.title).toBe("renamed");
      expect(stored.content).toBe("Transcript line\n");
    });

    it("R6.3: set plus append on a meeting is 409 and writes nothing", async () => {
      const original = Buffer.from(seedMeeting());
      const before = head();
      gitCalls = [];
      const response = await patch(makeApp(), {
        path: MEETING_PATH,
        set: { title: "renamed" },
        append: "added",
      });
      expect(response.status).toBe(409);
      expectNothingWritten(before, original, MEETING_PATH);
    });

    it("R6.3: changing the type into meeting, or out of it, with an append is 409", async () => {
      const idea = Buffer.from(seedIdea());
      const before = head();
      gitCalls = [];
      const into = await patch(makeApp(), {
        path: "inbox/a.md",
        set: { type: "meeting" },
        append: "x",
      });
      expect(into.status).toBe(409);
      expectNothingWritten(before, idea, "inbox/a.md");

      const meeting = Buffer.from(seedMeeting());
      const before2 = head();
      gitCalls = [];
      const out = await patch(makeApp(), {
        path: MEETING_PATH,
        set: { type: "idea" },
        append: "x",
      });
      expect(out.status).toBe(409);
      expectNothingWritten(before2, meeting, MEETING_PATH);
    });

    it("S1: a set that moves a meeting to a mutable type is 409, so the two-step rewrite fails", async () => {
      const original = Buffer.from(seedMeeting());
      const before = head();
      gitCalls = [];
      const first = await patch(makeApp(), { path: MEETING_PATH, set: { type: "analysis" } });
      expect(first.status).toBe(409);
      expect(await first.json()).toEqual({ ok: false, error: "immutable_body" });
      expectNothingWritten(before, original, MEETING_PATH);
      const second = await patch(makeApp(), { path: MEETING_PATH, append: "rewrite" });
      expect(second.status).toBe(409);
      expectNothingWritten(before, original, MEETING_PATH);
    });

    it("S1: a set between two immutable types is allowed", async () => {
      seed({
        ".2brain/config.yaml": [
          "types:",
          "  meeting:",
          "    value: meeting",
          '    folder: "{area}/meetings"',
          "    immutable_body: true",
          "  call:",
          "    value: call",
          '    folder: "{area}/meetings"',
          "    immutable_body: true",
          "",
        ].join("\n"),
      });
      seedMeeting();
      const response = await patch(makeApp(), { path: MEETING_PATH, set: { type: "call" } });
      expect(response.status).toBe(200);
      const stored = parseNote(remoteFile(MEETING_PATH));
      expect(stored.data.type).toBe("call");
      expect(stored.content).toBe("Transcript line\n");
    });

    it("R6.3: the type is read under the owner's property name and value", async () => {
      seed({
        ".2brain/config.yaml": [
          "properties:",
          "  type: kind",
          "types:",
          "  meeting:",
          "    value: call",
          '    folder: "{area}/calls"',
          "    immutable_body: true",
          "  note:",
          "    value: meeting",
          "    folder: inbox",
          "",
        ].join("\n"),
      });
      const base = { area: "personal", date: "2026-10-31", source: "manual" };
      seed({
        "personal/calls/c.md": stringifyNote({ ...base, kind: "call" }, "Body\n"),
        "inbox/n.md": stringifyNote({ ...base, kind: "meeting" }, "Body\n"),
      });
      const blocked = await patch(makeApp(), { path: "personal/calls/c.md", append: "x" });
      expect(blocked.status).toBe(409);
      const allowed = await patch(makeApp(), { path: "inbox/n.md", append: "x" });
      expect(allowed.status).toBe(200);
    });

    it("R4.1: a secret in append is stored redacted and reported", async () => {
      seedIdea();
      const response = await patch(makeApp(), { path: "inbox/a.md", append: `token ${SECRET}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        path: "inbox/a.md",
        commit: head(),
        redactions: [{ rule: "github_token", count: 1 }],
      });
      expect(remoteFile("inbox/a.md").endsWith("token [REDACTED:github_token]")).toBe(true);
      expect(remoteFile("inbox/a.md")).not.toContain(SECRET);
    });

    it("R4.1: secrets in set and append count together in one entry", async () => {
      seedIdea();
      const response = await patch(makeApp(), {
        path: "inbox/a.md",
        set: { title: `t ${SECRET}` },
        append: `a ${SECRET}`,
      });
      expect(await response.json()).toMatchObject({
        redactions: [{ rule: "github_token", count: 2 }],
      });
    });

    it("R4.1: a scrubber that throws on the appended text gives 500 scrub_failed, nothing written", async () => {
      const original = Buffer.from(seedIdea());
      const before = head();
      gitCalls = [];
      const scrubber: Scrubber = {
        scrub: (text) => {
          if (text.includes("BOOM")) throw new Error("rule failed");
          return scrub(text);
        },
        scrubFrontmatter,
      };
      const response = await patch(makeApp({}, scrubber), { path: "inbox/a.md", append: "BOOM" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "scrub_failed" });
      expectNothingWritten(before, original, "inbox/a.md");
    });

    it("D1: an empty append on a mutable note is 200 unchanged and touches nothing", async () => {
      const original = Buffer.from(seedIdea());
      const before = head();
      gitCalls = [];
      const response = await patch(makeApp(), { path: "inbox/a.md", append: "" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        path: "inbox/a.md",
        commit: null,
        unchanged: true,
      });
      expectNothingWritten(before, original, "inbox/a.md");
    });

    it("an unparseable note and a non-UTF-8 note with append are 400 invalid_frontmatter", async () => {
      const broken = "---\nkey: [unclosed\n---\nBody\n";
      seed({ "inbox/broken.md": broken });
      const response = await patch(makeApp(), { path: "inbox/broken.md", append: "x" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "invalid_frontmatter",
        missing: [],
        invalid: [],
      });
      expect(vaultFile("inbox/broken.md").toString("utf8")).toBe(broken);

      const bytes = Buffer.concat([
        Buffer.from("---\ntype: idea\n---\nBody "),
        Buffer.from([0xff, 0x0a]),
      ]);
      seed({ "inbox/bin.md": "placeholder" });
      writeFileSync(join(fixture.vaultDir, "inbox", "bin.md"), bytes);
      git(fixture.vaultDir, ["add", "inbox/bin.md"]);
      git(fixture.vaultDir, ["commit", "-m", "raw bytes"]);
      const second = await patch(makeApp(), { path: "inbox/bin.md", append: "x" });
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({ error: "invalid_frontmatter", invalid: [] });
      expect(vaultFile("inbox/bin.md").equals(bytes)).toBe(true);
    });

    it("a NUL in append is 400 invalid_body", async () => {
      seedIdea();
      const response = await patch(makeApp(), { path: "inbox/a.md", append: "a\u0000b" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: "invalid_body" });
    });
  });
});
