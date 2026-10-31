import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { CONFIG_FILE, ConfigInvalidError, type VaultConfig } from "../src/config/vault-config.js";
import { defaultGit, ensureClone, type GitApi, GitError } from "../src/git/index.js";
import { createMcpServer, MCP_TOOLS, type McpServerDeps } from "../src/mcp/server.js";
import { createReadTools } from "../src/mcp/tools/read.js";
import { buildRecipe, createWriteTools, slugify, WRITE_TOOLS } from "../src/mcp/tools/write.js";
import { mapWriteError } from "../src/server/errors.js";
import { parseNote } from "../src/vault/frontmatter.js";
import {
  createNoteWriter,
  DuplicateSourceError,
  InvalidFrontmatterError,
  NoteExistsError,
  PushPendingError,
  type Scrubber,
  ScrubFailedError,
  UnsafePathError,
  type VaultWriter,
  WrongFolderError,
} from "../src/vault/write-note.js";
import {
  createGitFixture,
  type GitFixture,
  git,
  gitRaw,
  TEST_AUTHOR,
} from "./helpers/git-fixture.js";

const RESOURCE = "https://brain.example.com/mcp";
// Close to UTC midnight: a local-time implementation would pick another day in most zones.
const NOW = new Date("2026-10-31T23:59:59Z");
// Built from parts at runtime: the CI secret scan reads every commit.
const ANT = ["sk", "ant", "api03", "A".repeat(24)].join("-");
const SENTINEL = "SENTINEL-do-not-leak-9137";

let fixture: GitFixture;
let logs: string[];
let counter = 0;
const clients: Client[] = [];
const extraDirs: string[] = [];

beforeEach(async () => {
  fixture = createGitFixture();
  logs = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  fixture.cleanup();
});

function makeWriter(overrides: Partial<GitApi> = {}, scrubber?: Scrubber): VaultWriter {
  return createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: { ...defaultGit, ...overrides },
    log: (m) => logs.push(m),
    sleep: () => Promise.resolve(),
    ...(scrubber ? { scrubber } : {}),
  });
}

interface Reply {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

/** An SDK client wired to a fresh server and transport per request, as the endpoint does. */
async function connect(writer: VaultWriter = makeWriter()) {
  const deps: McpServerDeps = { writer, config: { vaultDir: fixture.vaultDir } };
  const tools = [
    ...createReadTools({ now: () => NOW }),
    ...createWriteTools({ now: () => NOW, log: (m) => logs.push(m) }),
  ];
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init);
    if (incoming.method !== "POST") return new Response(null, { status: 405 });
    const text = await incoming.text();
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const server = createMcpServer(deps, tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(
        new Request(RESOURCE, { method: "POST", headers, body: text }),
        { parsedBody: JSON.parse(text) },
      );
      return new Response(await res.text(), { status: res.status, headers: res.headers });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
  const client = new Client({ name: "test-client", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch: fetchLike }));
  return {
    client,
    async call(name: string, args: Record<string, unknown>): Promise<Reply> {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.map((c) => c.text ?? "").join("\n");
      return { isError: res.isError === true, data: res.structuredContent ?? {}, text };
    },
  };
}

