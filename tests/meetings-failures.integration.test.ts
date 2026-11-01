import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone, GitError } from "../src/git/index.js";
import type { FirefliesBody } from "../src/meetings/types.js";
import { createApp } from "../src/server/app.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";
import { pushFiles, storedMeeting } from "./helpers/meeting-vault.js";

// 32+ characters, built from parts so no secret-shaped literal sits in the file.
const TOKEN = ["fictional", "meetings", "token", "0123456789", "abcdefghijk"].join("-");
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function fixtureBody(): FirefliesBody {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "meetings", "fireflies-basic.json"), "utf8"),
  );
}

/** A second, different meeting: another id and a start one hour later. */
function otherBody(): FirefliesBody {
  const body = fixtureBody();
  body.transcript.id = "01FFOTHEREXAMPLE";
  body.transcript.date += 3_600_000;
  return body;
}

let fixture: GitFixture;
let failPush: boolean;
let pushCalls: number;

function makeApp() {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: {
      ...defaultGit,
      push: (dir) => {
        pushCalls += 1;
        if (failPush) return Promise.reject(new GitError("push", 128));
        return defaultGit.push(dir);
      },
    },
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  return createApp({ writer, meetings: writer, ingestToken: TOKEN, log: () => undefined });
}

type App = ReturnType<typeof makeApp>;

function post(app: App, body: unknown) {
  return app.request("/meetings", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

const head = () => git(fixture.vaultDir, ["rev-parse", "HEAD"]);
const remoteMain = () => git(fixture.remote, ["rev-parse", "main"]);
const status = () => git(fixture.vaultDir, ["status", "--porcelain"]);

beforeEach(async () => {
  fixture = createGitFixture();
  failPush = false;
  pushCalls = 0;
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  fixture.cleanup();
});

/** Post the fixture meeting while the push fails; returns the app and the 502 body. */
async function firstPostFails(): Promise<{
  app: App;
  path: string;
  commit: string;
  remoteBefore: string;
}> {
  const app = makeApp();
  const remoteBefore = remoteMain();
  failPush = true;
  const response = await post(app, fixtureBody());
  const json = (await response.json()) as { path: string; commit: string };
  expect(response.status).toBe(502);
  expect(pushCalls).toBe(4);
  return { app, path: json.path, commit: json.commit, remoteBefore };
}

describe("meeting push failures", () => {
  it("R8.4: a push that never lands is 502 push_pending with the local commit", async () => {
    const { path, commit, remoteBefore } = await firstPostFails();
    expect(commit).toBe(head());
    expect(path).toMatch(/^personal\/meetings\/2026-10-30 · .+\.md$/u);
    expect(remoteMain()).toBe(remoteBefore);
  });

  it("R8.4: the response body is exactly push_pending, path and commit", async () => {
    const app = makeApp();
    failPush = true;
    const response = await post(app, fixtureBody());
    const json = (await response.json()) as { path: string };
    expect(response.status).toBe(502);
    expect(json).toEqual({ ok: false, error: "push_pending", path: json.path, commit: head() });
  });

  it("R8.4: the next meeting request delivers the pending commit", async () => {
    const { app, path } = await firstPostFails();
    failPush = false;
    const response = await post(app, otherBody());
    expect(response.status).toBe(201);
    expect(remoteMain()).toBe(head());
    git(fixture.remote, ["cat-file", "-e", `main:${path}`]);
  });

  it("R8.2: already_stored pushes the waiting commit and answers 200", async () => {
    const { app, path, commit, remoteBefore } = await firstPostFails();
    failPush = false;
    const response = await post(app, fixtureBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path,
      commit: null,
      already_stored: true,
    });
    expect(head()).toBe(commit);
    expect(remoteMain()).toBe(commit);
    expect(remoteMain()).not.toBe(remoteBefore);
  });

  it("R8.2: already_stored with the push still failing is 502 push_pending", async () => {
    const { app, path, commit, remoteBefore } = await firstPostFails();
    const response = await post(app, fixtureBody());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "push_pending", path, commit });
    expect(pushCalls).toBe(8);
    expect(head()).toBe(commit);
    expect(remoteMain()).toBe(remoteBefore);
  });

  it("D2: already_stored with nothing pending makes no push call", async () => {
    const app = makeApp();
    const first = await post(app, fixtureBody());
    expect(first.status).toBe(201);
    const callsBefore = pushCalls;
    expect(callsBefore).toBeGreaterThan(0);
    const again = await post(app, fixtureBody());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { already_stored?: boolean }).already_stored).toBe(true);
    expect(pushCalls).toBe(callsBefore);
  });

  it("D1: a holder of the source id that HEAD does not track is 409 note_exists", async () => {
    const file = join(fixture.vaultDir, "personal", "meetings", "x.md");
    pushFiles(fixture, { "personal/meetings/.keep": "\n" });
    const app = makeApp();
    // Pull the seed first so the untracked file is not in the way of the rebase.
    git(fixture.vaultDir, ["pull", "--rebase", "origin", "main"]);
    const bytes = storedMeeting(`fireflies:${fixtureBody().transcript.id}`);
    writeFileSync(file, bytes);
    const headBefore = head();
    const remoteBefore = remoteMain();
    const callsBefore = pushCalls;

    const response = await post(app, fixtureBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "note_exists" });
    expect(head()).toBe(headBefore);
    expect(remoteMain()).toBe(remoteBefore);
    expect(pushCalls).toBe(callsBefore);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(status()).toBe("?? personal/meetings/x.md");
  });

  it("D3: a plain meeting whose commit fails after add, with unstageFile failing once, leaves a clean index", async () => {
    let unstageCalls = 0;
    const writer = createNoteWriter({
      vaultDir: fixture.vaultDir,
      author: TEST_AUTHOR,
      git: {
        ...defaultGit,
        commitFile: async (dir, path) => {
          await defaultGit.addPaths(dir, [path]);
          throw new Error("commit failed");
        },
        unstageFile: (dir, path) => {
          unstageCalls += 1;
          if (unstageCalls === 1) return Promise.reject(new Error("reset failed"));
          return defaultGit.unstageFile(dir, path);
        },
      },
      log: () => undefined,
      sleep: () => Promise.resolve(),
    });
    const app = createApp({
      writer,
      meetings: writer,
      ingestToken: TOKEN,
      log: () => undefined,
    });
    const headBefore = head();
    const response = await post(app, fixtureBody());
    expect(response.status).toBe(500);
    expect(unstageCalls).toBe(2);
    expect(git(fixture.vaultDir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(status()).toBe("");
    expect(head()).toBe(headBefore);
  });
});

