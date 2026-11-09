import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config/env.js";
import {
  createMcpServer,
  MCP_DEADLINE_MS,
  MCP_TOOLS,
  type McpServerDeps,
} from "../src/mcp/server.js";
import { createMeetingTools } from "../src/mcp/tools/meetings.js";
import {
  createMeetingsImporter,
  IMPORT_WAIT_MS,
  importDays,
  type MeetingsImporter,
} from "../src/meetings/import.js";
import type { VaultWriter } from "../src/vault/write-note.js";

const RESOURCE = "https://brain.example.com/mcp";
const URL_ = "http://n8n:5678/webhook/2brain-meetings-import";
const TOKEN = ["fictional", "import", "token", "0123456789", "abcdefghijk"].join("-");

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
});

/** A writer whose queue must never be taken by this tool (it would deadlock with n8n's posts). */
const writer = () =>
  ({
    withPulled: vi.fn(async () => {
      throw new Error("import_meetings must not take the writer queue");
    }),
  }) as unknown as VaultWriter;

async function call(deps: McpServerDeps, args: Record<string, unknown> = {}) {
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init);
    if (incoming.method !== "POST") return new Response(null, { status: 405 });
    const text = await incoming.text();
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const server = createMcpServer(deps, createMeetingTools());
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
  const result = await client.callTool({ name: "import_meetings", arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { text };
  }
  return { isError: result.isError === true, data };
}

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("meetings importer", () => {
  it("posts the clamped days with the bearer token and no redirects", async () => {
    const fetch = respond(200, { stored: ["bfa/reuniones/a.md"], skipped: 1 });
    const out = await createMeetingsImporter({ url: URL_, token: TOKEN, fetch }).run(30);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ days: 7 });
    expect(out).toEqual({
      ok: true,
      stored: ["bfa/reuniones/a.md"],
      already_stored: [],
      skipped: 1,
      failed: 0,
    });
  });

  it("drops unknown summary keys, so nothing but paths and counts reaches the client", async () => {
    const fetch = respond(200, { stored: [], transcript: "secret words", failed: 2 });
    const out = await createMeetingsImporter({ url: URL_, token: TOKEN, fetch }).run(1);
    expect(out).toEqual({ ok: true, stored: [], already_stored: [], skipped: 0, failed: 2 });
  });

  it("maps refusals, errors, bad bodies and timeouts to fixed outcomes", async () => {
    const run = (fetch: typeof globalThis.fetch, waitMs?: number) =>
      createMeetingsImporter({ url: URL_, token: TOKEN, fetch, ...(waitMs ? { waitMs } : {}) }).run(
        1,
      );
    expect(await run(respond(401, {}))).toEqual({ ok: false, error: "import_refused" });
    expect(await run(respond(500, {}))).toEqual({ ok: false, error: "import_failed" });
    expect(await run(respond(200, { stored: "nope" }))).toEqual({
      ok: false,
      error: "import_failed",
    });
    expect(await run(vi.fn(async () => Promise.reject(new TypeError("fetch failed"))))).toEqual({
      ok: false,
      error: "import_failed",
    });
    const hang = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    expect(await run(hang, 20)).toEqual({ ok: true, pending: true });
  });

  it("waits less than the MCP request deadline", () => {
    expect(IMPORT_WAIT_MS).toBeLessThan(MCP_DEADLINE_MS);
  });

  it("clamps days to 1..7", () => {
    expect([importDays(undefined), importDays(0), importDays(3.9), importDays(99)]).toEqual([
      1, 1, 3, 7,
    ]);
  });
});

describe("import_meetings tool", () => {
  it("is in the registry", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain("import_meetings");
  });

  it("answers import_not_configured without an importer", async () => {
    const reply = await call({ writer: writer(), config: { vaultDir: "/nonexistent" } });
    expect(reply).toEqual({ isError: true, data: { ok: false, error: "import_not_configured" } });
  });

  it("runs the importer with the days given, without the writer queue", async () => {
    const run = vi.fn<MeetingsImporter["run"]>(async () => ({
      ok: true as const,
      stored: ["bfa/reuniones/a.md"],
      already_stored: [],
      skipped: 0,
      failed: 0,
    }));
    const w = writer();
    const reply = await call(
      { writer: w, config: { vaultDir: "/x" }, meetingsImporter: { run } },
      { days: 3 },
    );
    expect(run).toHaveBeenCalledWith(3);
    expect(reply.isError).toBe(false);
    expect(reply.data.stored).toEqual(["bfa/reuniones/a.md"]);
    expect(w.withPulled).not.toHaveBeenCalled();
  });

  it("refuses days outside 1..7 before calling n8n", async () => {
    const run = vi.fn<MeetingsImporter["run"]>();
    const deps = { writer: writer(), config: { vaultDir: "/x" }, meetingsImporter: { run } };
    await expect(call(deps, { days: 8 })).resolves.toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("MEETINGS_IMPORT_URL", () => {
  const base = {
    VAULT_DIR: "/data/vault",
    GIT_AUTHOR_NAME: "2brain",
    GIT_AUTHOR_EMAIL: "brain@example.com",
    INGEST_TOKEN: TOKEN,
  };
  it("is optional and accepts an http URL", () => {
    expect(loadEnv(base).MEETINGS_IMPORT_URL).toBeUndefined();
    expect(loadEnv({ ...base, MEETINGS_IMPORT_URL: URL_ }).MEETINGS_IMPORT_URL).toBe(URL_);
  });
  it("refuses other schemes and URLs with credentials, naming only the variable", () => {
    expect(() => loadEnv({ ...base, MEETINGS_IMPORT_URL: "file:///etc/passwd" })).toThrow(
      /MEETINGS_IMPORT_URL/,
    );
    let message = "";
    try {
      loadEnv({ ...base, MEETINGS_IMPORT_URL: "http://user:hunter2pass@n8n:5678/x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/MEETINGS_IMPORT_URL/);
    expect(message).not.toContain("hunter2pass");
  });
});
