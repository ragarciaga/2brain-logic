import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGit, ensureClone, type GitApi } from "../src/git/index.js";
import type { FirefliesBody, GeminiBody } from "../src/meetings/types.js";
import { createApp } from "../src/server/app.js";
import { parseNote } from "../src/vault/frontmatter.js";
import type { Scrubber } from "../src/vault/scrub-note.js";
import { createNoteWriter, defaultScrubber } from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";
import { pushFiles } from "./helpers/meeting-vault.js";

const hooks = vi.hoisted(() => ({
  /** Runs for each validation; a returned verdict replaces the real one. */
  onValidate: undefined as
    | undefined
    | ((frontmatter: Record<string, unknown>, path: string) => unknown),
}));

vi.mock("../src/vault/validate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/validate.js")>();
  return {
    ...real,
    validateFrontmatter: (...args: Parameters<typeof real.validateFrontmatter>) =>
      hooks.onValidate?.(args[0], args[1]) ?? real.validateFrontmatter(...args),
  };
});

// 32+ characters, built from parts so no secret-shaped literal sits in the file.
const TOKEN = ["fictional", "meetings", "token", "0123456789", "abcdefghijk"].join("-");
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const FIXTURES = join(import.meta.dirname, "fixtures");
const CONFIG_TEMPLATE = join(import.meta.dirname, "..", "vault-template", ".2brain", "config.yaml");

const FOLDER = "personal/meetings";
const FF_PATH = `${FOLDER}/2026-10-30 · Planning review.md`;
const GM_PATH = `${FOLDER}/2026-10-30 · Planning review (Gemini).md`;

function fixtureBody<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, "meetings", name), "utf8")) as T;
}

/** A fixture secret assembled from the scrub fixture parts, never written as a literal. */
function fixtureSecret(): string {
  const positive = JSON.parse(readFileSync(join(FIXTURES, "scrub", "positive.json"), "utf8")) as {
    text: { rule: string; parts: string[] }[];
  };
  const entry = positive.text.find((t) => t.rule === "aws_access_key_id");
  if (entry === undefined) throw new Error("fixture missing");
  return entry.parts.slice(1, 4).join("");
}

const GEMINI_EVENT = fixtureBody<GeminiBody>("gemini-basic.json").calendar_events;

/** A Fireflies recording of the Gemini fixture's event (or of no event). */
function firefliesBody(id = "01FFEXAMPLE", withEvent = true): FirefliesBody {
  const body = fixtureBody<FirefliesBody>("fireflies-basic.json");
  body.transcript.id = id;
  body.calendar_events = withEvent ? structuredClone(GEMINI_EVENT) : [];
  return body;
}

function geminiBody(options: { id?: string; withEvent?: boolean; shiftMinutes?: number } = {}) {
  const { id, withEvent = true, shiftMinutes = 0 } = options;
  const body = fixtureBody<GeminiBody>("gemini-basic.json");
  if (id !== undefined) body.transcript.name = id;
  body.calendar_events = withEvent ? structuredClone(GEMINI_EVENT) : [];
  if (shiftMinutes !== 0) {
    const shift = (text: string): string =>
      new Date(Date.parse(text) + shiftMinutes * 60_000).toISOString().replace(".000Z", "Z");
    body.conference.startTime = shift(body.conference.startTime);
    body.conference.endTime = shift(body.conference.endTime);
    for (const entry of body.entries) entry.startTime = shift(entry.startTime);
  }
  return body;
}

let fixture: GitFixture;

function makeApp(overrides: { git?: Partial<GitApi>; scrubber?: Scrubber } = {}) {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: { ...defaultGit, ...overrides.git },
    ...(overrides.scrubber ? { scrubber: overrides.scrubber } : {}),
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  return createApp({ writer, meetings: writer, ingestToken: TOKEN, log: () => undefined });
}

type Answer = { status: number; json: Record<string, unknown> };

async function post(app: ReturnType<typeof makeApp>, body: unknown): Promise<Answer> {
  const response = await app.request("/meetings", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function file(path: string): string {
  return readFileSync(join(fixture.vaultDir, path), "utf8");
}

function remoteHead(): string {
  return git(fixture.remote, ["rev-parse", "main"]);
}

function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -3);
}

/** Config with the Gemini label replaced (a replacer function, so `$` stays literal). */
function configWithGeminiLabel(label: string): string {
  return readFileSync(CONFIG_TEMPLATE, "utf8").replace(
    'gemini: { value: gemini, label: "Gemini" }',
    () => `gemini: { value: gemini, label: "${label}" }`,
  );
}