/** Commit `files` from a second clone and push. */
function push(files: Record<string, string>): void {
  counter += 1;
  const dir = fixture.cloneElsewhere(`seed-${counter}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
  git(dir, ["commit", "-m", `seed ${counter}`]);
  git(dir, ["push", "origin", "main"]);
}

const head = () => git(fixture.vaultDir, ["rev-parse", "HEAD"]);
const remoteHead = () => git(fixture.remote, ["rev-parse", "main"]);
const remoteFile = (path: string) => gitRaw(fixture.remote, ["show", `main:${path}`]);

const FM = { type: "idea", area: "personal", date: "2026-10-31", source: "manual" };
const noteArgs = (extra: Record<string, unknown> = {}, path = "inbox/a.md", body = "hello\n") => ({
  path,
  frontmatter: { ...FM, ...extra },
  body,
});

describe("save_note (R9.1)", () => {
  it("writes through the create path and returns path, commit, unchanged and redactions", async () => {
    const { call } = await connect();
    const before = remoteHead();
    const r = await call("save_note", noteArgs({ title: "Hello" }));
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      ok: true,
      path: "inbox/a.md",
      commit: head(),
      unchanged: false,
      redactions: [],
    });
    expect(remoteHead()).toBe(head());
    expect(head()).not.toBe(before);
    const stored = parseNote(remoteFile("inbox/a.md"));
    expect(stored.data).toEqual({ ...FM, title: "Hello" });
    expect(stored.content).toBe("hello\n");
    expect(JSON.parse(r.text)).toEqual(r.data);
  });

  it("a repeat is unchanged with a null commit and no new commit", async () => {
    const { call } = await connect();
    await call("save_note", noteArgs());
    const sha = head();
    const again = await call("save_note", noteArgs());
    expect(again.isError).toBe(false);
    expect(again.data).toEqual({
      ok: true,
      path: "inbox/a.md",
      commit: null,
      unchanged: true,
      redactions: [],
    });
    expect(head()).toBe(sha);
    expect(remoteHead()).toBe(sha);
  });

  it("redacts a secret in the body and in a frontmatter string, counts it and logs the count", async () => {
    const { call } = await connect();
    const r = await call("save_note", noteArgs({ title: `t ${ANT}` }, "inbox/s.md", `x ${ANT}\n`));
    expect(r.data.redactions).toEqual([{ rule: "anthropic_key", count: 2 }]);
    expect(r.text).not.toContain(ANT);
    const stored = remoteFile("inbox/s.md");
    expect(stored).not.toContain(ANT);
    expect(stored).toContain("[REDACTED:anthropic_key]");
    expect(logs).toContain("mcp save_note: redacted: anthropic_key=2");
    expect(logs.join("\n")).not.toContain(ANT);
  });

  describe("R9.4: every rejection has the ingest code and detail fields", () => {
    const leaky = (extra: Record<string, unknown> = {}, path = "inbox/leak.md") =>
      noteArgs({ leak_field: SENTINEL, ...extra }, path, `${SENTINEL} body\n`);

    async function expectRejected(
      reply: Reply,
      expected: Record<string, unknown>,
      logLine: string,
    ) {
      expect(reply.isError).toBe(true);
      expect(reply.data).toEqual(expected);
      expect(JSON.parse(reply.text)).toEqual(expected);
      expect(reply.text).not.toContain(SENTINEL);
      expect(logs.join("\n")).not.toContain(SENTINEL);
      expect(logs).toContain(logLine);
    }

    it("invalid_frontmatter", async () => {
      const { call } = await connect();
      const bad = leaky();
      delete (bad.frontmatter as Record<string, unknown>).area;
      const sha = head();
      await expectRejected(
        await call("save_note", bad),
        mapWriteError(new InvalidFrontmatterError(["area"], [])).body,
        "mcp save_note: invalid_frontmatter rejected",
      );
      expect(head()).toBe(sha);
    });

    it("wrong_folder", async () => {
      const { call } = await connect();
      await expectRejected(
        await call("save_note", leaky({}, "notes/leak.md")),
        mapWriteError(new WrongFolderError("inbox")).body,
        "mcp save_note: wrong_folder rejected",
      );
    });

    it("duplicate_source", async () => {
      const { call } = await connect();
      expect((await call("save_note", noteArgs({ source_id: "ff-1" }))).isError).toBe(false);
      await expectRejected(
        await call("save_note", leaky({ source_id: "ff-1" })),
        mapWriteError(new DuplicateSourceError("inbox/a.md")).body,
        "mcp save_note: duplicate_source rejected",
      );
    });

    it("note_exists (no ingest log line, so the code is logged)", async () => {
      const { call } = await connect();
      await call("save_note", noteArgs());
      const sha = head();
      await expectRejected(
        await call("save_note", leaky({}, "inbox/a.md")),
        mapWriteError(new NoteExistsError()).body,
        "mcp save_note: note_exists",
      );
      expect(head()).toBe(sha);
    });

    it.skipIf(process.platform === "win32")("unsafe_path for a symlinked folder", async () => {
      const outside = mkdtempSync(join(tmpdir(), "2brain-outside-"));
      extraDirs.push(outside);
      symlinkSync(outside, join(fixture.vaultDir, "inbox"));
      const { call } = await connect();
      await expectRejected(
        await call("save_note", leaky()),
        mapWriteError(new UnsafePathError()).body,
        "mcp save_note: unsafe_path rejected",
      );
      expect(existsSync(join(outside, "leak.md"))).toBe(false);
      expect(logs.join("\n")).not.toContain(outside);
    });

    it("config_invalid names only the file and key path", async () => {
      push({ [CONFIG_FILE]: `vault:\n  colour: ${SENTINEL}\n` });
      const { call } = await connect();
      await expectRejected(
        await call("save_note", leaky()),
        mapWriteError(new ConfigInvalidError(CONFIG_FILE, "vault.colour", "x")).body,
        "mcp save_note: config_invalid: .2brain/config.yaml at vault.colour",
      );
    });

    it("push_pending carries the path and the local head", async () => {
      const { call } = await connect(
        makeWriter({ push: () => Promise.reject(new GitError("push", 1)) }),
      );
      const reply = await call("save_note", leaky());
      await expectRejected(
        reply,
        mapWriteError(new PushPendingError("inbox/leak.md", head(), 1)).body,
        "mcp save_note: push_pending: git push exit 1",
      );
    });

    it("scrub_failed", async () => {
      const failing: Scrubber = {
        scrub: () => {
          throw new Error(SENTINEL);
        },
        scrubFrontmatter: () => {
          throw new Error(SENTINEL);
        },
      };
      const { call } = await connect(makeWriter({}, failing));
      await expectRejected(
        await call("save_note", leaky()),
        mapWriteError(new ScrubFailedError()).body,
        "mcp save_note: scrub_failed",
      );
    });

    it("an unknown writer exception is write_failed and its message never leaks", async () => {
      const writer = makeWriter();
      writer.write = async () => {
        throw new Error(`token=${SENTINEL}`);
      };
      const { call } = await connect(writer);
      await expectRejected(
        await call("save_note", leaky()),
        mapWriteError(new Error("x")).body,
        "mcp save_note: write_failed: unexpected error",
      );
    });

    it("a bug in the tool's own code is internal_error with no message", async () => {
      const writer = makeWriter();
      writer.write = async () => undefined as never;
      const { call } = await connect(writer);
      const r = await call("save_note", leaky());
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({ ok: false, error: "internal_error" });
      expect(logs).toContain("mcp save_note: internal_error");
    });

    it("invalid_body for a bad path lists where and why, never the value", async () => {
      const { call } = await connect();
      const r = await call("save_note", { ...leaky(), path: `inbox/${SENTINEL}.txt` });
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe("invalid_body");
      expect((r.data.issues as Array<{ path: string }>)[0]?.path).toBe("path");
      expect(r.text).not.toContain(SENTINEL);
      expect(logs.join("\n")).not.toContain(SENTINEL);
    });
  });

  it("D2: never writes under .2brain or any dot folder", async () => {
    const { call } = await connect();
    const sha = head();
    for (const path of [".2brain/x.md", ".obsidian/n.md", "inbox/.hidden/x.md"]) {
      const r = await call("save_note", noteArgs({}, path));
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe("invalid_body");
      expect(existsSync(join(fixture.vaultDir, path))).toBe(false);
    }
    expect(head()).toBe(sha);
  });

  it("a malformed argument is a tool error and nothing is written", async () => {
    const { call } = await connect();
    const sha = head();
    const r = await call("save_note", { path: "inbox/a.md", frontmatter: "no", body: "x" });
    expect(r.isError).toBe(true);
    expect(head()).toBe(sha);
  });
});

describe("slugify", () => {
  it.each([
    ["Fix: Flaky Test (CI)", "fix-flaky-test-ci"],
    ["Crème Brûlée", "creme-brulee"],
    ["  --Hello__World--  ", "hello-world"],
    ["!!!", ""],
    ["日本語", ""],
    [`${"a".repeat(79)} b`, "a".repeat(79)],
    ["a".repeat(120), "a".repeat(80)],
  ])("%s -> %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });
});

describe("buildRecipe", () => {
  const args = { title: "Dup", area: "work", problem: "p", solution: "s" };

  it("leaves out title when a mapped property is already called title", () => {
    const config: VaultConfig = {
      ...DEFAULT_VAULT_CONFIG,
      properties: { ...DEFAULT_VAULT_CONFIG.properties, date: "title" },
    };
    const built = buildRecipe(args, config, "2026-10-31");
    expect(built.ok && built.note.frontmatter).toEqual({
      type: "recipe",
      area: "work",
      title: "2026-10-31",
      source: "mcp",
    });
  });

  it("falls back to the inbox folder when the recipe type has no folder", () => {
    const config: VaultConfig = {
      ...DEFAULT_VAULT_CONFIG,
      types: { recipe: { value: "recipe" } },
    };
    const built = buildRecipe(args, config, "2026-10-31");
    expect(built.ok && built.note.path).toBe("inbox/dup.md");
  });
});

describe("save_recipe (R9.2)", () => {
  const recipe = (extra: Record<string, unknown> = {}) => ({
    title: "Fix: Flaky Test (CI)",
    area: "work",
    problem: "The test fails on CI.\n\n",
    solution: "Wait for the port.\n",
    ...extra,
  });

  it("builds a recipe note in the configured folder with today's UTC date and source mcp", async () => {
    const { call } = await connect();
    const r = await call("save_recipe", recipe());
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      ok: true,
      path: "recipes/fix-flaky-test-ci.md",
      commit: head(),
      unchanged: false,
      redactions: [],
    });
    const stored = parseNote(remoteFile("recipes/fix-flaky-test-ci.md"));
    expect(stored.data).toEqual({
      type: "recipe",
      area: "work",
      date: "2026-10-31",
      source: "mcp",
      title: "Fix: Flaky Test (CI)",
    });
    expect(stored.content).toBe(
      "## Problem\n\nThe test fails on CI.\n\n## Solution\n\nWait for the port.\n",
    );
  });

  it("keeps an explicit source and a repeat is unchanged", async () => {
    const { call } = await connect();
    await call("save_recipe", recipe({ source: "claude-code" }));
    expect(parseNote(remoteFile("recipes/fix-flaky-test-ci.md")).data.source).toBe("claude-code");
    const sha = head();
    const again = await call("save_recipe", recipe({ source: "claude-code" }));
    expect(again.data).toMatchObject({ ok: true, commit: null, unchanged: true });
    expect(head()).toBe(sha);
  });

  it("follows a non-default config: {area} folder and renamed properties", async () => {
    push({
      [CONFIG_FILE]: [
        "properties:",
        "  type: kind",
        "  area: zone",
        "  date: day",
        "  source: origin",
        "types:",
        "  recipe:",
        "    value: howto",
        '    folder: "{area}/howto"',
        "",
      ].join("\n"),
    });
    const { call } = await connect();
    const r = await call("save_recipe", recipe());
    expect(r.data).toMatchObject({ ok: true, path: "work/howto/fix-flaky-test-ci.md" });
    expect(parseNote(remoteFile("work/howto/fix-flaky-test-ci.md")).data).toEqual({
      kind: "howto",
      zone: "work",
      day: "2026-10-31",
      origin: "mcp",
      title: "Fix: Flaky Test (CI)",
    });
  });

  describe("D3: negatives write nothing", () => {
    it("an existing path is note_exists", async () => {
      const { call } = await connect();
      await call("save_recipe", recipe());
      const sha = head();
      const r = await call("save_recipe", recipe({ solution: "A different fix.\n" }));
      expect(r.isError).toBe(true);
      expect(r.data).toEqual(mapWriteError(new NoteExistsError()).body);
      expect(head()).toBe(sha);
    });

    it("an area outside the config is invalid_frontmatter on the area property", async () => {
      const { call } = await connect();
      const sha = head();
      const r = await call("save_recipe", recipe({ area: "nowhere" }));
      expect(r.isError).toBe(true);
      expect(r.data).toEqual(mapWriteError(new InvalidFrontmatterError([], ["area"])).body);
      expect(head()).toBe(sha);
    });

    it("an area outside the config is never used to build a folder from {area}", async () => {
      push({
        [CONFIG_FILE]: 'types:\n  recipe:\n    value: recipe\n    folder: "{area}/howto"\n',
      });
      const { call } = await connect();
      const r = await call("save_recipe", recipe({ area: "../nowhere" }));
      expect(r.isError).toBe(true);
      expect(r.data).toEqual(mapWriteError(new InvalidFrontmatterError([], ["area"])).body);
      expect(logs).toContain("mcp save_recipe: invalid_frontmatter rejected");
      expect(head()).toBe(remoteHead());
      expect(existsSync(join(fixture.vaultDir, "nowhere"))).toBe(false);
    });

    it.each(["!!!", "CON", "日本語"])("the title %s gives invalid_body on title", async (title) => {
      const { call } = await connect();
      const sha = head();
      const r = await call("save_recipe", recipe({ title }));
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({
        ok: false,
        error: "invalid_body",
        issues: [
          { path: "title", message: "title must contain letters or digits usable as a file name" },
        ],
      });
      expect(head()).toBe(sha);
    });

    it("a config without a recipe type is config_invalid at types.recipe", async () => {
      push({ [CONFIG_FILE]: "types:\n  idea:\n    value: idea\n    folder: inbox\n" });
      const { call } = await connect();
      const r = await call("save_recipe", recipe());
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({
        ok: false,
        error: "config_invalid",
        file: ".2brain/config.yaml",
        keyPath: "types.recipe",
      });
      expect(logs).toContain(
        "mcp save_recipe: config_invalid: .2brain/config.yaml at types.recipe",
      );
    });

    it("an empty problem is refused before anything is written", async () => {
      const { call } = await connect();
      const sha = head();
      const r = await call("save_recipe", recipe({ problem: "" }));
      expect(r.isError).toBe(true);
      expect(head()).toBe(sha);
    });
  });
});

describe("R9.5: the registry", () => {
  it("lists exactly search, read, recent, save_note and save_recipe", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([
      "search",
      "read",
      "recent",
      "save_note",
      "save_recipe",
    ]);
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(listed.tools.map((t) => t.name));
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual(["save_note", "save_recipe"]);
    for (const tool of listed.tools) {
      expect(tool.name).not.toMatch(/delete|move|archive|remove|rename/i);
    }
  });
});