describe("meeting config", () => {
  it("R8.5: an unknown meetings key is 503 config_invalid with nothing changed", async () => {
    const seeded = pushFiles(fixture, { ".2brain/config.yaml": "meetings:\n  colour: blue\n" });
    const response = await post(makeApp(), fixtureBody());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "config_invalid",
      file: ".2brain/config.yaml",
      keyPath: "meetings.colour",
    });
    expect(head()).toBe(seeded);
    expect(remoteMain()).toBe(seeded);
    expect(status()).toBe("");
  });

  it("R8.5: a missing meeting type is 503 for meetings while POST /notes still works", async () => {
    const seeded = pushFiles(fixture, {
      ".2brain/config.yaml": "types:\n  idea: { value: idea, folder: inbox }\n",
    });
    const app = makeApp();
    const response = await post(app, fixtureBody());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "config_invalid",
      file: ".2brain/config.yaml",
      keyPath: "types.meeting",
    });
    expect(head()).toBe(seeded);
    expect(remoteMain()).toBe(seeded);
    expect(status()).toBe("");

    const note = await app.request("/notes", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        path: "inbox/a.md",
        frontmatter: { type: "idea", area: "personal", date: "2026-10-30", source: "manual" },
        body: "x\n",
      }),
    });
    expect(note.status).toBe(201);
  });

  it("R10.4: a config pushed from another clone applies to the next request", async () => {
    const app = makeApp();
    const first = await post(app, fixtureBody());
    expect(first.status).toBe(201);
    expect(((await first.json()) as { path: string }).path).toBe(
      "personal/meetings/2026-10-30 · Untitled meeting 15-00.md",
    );
    pushFiles(fixture, {
      ".2brain/config.yaml": 'meetings:\n  untitled_label: "Reunión sin título"\n',
    });
    const second = await post(app, otherBody());
    expect(second.status).toBe(201);
    expect(((await second.json()) as { path: string }).path).toBe(
      "personal/meetings/2026-10-30 · Reunión sin título 16-00.md",
    );
  });
});
