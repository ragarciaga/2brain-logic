import { describe, expect, it, vi } from "vitest";
import { CONFIG_FILE, ConfigInvalidError } from "../src/config/vault-config.js";
import { GitError } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import type { NoteArchive, NoteInput, NotePatch } from "../src/vault/note-schema.js";
import {
  AlreadyArchivedError,
  ArchiveTargetExistsError,
  ImmutableBodyError,
  NoteNotFoundError,
} from "../src/vault/operations.js";
import { SourceIndexLimitError } from "../src/vault/source-index.js";
import {
  DuplicateSourceError,
  InvalidFrontmatterError,
  NoteExistsError,
  type NoteWriter,
  PushPendingError,
  ScrubFailedError,
  UnsafePathError,
  WrongFolderError,
} from "../src/vault/write-note.js";

const TOKEN = "fictional-app-token-0123456789-abcdefghijk";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function setup(
  write?: NoteWriter["write"],
  patch?: NoteWriter["patch"],
  archive?: NoteWriter["archive"],
) {
  const writer = {
    write: vi.fn(write ?? (async (note: NoteInput) => ({ path: note.path, commit: "abc123" }))),
    patch: vi.fn(patch ?? (async (input: NotePatch) => ({ path: input.path, commit: "def456" }))),
    archive: vi.fn(
      archive ??
        (async (input: NoteArchive) => ({ path: `archive/${input.path}`, commit: "ghi789" })),
    ),
  };
  const logs: string[] = [];
  const app = createApp({ writer, ingestToken: TOKEN, log: (message) => logs.push(message) });
  return { app, writer, logs };
}

const valid = { path: "Inbox/idea.md", frontmatter: { title: "Idea" }, body: "text\n" };

function post(
  app: ReturnType<typeof setup>["app"],
  body: string,
  headers?: Record<string, string>,
) {
  return app.request("/notes", {
    method: "POST",
    body,
    headers: { ...AUTH, ...(headers ?? { "content-type": "application/json" }) },
  });
}

