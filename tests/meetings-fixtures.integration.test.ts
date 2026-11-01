import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultGit, ensureClone } from "../src/git/index.js";
import type { MockProvider } from "../src/llm/mock.js";
import { createApp } from "../src/server/app.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";
import { pushFiles } from "./helpers/meeting-vault.js";

// Recorded-shape fixtures (R2.6, R2.7) and the zero-LLM proof (R9.2).
// The fixtures model the payloads the shipped n8n templates send. Real hosts are replaced by
// example.com ones and are never fetched: app.fireflies.ai (transcript_url), docs.google.com
// (exportUri) and calendar.google.com (htmlLink).

// The meeting flow must never reach a model. Every call through src/llm/index.js lands on this
// mock provider, which has no canned response, so any call is recorded and then rejected.
vi.mock("../src/llm/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/llm/index.js")>();
  const { createMockProvider } = await import("../src/llm/mock.js");
  const provider = createMockProvider([]);
  return {
    ...real,
    provider,
    completeStructured: ((_ignored, request, schema) =>
      real.completeStructured(provider, request, schema)) as typeof real.completeStructured,
  };
});

type MockedLlm = {
  provider: MockProvider;
  completeStructured: typeof import("../src/llm/index.js").completeStructured;
};

// 32+ characters, built from parts so no secret-shaped literal sits in the file.
const TOKEN = ["fictional", "recorded", "token", "0123456789", "abcdefghijk"].join("-");
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const MEETINGS = join(import.meta.dirname, "fixtures", "meetings");
const CONFIG_TEMPLATE = join(import.meta.dirname, "..", "vault-template", ".2brain", "config.yaml");

// Recorded once from the reviewed output; a change of path naming must update them on purpose.
const FIREFLIES_PATH = "work/meetings/2026-10-27 · Product planning.md";
const GEMINI_PATH = "work/meetings/2026-10-29 · Budget review.md";

let fixture: GitFixture;
let llm: MockedLlm;

function config(): string {
  return readFileSync(CONFIG_TEMPLATE, "utf8")
    .replace("timezone: UTC", () => "timezone: America/Bogota")
    .replace("area_rules: []", () => "area_rules: [{ area: work, domain: example.com }]");
}

function makeApp() {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: defaultGit,
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  return createApp({ writer, meetings: writer, ingestToken: TOKEN, log: () => undefined });
}

async function post(app: ReturnType<typeof makeApp>, name: string) {
  const body = readFileSync(join(MEETINGS, name), "utf8");
  const response = await app.request("/meetings", { method: "POST", headers: AUTH, body });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
  pushFiles(fixture, {
    ".2brain/config.yaml": config(),
    "people/Ana Ruiz.md": "---\ntype: person\n---\nAna Ruiz.\n",
  });
  llm = (await import("../src/llm/index.js")) as unknown as MockedLlm;
  llm.provider.calls.length = 0;
});

afterEach(() => {
  fixture.cleanup();
});

/** Posts a fixture and checks every byte of the stored note against the reviewed expectation. */
async function expectByteExact(name: string, expectedName: string, expectedPath: string) {
  const expected = readFileSync(join(MEETINGS, expectedName));
  expect(expected.includes(0x0d), "expected file must be LF only").toBe(false);

  const result = await post(makeApp(), name);
  expect(result.status).toBe(201);
  expect(Object.keys(result.json).sort()).toEqual(["commit", "ok", "path"]);
  expect(result.json.path).toBe(expectedPath);
  expect(result.json.commit).toBe(git(fixture.remote, ["rev-parse", "main"]));

  const actual = readFileSync(join(fixture.vaultDir, expectedPath));
  expect(actual.toString("utf8")).toBe(expected.toString("utf8"));
  expect(actual.equals(expected)).toBe(true);
  expect(gitRaw(fixture.remote, ["show", `main:${expectedPath}`])).toBe(expected.toString("utf8"));
  return actual.toString("utf8");
}

describe("recorded fixtures are stored byte for byte", () => {
  it("R2.6: fireflies byte exact", async () => {
    await expectByteExact(
      "fireflies-recorded.json",
      "fireflies-recorded.expected.md",
      FIREFLIES_PATH,
    );
  });

  it("R2.7: gemini byte exact, speakers are display names", async () => {
    const text = await expectByteExact(
      "gemini-recorded.json",
      "gemini-recorded.expected.md",
      GEMINI_PATH,
    );
    expect(text).not.toContain("participants/");
    const body = JSON.parse(readFileSync(join(MEETINGS, "gemini-recorded.json"), "utf8")) as {
      participants: Record<string, { displayName: string } | string>[];
    };
    const names = body.participants.map((p) => {
      const user = p.signedinUser ?? p.anonymousUser ?? p.phoneUser;
      return (user as { displayName: string }).displayName;
    });
    expect(names).toHaveLength(3);
    for (const name of names) expect(text).toContain(`**${name}** [`);
  });
});

describe("R9.2: the meeting flow makes zero LLM calls", () => {
  it("both fixtures are stored and the provider records no call", async () => {
    const app = makeApp();
    const first = await post(app, "fireflies-recorded.json");
    const second = await post(app, "gemini-recorded.json");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const files = gitRaw(fixture.remote, [
      "-c",
      "core.quotepath=false",
      "ls-tree",
      "-r",
      "--name-only",
      "main",
    ]);
    expect(files).toContain(String(first.json.path));
    expect(files).toContain(String(second.json.path));
    expect(llm.provider.calls).toEqual([]);
  });

  it("control: the mock is live and records a call that reaches it", async () => {
    await expect(
      llm.completeStructured(llm.provider, { prompt: "x" }, z.unknown()),
    ).rejects.toThrow("Mock provider has no response left");
    expect(llm.provider.calls).toHaveLength(1);
  });
});
