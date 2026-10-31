import { describe, expect, it, vi } from "vitest";
import { GitError } from "../src/git/index.js";
import { createApp } from "../src/server/app.js";
import type { NoteInput } from "../src/vault/note-schema.js";
import { NoteExistsError, type NoteWriter, UnsafePathError } from "../src/vault/write-note.js";

function setup(write?: NoteWriter["write"]) {
  const writer = {
    write: vi.fn(write ?? (async (note: NoteInput) => ({ path: note.path, commit: "abc123" }))),
  };
  const logs: string[] = [];
  const app = createApp({ writer, log: (message) => logs.push(message) });
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
    headers: headers ?? { "content-type": "application/json" },
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

  it.each([
    ["text/plain", { "content-type": "text/plain" }],
    ["no content-type", {}],
  ])("returns 415 and never calls the writer for %s", async (_name, headers) => {
    const { app, writer } = setup();
    const response = await app.request("/notes", {
      method: "POST",
      body: JSON.stringify(valid),
      headers,
    });
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

  it("returns 500 write_failed for a git error and logs only subcommand and exit code", async () => {
    const { app, logs } = setup(async () => {
      throw new GitError("push", 128);
    });
    const response = await post(app, JSON.stringify(valid));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "write_failed" });
    expect(logs).toEqual(["write_failed: git push exit 128"]);
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
