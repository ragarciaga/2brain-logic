import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone } from "../src/git/index.js";
import { createMcpServer, MCP_TOOLS } from "../src/mcp/server.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";

const RESOURCE = "https://brain.example.com/mcp";

let fixture: GitFixture;
const clients: Client[] = [];

beforeEach(async () => {
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  fixture.cleanup();
});

async function connect() {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: defaultGit,
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  const deps = { writer, config: { vaultDir: fixture.vaultDir } };
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init);
    if (incoming.method !== "POST") return new Response(null, { status: 405 });
    const text = await incoming.text();
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const server = createMcpServer(deps, MCP_TOOLS);
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
  return client;
}

const CONFIG = [
  "areas: [alpha, beta]",
  "properties:",
  "  type: kind",
  "  area: realm",
  "  date: when",
  "  source: origin",
  "  source_id: origin_id",
  "types:",
  '  note: { value: memo, folder: "{area}/notes" }',
  "  log: { value: entry }",
  "vault:",
  "  archive_folder: old",
  "",
].join("\n");

describe("vault_info over the SDK client", () => {
  it("R10.1: lists seven tools and returns a config pushed from another clone", async () => {
    const other = fixture.cloneElsewhere("info-seed");
    mkdirSync(dirname(join(other, ".2brain/config.yaml")), { recursive: true });
    writeFileSync(join(other, ".2brain/config.yaml"), CONFIG);
    git(other, ["add", ".2brain/config.yaml"]);
    git(other, ["commit", "-m", "config"]);
    git(other, ["push", "origin", "main"]);

    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "search",
      "read",
      "recent",
      "save_note",
      "save_recipe",
      "update_properties",
      "vault_info",
    ]);
    const res = (await client.callTool({ name: "vault_info", arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toEqual({
      ok: true,
      areas: ["alpha", "beta"],
      properties: {
        type: "kind",
        area: "realm",
        date: "when",
        source: "origin",
        source_id: "origin_id",
      },
      types: [
        { key: "note", value: "memo", folder: "{area}/notes" },
        { key: "log", value: "entry", folder: null },
      ],
      archive_folder: "old",
    });
  });
});