describe("GET /health", () => {
  it("returns 200 { ok: true }", async () => {
    const { app } = setup();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("POST /notes", () => {
  it("returns 201 with path and commit for a valid body", async () => {
    const { app, writer } = setup();
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, path: "Inbox/idea.md", commit: "abc123" });
    expect(writer.write).toHaveBeenCalledWith(valid);
  });

  const malformed: Array<[string, string]> = [
    ["non-JSON text", "this is not json"],
    ["missing body", JSON.stringify({ path: "a.md", frontmatter: {} })],
    ["frontmatter not an object", JSON.stringify({ ...valid, frontmatter: "x" })],
    ["frontmatter an array", JSON.stringify({ ...valid, frontmatter: ["x"] })],
    ["a .. segment", JSON.stringify({ ...valid, path: "a/../b.md" })],
    ["a leading ..", JSON.stringify({ ...valid, path: "../b.md" })],
    ["an absolute path", JSON.stringify({ ...valid, path: "/etc/x.md" })],
    ["a drive letter", JSON.stringify({ ...valid, path: "C:/x.md" })],
    ["a backslash", JSON.stringify({ ...valid, path: "a\\b.md" })],
    ["not .md", JSON.stringify({ ...valid, path: "a/b.txt" })],
    ["a .git segment", JSON.stringify({ ...valid, path: ".git/x.md" })],
    ["a nested dot segment", JSON.stringify({ ...valid, path: "a/.obsidian/x.md" })],
    ["an empty segment", JSON.stringify({ ...valid, path: "a//b.md" })],
    ["a NUL in the path", JSON.stringify({ ...valid, path: "a\u0000b.md" })],
    ["a control character in the path", JSON.stringify({ ...valid, path: "a\nb.md" })],
    ["a leading colon", JSON.stringify({ ...valid, path: ":(top)x.md" })],
    ["a Windows-unsafe character", JSON.stringify({ ...valid, path: "a/b?c.md" })],
    ["a directory ending in a dot", JSON.stringify({ ...valid, path: "notes./x.md" })],
    ["a directory ending in a space", JSON.stringify({ ...valid, path: "notes /x.md" })],
    ["a reserved device name", JSON.stringify({ ...valid, path: "Notes/NUL.md" })],
    ["a NUL in the body", JSON.stringify({ ...valid, body: "a\u0000b" })],
  ];

  it.each(malformed)("returns 400 and never calls the writer for %s", async (_name, raw) => {
    const { app, writer } = setup();
    const response = await post(app, raw);
    expect(response.status).toBe(400);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("reports invalid_json for non-JSON text and invalid_body with issues otherwise", async () => {
    const { app } = setup();
    expect(await (await post(app, "nope")).json()).toMatchObject({ error: "invalid_json" });
    const response = await post(app, JSON.stringify({ path: "a.md", frontmatter: {} }));
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    expect(body).toMatchObject({ error: "invalid_body" });
    expect(body.issues[0]).toHaveProperty("path", "body");
  });

  it("returns 415 and never calls the writer for text/plain", async () => {
    const { app, writer } = setup();
    const response = await post(app, JSON.stringify(valid), { "content-type": "text/plain" });
    expect(response.status).toBe(415);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("returns 415 and never calls the writer when the request has no content-type header", async () => {
    const { app, writer } = setup();
    // A string body would get an automatic text/plain type; a byte body gets none.
    const request = new Request("http://localhost/notes", {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify(valid)),
      headers: AUTH,
    });
    request.headers.delete("content-type");
    expect(request.headers.get("content-type")).toBeNull();
    const response = await app.request(request);
    expect(response.status).toBe(415);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("accepts application/json with a charset", async () => {
    const { app, writer } = setup();
    const response = await post(app, JSON.stringify(valid), {
      "content-type": "Application/JSON; charset=utf-8",
    });
    expect(response.status).toBe(201);
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it("returns 413 for a body over 1 MB", async () => {
    const { app, writer } = setup();
    const response = await post(app, JSON.stringify({ ...valid, body: "x".repeat(1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("returns 401, not 413, for an oversized body without a token", async () => {
    const { app, writer } = setup();
    const response = await app.request("/notes", {
      method: "POST",
      body: JSON.stringify({ ...valid, body: "x".repeat(1024 * 1024) }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("R1.4: a rejected request leaks neither the header value nor the real token", async () => {
    const marker = "HEADERMARKER";
    const { app, logs } = setup(async () => {
      throw new Error(TOKEN);
    });
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const response = await post(app, JSON.stringify(valid), {
      "content-type": "application/json",
      authorization: `Bearer ${marker}`,
    });
    expect(response.status).toBe(401);
    const text = await response.text();
    for (const output of [text, ...logs, JSON.stringify(consoleSpies.map((s) => s.mock.calls))]) {
      expect(output).not.toContain(marker);
      expect(output).not.toContain(TOKEN);
    }
    vi.restoreAllMocks();
  });

  it("R1.4: a failing write with the correct token leaks the token nowhere", async () => {
    const { app, logs } = setup(async () => {
      throw new Error(`leak ${TOKEN}`);
    });
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(500);
    const text = await response.text();
    for (const output of [text, ...logs, JSON.stringify(consoleSpies.map((s) => s.mock.calls))]) {
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain("leak");
    }
    vi.restoreAllMocks();
  });

  it("returns 409 when the note exists", async () => {
    const { app } = setup(async () => {
      throw new NoteExistsError();
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "note_exists" });
  });

  it("returns 400 unsafe_path without a path in the response or the log", async () => {
    const { app, logs } = setup(async () => {
      throw new UnsafePathError();
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: "unsafe_path" });
    for (const output of [text, ...logs]) {
      expect(output).not.toContain("Inbox");
      expect(output).not.toContain("/");
    }
  });

  it("R3.1: returns 400 invalid_frontmatter with the owner names and logs only the code", async () => {
    const { app, logs } = setup(async () => {
      throw new InvalidFrontmatterError(["kind", "origin"], ["day"]);
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_frontmatter",
      missing: ["kind", "origin"],
      invalid: ["day"],
    });
    expect(logs).toEqual(["invalid_frontmatter rejected"]);
  });

  it("R3.4: returns 400 wrong_folder with the expected folder and logs only the code", async () => {
    const { app, logs } = setup(async () => {
      throw new WrongFolderError("work/meetings");
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "wrong_folder",
      expected: "work/meetings",
    });
    expect(logs).toEqual(["wrong_folder rejected"]);
  });

  it("D1: a request value never reaches a validation response or log", async () => {
    const request = JSON.stringify({
      ...valid,
      frontmatter: { type: "VALUEMARKER", title: "VALUEMARKER" },
    });
    for (const error of [
      new InvalidFrontmatterError(["type"], []),
      new WrongFolderError("inbox"),
    ]) {
      const { app, logs } = setup(async () => {
        throw error;
      });
      const response = await post(app, request);
      expect(response.status).toBe(400);
      for (const output of [await response.text(), ...logs]) {
        expect(output).not.toContain("VALUEMARKER");
      }
    }
  });

  it("returns 500 write_failed for a git error and logs only subcommand and exit code", async () => {
    const { app, logs } = setup(async () => {
      throw new GitError("push", 128);
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
    expect(logs).toEqual(["write_failed: git push exit 128"]);
  });

  it("returns 502 push_pending with the local commit and logs only the exit code", async () => {
    const { app, logs } = setup(async () => {
      throw new PushPendingError("Inbox/idea.md", "abc123", 128);
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "push_pending",
      path: "Inbox/idea.md",
      commit: "abc123",
    });
    expect(logs).toEqual(["push_pending: git push exit 128"]);
  });

  it("logs exit unknown for a push_pending without an exit code", async () => {
    const { app, logs } = setup(async () => {
      throw new PushPendingError("Inbox/idea.md", "abc123", null);
    });
    expect((await post(app, JSON.stringify(valid))).status).toBe(502);
    expect(logs).toEqual(["push_pending: git push exit unknown"]);
  });

  describe("T10: unchanged and duplicate source", () => {
    it("R5.1: an unchanged result gives 200 with the exact body and no log line", async () => {
      const { app, logs } = setup(async (note) => ({
        path: note.path,
        commit: null,
        unchanged: true as const,
      }));
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        path: "Inbox/idea.md",
        commit: null,
        unchanged: true,
      });
      expect(logs).toEqual([]);
    });

    it("R5.1: unchanged with redactions adds them to the body and logs the pairs", async () => {
      const redactions = [{ rule: "github_token", count: 2 }];
      const { app, logs } = setup(async (note) => ({
        path: note.path,
        commit: null,
        unchanged: true as const,
        redactions,
      }));
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        path: "Inbox/idea.md",
        commit: null,
        unchanged: true,
        redactions,
      });
      expect(logs).toEqual(["redacted: github_token=2"]);
    });

    it("R5.2: DuplicateSourceError gives 409 duplicate_source with the existing path", async () => {
      const { app, logs } = setup(async () => {
        throw new DuplicateSourceError("work/x.md");
      });
      const response = await post(app, JSON.stringify({ ...valid, path: "inbox/y.md" }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        error: "duplicate_source",
        path: "work/x.md",
      });
      expect(logs).toEqual(["duplicate_source rejected"]);
    });

    it("SourceIndexLimitError gives 500 write_failed and logs the limit", async () => {
      const { app, logs } = setup(async () => {
        throw new SourceIndexLimitError();
      });
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
      expect(logs).toEqual(["write_failed: source index limit"]);
    });
  });

  describe("secret scrub", () => {
    it("R4.3: a result with redactions adds them to the 201 body and logs rule=count pairs", async () => {
      const redactions = [
        { rule: "anthropic_key", count: 1 },
        { rule: "github_token", count: 2 },
      ];
      const { app, logs } = setup(async (note) => ({
        path: note.path,
        commit: "abc123",
        redactions,
      }));
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        ok: true,
        path: "Inbox/idea.md",
        commit: "abc123",
        redactions,
      });
      expect(logs).toEqual(["redacted: anthropic_key=1, github_token=2"]);
    });

    it("R4.3: a single redaction logs one pair", async () => {
      const { app, logs } = setup(async (note) => ({
        path: note.path,
        commit: "abc123",
        redactions: [{ rule: "github_token", count: 2 }],
      }));
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(201);
      expect(logs).toEqual(["redacted: github_token=2"]);
    });

    it("R4.3: an empty redactions list leaves no key and no log line", async () => {
      const { app, logs } = setup(async (note) => ({
        path: note.path,
        commit: "abc123",
        redactions: [],
      }));
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true, path: "Inbox/idea.md", commit: "abc123" });
      expect(logs).toEqual([]);
    });

    it("R4.3: a result without redactions leaves no key and no log line", async () => {
      const { app, logs } = setup();
      const response = await post(app, JSON.stringify(valid));
      expect(await response.json()).toEqual({ ok: true, path: "Inbox/idea.md", commit: "abc123" });
      expect(logs).toEqual([]);
    });

    it("R4.4: ScrubFailedError gives 500 scrub_failed and logs only that code", async () => {
      const { app, logs } = setup(async () => {
        throw new ScrubFailedError();
      });
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "scrub_failed" });
      expect(logs).toEqual(["scrub_failed"]);
    });
  });

  describe("config_invalid", () => {
    it("R2.3: returns 503 with only the file and the key path, and logs the same two facts", async () => {
      const { app, logs } = setup(async () => {
        throw new ConfigInvalidError(CONFIG_FILE, "vault.colour", "SNIPPETMARKER colour: blue");
      });
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: "config_invalid",
        file: ".2brain/config.yaml",
        keyPath: "vault.colour",
      });
      expect(text).not.toContain("SNIPPETMARKER");
      expect(logs).toEqual(["config_invalid: .2brain/config.yaml at vault.colour"]);
    });

    it("R2.3: an empty key path stays an empty string and the log line has no 'at'", async () => {
      const { app, logs } = setup(async () => {
        throw new ConfigInvalidError(CONFIG_FILE, "", "SNIPPETMARKER: [unclosed");
      });
      const response = await post(app, JSON.stringify(valid));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: "config_invalid",
        file: ".2brain/config.yaml",
        keyPath: "",
      });
      expect(text).not.toContain("SNIPPETMARKER");
      expect(logs).toEqual(["config_invalid: .2brain/config.yaml"]);
      expect(logs.join("\n")).not.toContain("SNIPPETMARKER");
    });
  });

  it("returns 500 without detail for an unexpected error", async () => {
    const { app, logs } = setup(async () => {
      throw new Error("token=SECRETMARKER");
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SECRETMARKER");
    expect(logs.join("\n")).not.toContain("SECRETMARKER");
  });
});

const validPatch = { path: "Inbox/idea.md", set: { status: "done" } };

function patchRequest(
  app: ReturnType<typeof setup>["app"],
  body: string,
  headers?: Record<string, string>,
) {
  return app.request("/notes", {
    method: "PATCH",
    body,
    headers: { ...AUTH, ...(headers ?? { "content-type": "application/json" }) },
  });
}

describe("PATCH /notes", () => {
  it("returns 200 with path and commit and passes the parsed input to patch", async () => {
    const { app, writer } = setup();
    const response = await patchRequest(app, JSON.stringify(validPatch));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "Inbox/idea.md", commit: "def456" });
    expect(writer.patch).toHaveBeenCalledWith(validPatch);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("returns 200 with unchanged: true and a null commit", async () => {
    const { app } = setup(undefined, async (input) => ({
      path: input.path,
      commit: null,
      unchanged: true,
    }));
    const response = await patchRequest(app, JSON.stringify(validPatch));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "Inbox/idea.md",
      commit: null,
      unchanged: true,
    });
  });

  it("passes redactions through with status 200 and logs rule and count only", async () => {
    const { app, logs } = setup(undefined, async (input) => ({
      path: input.path,
      commit: "def456",
      redactions: [{ rule: "github_token", count: 2 }],
    }));
    const response = await patchRequest(app, JSON.stringify(validPatch));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "Inbox/idea.md",
      commit: "def456",
      redactions: [{ rule: "github_token", count: 2 }],
    });
    expect(logs).toEqual(["redacted: github_token=2"]);
  });

  const failures: Array<[string, Error, number, Record<string, unknown>]> = [
    ["note_not_found", new NoteNotFoundError(), 404, { error: "note_not_found" }],
    [
      "push_pending",
      new PushPendingError("Inbox/idea.md", "c0ffee", 128),
      502,
      { error: "push_pending", path: "Inbox/idea.md", commit: "c0ffee" },
    ],
    [
      "config_invalid",
      new ConfigInvalidError(CONFIG_FILE, "types", "x"),
      503,
      { error: "config_invalid", file: CONFIG_FILE, keyPath: "types" },
    ],
    ["scrub_failed", new ScrubFailedError(), 500, { error: "scrub_failed" }],
    ["immutable_body", new ImmutableBodyError(), 409, { error: "immutable_body" }],
    ["unsafe_path", new UnsafePathError(), 400, { error: "unsafe_path" }],
    [
      "invalid_frontmatter",
      new InvalidFrontmatterError(["title"], ["date"]),
      400,
      { error: "invalid_frontmatter", missing: ["title"], invalid: ["date"] },
    ],
    [
      "wrong_folder",
      new WrongFolderError("people"),
      400,
      { error: "wrong_folder", expected: "people" },
    ],
    [
      "duplicate_source",
      new DuplicateSourceError("inbox/other.md"),
      409,
      { error: "duplicate_source", path: "inbox/other.md" },
    ],
    ["write_failed", new GitError("commit", 1), 500, { error: "write_failed" }],
  ];

  it.each(failures)(
    "maps %s from patch to its status and body",
    async (_name, error, status, body) => {
      const { app } = setup(undefined, async () => {
        throw error;
      });
      const response = await patchRequest(app, JSON.stringify(validPatch));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, ...body });
    },
  );

  it.each([
    ["set and append", { ...validPatch, append: "more" }],
    ["append only", { path: "Inbox/idea.md", append: "more" }],
    ["an empty append", { path: "Inbox/idea.md", append: "" }],
  ])("accepts %s and passes the parsed input to patch", async (_name, payload) => {
    const { app, writer } = setup();
    const response = await patchRequest(app, JSON.stringify(payload));
    expect(response.status).toBe(200);
    expect(writer.patch).toHaveBeenCalledWith(payload);
  });

  it("logs only the code for immutable_body", async () => {
    const { app, logs } = setup(undefined, async () => {
      throw new ImmutableBodyError();
    });
    await patchRequest(app, JSON.stringify(validPatch));
    expect(logs).toEqual(["immutable_body rejected"]);
  });

  it("logs only the code for note_not_found", async () => {
    const { app, logs } = setup(undefined, async () => {
      throw new NoteNotFoundError();
    });
    await patchRequest(app, JSON.stringify(validPatch));
    expect(logs).toEqual(["note_not_found"]);
  });

  const invalid: Array<[string, string]> = [
    ["neither set nor append", JSON.stringify({ path: "a.md" })],
    ["an append that is not a string", JSON.stringify({ path: "a.md", append: 5 })],
    ["an append with NUL", JSON.stringify({ path: "a.md", append: "a\u0000b" })],
    ["an empty set with an append", JSON.stringify({ path: "a.md", set: {}, append: "x" })],
    ["an empty set", JSON.stringify({ path: "a.md", set: {} })],
    ["a set of only __proto__", '{"path":"a.md","set":{"__proto__":{}}}'],
    ["a set that is an array", JSON.stringify({ path: "a.md", set: ["x"] })],
    ["a leading ..", JSON.stringify({ path: "../x.md", set: { a: 1 } })],
    ["a backslash", JSON.stringify({ path: "a\\b.md", set: { a: 1 } })],
    ["a leading colon", JSON.stringify({ path: ":x.md", set: { a: 1 } })],
    ["the .2brain folder", JSON.stringify({ path: ".2brain/x.md", set: { a: 1 } })],
    ["a frontmatter key from the create shape", JSON.stringify({ ...validPatch, frontmatter: {} })],
  ];

  it.each(invalid)("returns 400 invalid_body and never calls patch for %s", async (_name, raw) => {
    const { app, writer } = setup();
    const response = await patchRequest(app, raw);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_body" });
    expect(writer.patch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_json for text that is not JSON", async () => {
    const { app, writer } = setup();
    const response = await patchRequest(app, "nope");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
    expect(writer.patch).not.toHaveBeenCalled();
  });

  it("returns 415 for text/plain", async () => {
    const { app, writer } = setup();
    const response = await patchRequest(app, JSON.stringify(validPatch), {
      "content-type": "text/plain",
    });
    expect(response.status).toBe(415);
    expect(writer.patch).not.toHaveBeenCalled();
  });

  it("returns 415 when the request has no content-type header", async () => {
    const { app, writer } = setup();
    const request = new Request("http://localhost/notes", {
      method: "PATCH",
      body: new TextEncoder().encode(JSON.stringify(validPatch)),
      headers: AUTH,
    });
    request.headers.delete("content-type");
    expect(request.headers.get("content-type")).toBeNull();
    const response = await app.request(request);
    expect(response.status).toBe(415);
    expect(writer.patch).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over 1 MiB", async () => {
    const { app, writer } = setup();
    const response = await patchRequest(
      app,
      JSON.stringify({ path: "a.md", set: { big: "x".repeat(1024 * 1024) } }),
    );
    expect(response.status).toBe(413);
    expect(writer.patch).not.toHaveBeenCalled();
  });

  it("returns 401 without a token and never calls patch", async () => {
    const { app, writer } = setup();
    const response = await app.request("/notes", {
      method: "PATCH",
      body: JSON.stringify(validPatch),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(writer.patch).not.toHaveBeenCalled();
  });
});

describe("POST /notes/archive", () => {
  function archiveRequest(app: ReturnType<typeof setup>["app"], body: string, headers?: object) {
    return app.request("/notes/archive", {
      method: "POST",
      body,
      headers: { ...AUTH, "content-type": "application/json", ...headers },
    });
  }

  it("returns 200 with the new path and calls only archive", async () => {
    const { app, writer } = setup();
    const response = await archiveRequest(app, JSON.stringify({ path: "inbox/a.md" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "archive/inbox/a.md",
      commit: "ghi789",
    });
    expect(writer.archive).toHaveBeenCalledExactlyOnceWith({ path: "inbox/a.md" });
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.patch).not.toHaveBeenCalled();
  });

  const invalid: Array<[string, unknown]> = [
    ["no path", {}],
    ["a dot-dot path", { path: "../a.md" }],
    ["a non-md path", { path: "inbox/a.txt" }],
    ["an extra key", { path: "inbox/a.md", force: true }],
    ["a non-string path", { path: 3 }],
  ];
  it.each(invalid)(
    "returns 400 invalid_body for %s and never calls archive",
    async (_name, body) => {
      const { app, writer } = setup();
      const response = await archiveRequest(app, JSON.stringify(body));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("invalid_body");
      expect(writer.archive).not.toHaveBeenCalled();
    },
  );

  it("returns 415 for a wrong content type and 400 for invalid JSON", async () => {
    const { app, writer } = setup();
    const wrong = await archiveRequest(app, JSON.stringify({ path: "a.md" }), {
      "content-type": "text/plain",
    });
    expect(wrong.status).toBe(415);
    const broken = await archiveRequest(app, "{nope");
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ ok: false, error: "invalid_json" });
    expect(writer.archive).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const { app, writer } = setup();
    const response = await app.request("/notes/archive", {
      method: "POST",
      body: JSON.stringify({ path: "a.md" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(writer.archive).not.toHaveBeenCalled();
  });

  it("maps AlreadyArchivedError to 409 already_archived", async () => {
    const { app, logs } = setup(undefined, undefined, async () => {
      throw new AlreadyArchivedError();
    });
    const response = await archiveRequest(app, JSON.stringify({ path: "a.md" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "already_archived" });
    expect(logs).toEqual(["already_archived rejected"]);
  });

  it("maps ArchiveTargetExistsError to 409 archive_target_exists", async () => {
    const { app, logs } = setup(undefined, undefined, async () => {
      throw new ArchiveTargetExistsError();
    });
    const response = await archiveRequest(app, JSON.stringify({ path: "a.md" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "archive_target_exists" });
    expect(logs).toEqual(["archive_target_exists rejected"]);
  });

  it("maps NoteNotFoundError to 404, PushPendingError to 502, ConfigInvalidError to 503", async () => {
    const cases: Array<[Error, number, string]> = [
      [new NoteNotFoundError(), 404, "note_not_found"],
      [new PushPendingError("archive/a.md", "abc", 128), 502, "push_pending"],
      [new ConfigInvalidError(CONFIG_FILE, "vault.archive_folder", "bad"), 503, "config_invalid"],
      [new UnsafePathError(), 400, "unsafe_path"],
    ];
    for (const [error, status, code] of cases) {
      const { app } = setup(undefined, undefined, async () => {
        throw error;
      });
      const response = await archiveRequest(app, JSON.stringify({ path: "a.md" }));
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
  });

  it("has no delete route: DELETE answers 404 and no writer method runs", async () => {
    const { app, writer } = setup();
    for (const path of ["/notes", "/notes/archive"]) {
      const response = await app.request(path, { method: "DELETE", headers: AUTH });
      expect(response.status).toBe(404);
    }
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.patch).not.toHaveBeenCalled();
    expect(writer.archive).not.toHaveBeenCalled();
    const methods = app.routes.filter((r) => r.path !== "/*").map((r) => r.method);
    expect(methods).not.toContain("DELETE");
    expect(app.routes.filter((r) => r.method === "ALL").map((r) => r.path)).toEqual(["/*"]);
  });
});