beforeEach(async () => {
  hooks.onValidate = undefined;
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  fixture.cleanup();
});

describe("a second version of a meeting", () => {
  it("R7.2/R7.3: same event id, named next to the first and linked in one commit", async () => {
    const app = makeApp();
    const first = await post(app, firefliesBody());
    expect(first.status).toBe(201);
    expect(first.json.path).toBe(FF_PATH);
    const ffBefore = file(FF_PATH);
    const before = remoteHead();

    const second = await post(app, geminiBody());
    expect(second.status).toBe(201);
    expect(second.json.path).toBe(GM_PATH);
    expect(second.json.linked).toBe(FF_PATH);

    // The first note keeps its name; each `versions` is a wikilink to the other note.
    expect(parseNote(file(FF_PATH)).data.versions).toEqual([`[[${base(GM_PATH)}]]`]);
    expect(parseNote(file(GM_PATH)).data.versions).toEqual([`[[${base(FF_PATH)}]]`]);
    // The first body is untouched; only its frontmatter changed.
    expect(parseNote(file(FF_PATH)).content).toBe(parseNote(ffBefore).content);

    // Exactly one new commit holds both paths, and the tree is clean.
    expect(git(fixture.remote, ["rev-list", "--count", `${before}..main`])).toBe("1");
    expect(git(fixture.remote, ["log", "-1", "--format=%s", "main"])).toBe(
      `2brain: add meeting ${GM_PATH} (version of ${FF_PATH})`,
    );
    const changed = git(fixture.remote, [
      "-c",
      "core.quotepath=off",
      "show",
      "--name-only",
      "--format=",
      "main",
    ]).split("\n");
    expect(changed.sort()).toEqual([FF_PATH, GM_PATH].sort());
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    expect(second.json.commit).toBe(remoteHead());
  });

  it("D2: the version goes to the first note's folder and area, not the routed area", async () => {
    const template = readFileSync(CONFIG_TEMPLATE, "utf8");
    pushFiles(fixture, {
      ".2brain/config.yaml": template.replace("default_area: null", () => "default_area: work"),
    });
    const app = makeApp();
    const first = await post(app, firefliesBody());
    expect(first.json.path).toBe("work/meetings/2026-10-30 · Planning review.md");
    // The area now routes to the first area (personal), but the version stays with the first note.
    pushFiles(fixture, { ".2brain/config.yaml": template });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(201);
    expect(second.json.path).toBe("work/meetings/2026-10-30 · Planning review (Gemini).md");
    expect(parseNote(file(second.json.path as string)).data.area).toBe("work");
  });

  it("links on the event id alone when the recordings do not overlap", async () => {
    const app = makeApp();
    await post(app, firefliesBody());
    // 90 minutes later, inside a three hour event: no half overlap.
    const event = GEMINI_EVENT[0] as { end: { dateTime: string } };
    const late = geminiBody({ shiftMinutes: 90 });
    late.calendar_events = structuredClone(GEMINI_EVENT);
    (late.calendar_events[0] as typeof event).end.dateTime = "2026-10-30T18:00:00Z";
    const second = await post(app, late);
    expect(second.status).toBe(201);
    expect(second.json.linked).toBe(FF_PATH);
  });

  it("links on the overlap alone when there is no calendar event", async () => {
    const app = makeApp();
    const first = await post(app, firefliesBody("01FFEXAMPLE", false));
    const firstPath = first.json.path as string;
    expect(firstPath).toBe(`${FOLDER}/2026-10-30 · Untitled meeting 15-00.md`);
    const second = await post(app, geminiBody({ withEvent: false }));
    expect(second.status).toBe(201);
    expect(second.json.linked).toBe(firstPath);
    expect(second.json.path).toBe(`${FOLDER}/2026-10-30 · Untitled meeting 15-00 (Gemini).md`);
  });

  it("R8.3: a redelivery of the first and the second change no body and add no commit", async () => {
    const app = makeApp();
    await post(app, firefliesBody());
    const bodyBefore = parseNote(file(FF_PATH)).content;
    await post(app, geminiBody());
    const gmBody = parseNote(file(GM_PATH)).content;
    const head = remoteHead();
    const again = await post(app, firefliesBody());
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, path: FF_PATH, commit: null, already_stored: true });
    expect(remoteHead()).toBe(head);
    expect(parseNote(file(FF_PATH)).content).toBe(bodyBefore);
    expect(parseNote(file(GM_PATH)).content).toBe(gmBody);
  });

  it("does not relink a note that already has a version: the newcomer gets the time suffix", async () => {
    const app = makeApp();
    await post(app, firefliesBody());
    await post(app, geminiBody());
    const ffBytes = file(FF_PATH);
    const gmBytes = file(GM_PATH);
    const third = await post(app, geminiBody({ id: "conferenceRecords/c1/transcripts/t2" }));
    expect(third.status).toBe(201);
    expect(third.json.path).toBe(`${FOLDER}/2026-10-30 · Planning review 15-00.md`);
    expect(third.json.linked).toBeUndefined();
    expect(file(FF_PATH)).toBe(ffBytes);
    expect(file(GM_PATH)).toBe(gmBytes);
  });

  it("a symlinked meeting note is not a candidate", async () => {
    await post(makeApp(), firefliesBody());
    const real = join(fixture.root, "outside-note.md");
    writeFileSync(real, file(FF_PATH));
    // The swap happens inside the pull, so the tree is not dirty when the pull runs.
    const app = makeApp({
      git: {
        pullRebase: async (...args) => {
          await defaultGit.pullRebase(...args);
          unlinkSync(join(fixture.vaultDir, FF_PATH));
          symlinkSync(real, join(fixture.vaultDir, FF_PATH));
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(201);
    expect(second.json.linked).toBeUndefined();
    expect(second.json.path).toBe(`${FOLDER}/2026-10-30 · Planning review 15-00.md`);
    expect(parseNote(readFileSync(real, "utf8")).data.versions).toBeUndefined();
  });
});

describe("R8.3: a failed commit", () => {
  it("removes the new file and restores the first note", async () => {
    const app = makeApp();
    await post(app, firefliesBody());
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);

    const failing = makeApp({
      git: {
        commitPaths: () => Promise.reject(new Error("boom")),
      },
    });
    const second = await post(failing, geminiBody());
    expect(second.status).toBe(500);
    expect(second.json.error).toBe("write_failed");
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
    expect(file(FF_PATH)).toBe(gitRaw(fixture.vaultDir, ["show", `HEAD:${FF_PATH}`]));
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });
});

describe("rollback resets the index", () => {
  const staged = () => git(fixture.vaultDir, ["diff", "--cached", "--name-only"]);
  const status = () => git(fixture.vaultDir, ["status", "--porcelain"]);
  const headNow = () => git(fixture.vaultDir, ["rev-parse", "HEAD"]);

  /** `unstageFile` that throws on its first call for `failPath`. */
  function unstageFailingOnce(failPath: string): Partial<GitApi> {
    let failed = false;
    return {
      commitPaths: () => Promise.reject(new Error("boom")),
      unstageFile: (dir, rel) => {
        if (!failed && rel === failPath) {
          failed = true;
          return Promise.reject(new Error("reset failed"));
        }
        return defaultGit.unstageFile(dir, rel);
      },
    };
  }

  async function expectBothAtHead(failPath: string): Promise<void> {
    await post(makeApp(), firefliesBody());
    const second = await post(makeApp({ git: unstageFailingOnce(failPath) }), geminiBody());
    expect(second.status).toBe(500);
    expect(second.json.error).toBe("write_failed");
    expect(staged()).toBe("");
    expect(status()).toBe("");
    expect(file(FF_PATH)).toBe(gitRaw(fixture.vaultDir, ["show", `HEAD:${FF_PATH}`]));
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
  }

  it("unstageFile failing once for the other note still leaves both at HEAD", async () => {
    await expectBothAtHead(FF_PATH);
  });

  it("unstageFile failing once for the new note still leaves both at HEAD", async () => {
    await expectBothAtHead(GM_PATH);
  });

  it("headSha failing in the rollback still resets the index", async () => {
    await post(makeApp(), firefliesBody());
    const before = headNow();
    let armed = false;
    const app = makeApp({
      git: {
        commitPaths: () => {
          armed = true;
          return Promise.reject(new Error("boom"));
        },
        headSha: (dir) => {
          if (armed) return Promise.reject(new Error("head failed"));
          return defaultGit.headSha(dir);
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(500);
    expect(staged()).toBe("");
    expect(headNow()).toBe(before);
  });

  it("a landed commit keeps both paths", async () => {
    await post(makeApp(), firefliesBody());
    const app = makeApp({
      git: {
        commitPaths: async (...args) => {
          await defaultGit.commitPaths(...args);
          throw new Error("boom after commit");
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(500);
    expect(status()).toBe("");
    expect(file(GM_PATH)).toBe(gitRaw(fixture.vaultDir, ["show", `HEAD:${GM_PATH}`]));
    expect(file(FF_PATH)).toBe(gitRaw(fixture.vaultDir, ["show", `HEAD:${FF_PATH}`]));
    expect(parseNote(file(FF_PATH)).data.versions).toBeDefined();
  });
});

describe("D5: an untracked leftover of the other source", () => {
  it("an untracked other-source note is not linked", async () => {
    await post(makeApp(), firefliesBody());
    const saved = file(FF_PATH);
    const other = fixture.cloneElsewhere("remover");
    git(other, ["rm", "-q", FF_PATH]);
    git(other, ["commit", "-q", "-m", "remove the first note"]);
    git(other, ["push", "-q", "origin", "main"]);
    // The leftover appears after the real pull, so the pull is not blocked by it.
    const app = makeApp({
      git: {
        pullRebase: async (...args) => {
          await defaultGit.pullRebase(...args);
          // The pull removed the folder with the note; the leftover brings it back.
          mkdirSync(join(fixture.vaultDir, FOLDER), { recursive: true });
          writeFileSync(join(fixture.vaultDir, FF_PATH), saved);
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(201);
    expect(second.json.linked).toBeUndefined();
    expect(second.json.path).toBe(`${FOLDER}/2026-10-30 · Planning review 15-00.md`);
    expect(file(FF_PATH)).toBe(saved);
    expect(git(fixture.vaultDir, ["ls-files", "--", FF_PATH])).toBe("");
    expect(
      git(fixture.remote, [
        "-c",
        "core.quotepath=false",
        "show",
        "--name-only",
        "--format=",
        "main",
      ]),
    ).toBe(second.json.path);
  });
});

describe("R4.6: two meetings that want one path", () => {
  it("adds the local time, then answers 409 and writes nothing", async () => {
    const app = makeApp();
    const a = await post(app, firefliesBody("01FFAAA"));
    expect(a.json.path).toBe(FF_PATH);
    // Same source, so not a version of A.
    const b = await post(app, firefliesBody("01FFBBB"));
    expect(b.status).toBe(201);
    expect(b.json.path).toBe(`${FOLDER}/2026-10-30 · Planning review 15-00.md`);
    expect(b.json.linked).toBeUndefined();

    const head = remoteHead();
    const c = await post(app, firefliesBody("01FFCCC"));
    expect(c.status).toBe(409);
    expect(c.json.error).toBe("note_exists");
    expect(remoteHead()).toBe(head);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("a taken version path is 409 and the first note does not change", async () => {
    const app = makeApp();
    await post(app, firefliesBody());
    pushFiles(fixture, { [GM_PATH]: "something else\n" });
    const ffBytes = file(FF_PATH);
    const second = await post(app, geminiBody());
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("note_exists");
    expect(file(FF_PATH)).toBe(ffBytes);
    expect(file(GM_PATH)).toBe("something else\n");
  });
});

describe("D2: every meeting path is checked before file work", () => {
  async function refusedVersion(configText: string): Promise<void> {
    const app = makeApp();
    await post(app, firefliesBody());
    pushFiles(fixture, { ".2brain/config.yaml": configText });
    const ffBytes = file(FF_PATH);
    const head = remoteHead();
    const second = await post(app, geminiBody());
    expect(second.status).toBe(400);
    expect(second.json).toEqual({ ok: false, error: "unsafe_path" });
    expect(remoteHead()).toBe(head);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(readdirNames()).not.toContain("2026-10-30 · Planning review (Ge:mini).md");
    expect(file(FF_PATH)).toBe(ffBytes);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  }

  function readdirNames(): string[] {
    return git(fixture.vaultDir, ["ls-files", FOLDER]).split("\n");
  }

  it("a label with a Windows-unsafe character fails NotePath", async () => {
    await refusedVersion(configWithGeminiLabel("Ge:mini"));
  });

  it("a label that is a secret fails the scrub rules", async () => {
    await refusedVersion(configWithGeminiLabel(fixtureSecret()));
  });

  it("a label that would break a wikilink is refused", async () => {
    await refusedVersion(configWithGeminiLabel("Ge]]mini"));
  });
});

describe("D2: the plain path is checked too", () => {
  it("a Windows-unsafe area gives 400 unsafe_path and writes nothing", async () => {
    pushFiles(fixture, {
      ".2brain/config.yaml": readFileSync(CONFIG_TEMPLATE, "utf8").replace(
        "areas: [personal, work]",
        () => "areas: [wo:rk]",
      ),
    });
    const head = remoteHead();
    const response = await post(makeApp(), firefliesBody());
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ ok: false, error: "unsafe_path" });
    expect(remoteHead()).toBe(head);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(fixture.vaultDir, "wo:rk"))).toBe(false);
  });
});

describe("the other note is rewritten safely", () => {
  /** A scrubber that runs `hook` when the version path is checked (after the candidate scan). */
  function hooked(hook: () => void): Scrubber {
    return {
      ...defaultScrubber,
      scrub: (text) => {
        if (text.endsWith("(Gemini).md")) hook();
        return defaultScrubber.scrub(text);
      },
    };
  }

  it("a note swapped for a symlink after the scan is refused and nothing outside is written", async () => {
    await post(makeApp(), firefliesBody());
    const outside = join(fixture.root, "outside-copy.md");
    const copy = file(FF_PATH);
    writeFileSync(outside, copy);
    const head = remoteHead();
    const app = makeApp({
      scrubber: hooked(() => {
        unlinkSync(join(fixture.vaultDir, FF_PATH));
        symlinkSync(outside, join(fixture.vaultDir, FF_PATH));
      }),
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(400);
    expect(second.json.error).toBe("unsafe_path");
    expect(readFileSync(outside, "utf8")).toBe(copy);
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
    expect(remoteHead()).toBe(head);
  });

  it("a symlink swapped in inside createMeetingNote is refused", async () => {
    await post(makeApp(), firefliesBody());
    const outside = join(fixture.root, "outside-copy.md");
    const copy = file(FF_PATH);
    writeFileSync(outside, copy);
    const head = remoteHead();
    // The scrubber arms the swap; the next headSha call is the one in createMeetingNote, after
    // the lstat of the other note.
    let armed = false;
    const app = makeApp({
      scrubber: hooked(() => {
        armed = true;
      }),
      git: {
        headSha: async (dir) => {
          if (armed) {
            armed = false;
            unlinkSync(join(fixture.vaultDir, FF_PATH));
            symlinkSync(outside, join(fixture.vaultDir, FF_PATH));
          }
          return defaultGit.headSha(dir);
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(400);
    expect(second.json.error).toBe("unsafe_path");
    expect(readFileSync(outside, "utf8")).toBe(copy);
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
    expect(remoteHead()).toBe(head);
    expect(lstatSync(join(fixture.vaultDir, FF_PATH)).isSymbolicLink()).toBe(true);
  });

  it("the rollback restore does not follow a symlink", async () => {
    await post(makeApp(), firefliesBody());
    const outside = join(fixture.root, "outside-file.md");
    writeFileSync(outside, "outside\n");
    const app = makeApp({
      git: {
        commitPaths: () => {
          unlinkSync(join(fixture.vaultDir, FF_PATH));
          symlinkSync(outside, join(fixture.vaultDir, FF_PATH));
          return Promise.reject(new Error("boom"));
        },
      },
    });
    const second = await post(app, geminiBody());
    expect(second.status).toBe(500);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("a note edited after the scan is refused (409) and keeps the edit", async () => {
    await post(makeApp(), firefliesBody());
    const head = remoteHead();
    const edited = `${file(FF_PATH)}edited\n`;
    // The merged frontmatter of the first note is validated after its bytes are read.
    hooks.onValidate = (_frontmatter, path) => {
      if (path === FF_PATH) writeFileSync(join(fixture.vaultDir, FF_PATH), edited);
      return undefined;
    };
    const second = await post(makeApp(), geminiBody());
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("note_exists");
    expect(file(FF_PATH)).toBe(edited);
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
    expect(remoteHead()).toBe(head);
  });

  it("a merged frontmatter that fails validation rejects the request and writes nothing", async () => {
    await post(makeApp(), firefliesBody());
    const head = remoteHead();
    const ffBytes = file(FF_PATH);
    hooks.onValidate = (frontmatter, path) =>
      path === FF_PATH
        ? { ok: false, error: "invalid_frontmatter", missing: [], invalid: ["date"], frontmatter }
        : undefined;
    const second = await post(makeApp(), geminiBody());
    expect(second.status).toBe(400);
    expect(second.json.error).toBe("invalid_frontmatter");
    expect(file(FF_PATH)).toBe(ffBytes);
    expect(existsSync(join(fixture.vaultDir, GM_PATH))).toBe(false);
    expect(remoteHead()).toBe(head);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });
});
