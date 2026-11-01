import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVaultConfig } from "../src/config/vault-config.js";
import { defaultGit, ensureClone } from "../src/git/index.js";
import type { FirefliesBody } from "../src/meetings/types.js";
import { createApp } from "../src/server/app.js";
import { parseNote } from "../src/vault/frontmatter.js";
import * as scrubModule from "../src/vault/scrub-note.js";
import * as validate from "../src/vault/validate.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";
import { pushFiles } from "./helpers/meeting-vault.js";

vi.mock("../src/vault/validate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/validate.js")>();
  return { ...real, validateFrontmatter: vi.fn(real.validateFrontmatter) };
});

vi.mock("../src/vault/scrub-note.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/scrub-note.js")>();
  return { ...real, scrubNote: vi.fn(real.scrubNote) };
});

// 32+ characters, built from parts so no secret-shaped literal sits in the file.
const TOKEN = ["fictional", "meetings", "token", "0123456789", "abcdefghijk"].join("-");
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const FIXTURES = join(import.meta.dirname, "fixtures");

function fixtureBody<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, "meetings", name), "utf8"));
}

/** A fixture secret assembled from the scrub fixture parts, never written as a literal. */
function fixtureSecret(): { value: string; rule: string } {
  const positive = JSON.parse(readFileSync(join(FIXTURES, "scrub", "positive.json"), "utf8")) as {
    text: { rule: string; parts: string[] }[];
  };
  const entry = positive.text.find((t) => t.rule === "aws_access_key_id");
  if (entry === undefined) throw new Error("fixture missing");
  return { value: entry.parts.slice(1, 4).join(""), rule: entry.rule };
}

let fixture: GitFixture;
let logs: string[];

function makeApp() {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: defaultGit,
    log: (m) => logs.push(m),
    sleep: () => Promise.resolve(),
  });
  return createApp({
    writer,
    meetings: writer,
    ingestToken: TOKEN,
    log: (m) => logs.push(m),
  });
}

function post(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.request("/meetings", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

function stored(path: string) {
  return parseNote(readFileSync(join(fixture.vaultDir, path), "utf8"));
}

beforeEach(async () => {
  fixture = createGitFixture();
  logs = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
  vi.mocked(validate.validateFrontmatter).mockClear();
  vi.mocked(scrubModule.scrubNote).mockClear();
});

afterEach(() => {
  fixture.cleanup();
});

describe("POST /meetings stores a note", () => {
  for (const [label, file] of [
    ["fireflies", "fireflies-basic.json"],
    ["gemini", "gemini-basic.json"],
  ] as const) {
    it(`R1.1: ${label} stored`, async () => {
      const response = await post(makeApp(), fixtureBody(file));
      expect(response.status).toBe(201);
      const result = (await response.json()) as { ok: true; path: string; commit: string };
      expect(result.path).toMatch(/^personal\/meetings\/2026-10-30 · .+\.md$/u);
      expect(result.commit).toBe(git(fixture.remote, ["rev-parse", "main"]));
      expect(git(fixture.remote, ["log", "-1", "--format=%s", "main"])).toBe(
        `2brain: add meeting ${result.path}`,
      );
      expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    });
  }

  it("R6.3: person link comes from the folder listing only", async () => {
    pushFiles(fixture, {
      // Not YAML on purpose: a read of this file would break or leak.
      "people/Ana Ruiz.md": "\u0000not: [yaml\n",
      "topics/Bo Chen.md": "x\n",
    });
    const response = await post(makeApp(), fixtureBody("fireflies-basic.json"));
    expect(response.status).toBe(201);
    const { path } = (await response.json()) as { path: string };
    const participants = stored(path).data.participants;
    expect(participants).toEqual(["[[Ana Ruiz]]", "Bo Chen", "carol@example.com"]);
  });

  it("R6.3: a person folder that leaves the vault (symlink) gives no link", async () => {
    const outside = join(fixture.root, "outside-people");
    mkdirSync(outside);
    writeFileSync(join(outside, "Bo Chen.md"), "x\n");
    // `people` itself points out of the vault; the vault has no other person folder.
    symlinkSync(outside, join(fixture.vaultDir, "people"));
    const app = makeApp();
    const first = await post(app, fixtureBody("fireflies-basic.json"));
    expect(first.status).toBe(201);
    const { path } = (await first.json()) as { path: string };
    expect(stored(path).data.participants).toEqual(["ana ruiz", "Bo Chen", "carol@example.com"]);
  });

  it("R6.5: one scrub, one validation, and the stored file is valid", async () => {
    const response = await post(makeApp(), fixtureBody("gemini-basic.json"));
    expect(response.status).toBe(201);
    const { path } = (await response.json()) as { path: string };
    expect(vi.mocked(scrubModule.scrubNote)).toHaveBeenCalledTimes(1);
    const forPath = vi.mocked(validate.validateFrontmatter).mock.calls.filter((c) => c[1] === path);
    expect(forPath).toHaveLength(1);

    const cfg = await loadVaultConfig(fixture.vaultDir);
    const verdict = (
      await vi.importActual<typeof import("../src/vault/validate.js")>("../src/vault/validate.js")
    ).validateFrontmatter(stored(path).data, path, cfg);
    expect(verdict.ok).toBe(true);
  });

  it("R8.6: a secret in a sentence, the title and an attendee name is redacted everywhere", async () => {
    const { value, rule } = fixtureSecret();
    const body = fixtureBody<FirefliesBody>("fireflies-basic.json");
    body.transcript.title = `Weekly ${value}`;
    body.transcript.meeting_attendees = [{ displayName: `Dan ${value}` }];
    (body.transcript.sentences[0] as { text: string }).text = `The key is ${value} today.`;
    const response = await post(makeApp(), body);
    const raw = await response.text();
    expect(response.status).toBe(201);
    const result = JSON.parse(raw) as { path: string; redactions: unknown };
    expect(result.redactions).toEqual([{ rule, count: 3 }]);
    expect(raw).not.toContain(value);

    const file = readFileSync(join(fixture.vaultDir, result.path), "utf8");
    expect(file).not.toContain(value);
    expect(file.split(`[REDACTED:${rule}]`)).toHaveLength(4);
    expect(git(fixture.remote, ["log", "-1", "--format=%B", "main"])).not.toContain(value);
    expect(git(fixture.remote, ["show", `main:${result.path}`])).not.toContain(value);
    expect(logs.join("\n")).not.toContain(value);
  });
});
