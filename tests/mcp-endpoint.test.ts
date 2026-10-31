import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { type AuthStore, newId, openAuthStore } from "../src/auth/oauth/store.js";
import { createPublicApp } from "../src/mcp/app.js";
import {
  createMcpServer,
  MCP_MAX_BODY_BYTES,
  MCP_TOOLS,
  type McpServerDeps,
  type McpToolDefinition,
} from "../src/mcp/server.js";

const ISSUER = "https://brain.example.com";
const RESOURCE = `${ISSUER}/mcp`;
const CHALLENGE = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`;
const INVALID = `${CHALLENGE}, error="invalid_token"`;
const HOUR = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00Z");

const roots: string[] = [];
const stores: AuthStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const deps: McpServerDeps = {
  writer: { write: async () => ({ path: "x.md", commit: "abc" }) },
  config: { vaultDir: "/nonexistent-vault" },
};

interface Opts {
  withMcp?: boolean;
  deadlineMs?: number;
  tools?: readonly McpToolDefinition[];
}

async function harness(opts: Opts = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-mcp-")));
  roots.push(root);
  mkdirSync(join(root, "vault"));
  const wall = { t: START };
  const wallNow = () => new Date(wall.t);
  const real = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    now: wallNow,
    log: () => undefined,
  });
  stores.push(real);
  const lookups = { n: 0 };
  const store: AuthStore = {
    ...real,
    findGrantByAccessToken: (token, now) => {
      lookups.n += 1;
      return real.findGrantByAccessToken(token, now);
    },
  };
  const logs: string[] = [];
  const { app } = createPublicApp({
    baseUrl: ISSUER,
    log: (l) => logs.push(l),
    mcp: opts.withMcp === false ? undefined : deps,
    mcpSeams: { deadlineMs: opts.deadlineMs, tools: opts.tools },
    auth: {
      store,
      allowedRedirectHosts: ["claude.ai", "assistant.example.org"],
      trustProxyHops: 1,
      ownerPassphraseHash: "stored-hash",
      tokenNow: wallNow,
    },
  });
  const clientId = newId();
  await store.update((tx) =>
    tx.putClient(clientId, {
      authMethod: "none",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    }),
  );
  /** Seeds a grant; returns its raw tokens. */
  async function grant(over: { resource?: string; accessMs?: number } = {}) {
    const accessToken = newId();
    const refreshToken = newId();
    const id = newId();
    await store.update((tx) =>
      tx.putGrant(id, {
        clientId,
        resource: over.resource ?? RESOURCE,
        accessToken,
        accessExpiresAt: new Date(wall.t + (over.accessMs ?? HOUR)),
        refreshToken,
        refreshExpiresAt: new Date(wall.t + 30 * 24 * HOUR),
      }),
    );
    return { id, accessToken, refreshToken };
  }
  return { app, store, wall, logs, grant, lookups };
}
type H = Awaited<ReturnType<typeof harness>>;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};

interface Send {
  method?: string;
  token?: string;
  authorization?: string;
  origin?: string;
  body?: string | ReadableStream<Uint8Array>;
  json?: unknown;
  headers?: Record<string, string>;
}

function call(h: H, send: Send = {}) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(send.headers ?? {}),
  };
  if (send.token !== undefined) headers.authorization = `Bearer ${send.token}`;
  if (send.authorization !== undefined) headers.authorization = send.authorization;
  if (send.origin !== undefined) headers.origin = send.origin;
  const method = send.method ?? "POST";
  const body =
    method === "GET" || method === "DELETE"
      ? undefined
      : (send.body ?? JSON.stringify(send.json ?? INIT));
  const init: RequestInit & { duplex: "half" } = { method, headers, body, duplex: "half" };
  return h.app.request("http://internal/mcp", init);
}

const headerDump = (res: Response) => JSON.stringify([...res.headers.entries()]);

describe("R2.1: no usable Bearer credentials", () => {
  const cases: Array<[string, string | undefined]> = [
    ["no header", undefined],
    ["a Basic scheme", "Basic abc"],
    ["no space after the scheme", "Bearerabc"],
  ];
  for (const [name, authorization] of cases) {
    it(`${name}: 401 with the bare challenge`, async () => {
      const h = await harness();
      const res = await call(h, { authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(res.headers.get("www-authenticate")).not.toContain("error=");
      expect(await res.text()).toBe('{"error":"unauthorized"}');
    });
  }
});

describe("R6.2: tokens that are not live for this resource", () => {
  async function expectInvalid(h: H, send: Send) {
    const res = await call(h, send);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(INVALID);
    expect(await res.text()).toBe('{"error":"invalid_token"}');
  }

  it("expired", async () => {
    const h = await harness();
    const g = await h.grant();
    h.wall.t += HOUR + 1;
    await expectInvalid(h, { token: g.accessToken });
  });
  it("live until the last millisecond, expired from the next", async () => {
    const h = await harness();
    const g = await h.grant();
    h.wall.t += HOUR - 1;
    expect((await call(h, { token: g.accessToken })).status).toBe(200);
    h.wall.t += 2;
    await expectInvalid(h, { token: g.accessToken });
  });
  it("revoked", async () => {
    const h = await harness();
    const g = await h.grant();
    await h.store.update((tx) => tx.revokeGrant(g.id));
    await expectInvalid(h, { token: g.accessToken });
  });
  it("unknown", async () => {
    const h = await harness();
    await expectInvalid(h, { token: newId() });
  });
  it("wrong audience of the same length", async () => {
    const h = await harness();
    const g = await h.grant({ resource: "https://brain.example.org/mcp" });
    expect("https://brain.example.org/mcp".length).toBe(RESOURCE.length);
    await expectInvalid(h, { token: g.accessToken });
  });
  it("audience with a trailing slash", async () => {
    const h = await harness();
    const g = await h.grant({ resource: `${RESOURCE}/` });
    await expectInvalid(h, { token: g.accessToken });
  });
  it("a refresh token presented as Bearer", async () => {
    const h = await harness();
    const g = await h.grant();
    await expectInvalid(h, { token: g.refreshToken });
  });
  it("a grant id presented as Bearer", async () => {
    const h = await harness();
    const g = await h.grant();
    await expectInvalid(h, { token: g.id });
  });
  it("Bearer alone", async () => {
    const h = await harness();
    await expectInvalid(h, { authorization: "Bearer " });
    await expectInvalid(h, { authorization: "Bearer    " });
  });
  it("a 513-character token, without a lookup", async () => {
    const h = await harness();
    await expectInvalid(h, { token: "a".repeat(513) });
    expect(h.lookups.n).toBe(0);
  });
  it("a token with a comma, without a lookup", async () => {
    const h = await harness();
    await expectInvalid(h, { authorization: "Bearer abc,def" });
    expect(h.lookups.n).toBe(0);
  });
});

describe("live tokens", () => {
  it("passes with Bearer in any letter case", async () => {
    const h = await harness();
    const g = await h.grant();
    expect((await call(h, { token: g.accessToken })).status).toBe(200);
    expect((await call(h, { authorization: `bearer ${g.accessToken}` })).status).toBe(200);
    expect((await call(h, { authorization: `BEARER  ${g.accessToken}` })).status).toBe(200);
  });
  it("passes in the first millisecond of the window", async () => {
    const h = await harness();
    const g = await h.grant({ accessMs: 1 });
    expect((await call(h, { token: g.accessToken })).status).toBe(200);
  });
});

describe("R6.3: Origin", () => {
  const bad = [
    "https://evil.example.net",
    "http://claude.ai",
    "null",
    "https://claude.ai:443",
    "https://sub.claude.ai",
    "https://claude.ai.evil.example.net",
    "https://chatgpt.com",
    "http://127.0.0.1:6274",
    "https://CLAUDE.ai",
  ];
  for (const origin of bad) {
    it(`403 for ${origin} even with a valid token, before any lookup`, async () => {
      const h = await harness();
      const g = await h.grant();
      const res = await call(h, { token: g.accessToken, origin });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('{"error":"forbidden_origin"}');
      expect(h.lookups.n).toBe(0);
    });
  }
  it("403, not 401, for a foreign origin without a token", async () => {
    const h = await harness();
    expect((await call(h, { origin: "https://evil.example.net" })).status).toBe(403);
  });
  for (const origin of [
    "https://claude.ai",
    "https://assistant.example.org",
    "https://brain.example.com",
    undefined,
  ]) {
    it(`passes ${origin ?? "no Origin"} with a valid token`, async () => {
      const h = await harness();
      const g = await h.grant();
      expect((await call(h, { token: g.accessToken, origin })).status).toBe(200);
    });
  }
});

describe("D1: fixed answers, nothing echoed, no-store", () => {
  it("never echoes a token or an Origin into a body, a header or a log", async () => {
    const h = await harness();
    const token = newId();
    const origin = "https://sentinel-origin.example.net";
    const g = await h.grant();
    h.wall.t += 2 * HOUR;
    const responses = [
      await call(h, { token, origin }),
      await call(h, { token }),
      await call(h, { token: g.accessToken }),
      await call(h, { authorization: `Basic ${token}` }),
    ];
    for (const res of responses) {
      const dump = headerDump(res) + (await res.text());
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(g.accessToken);
      expect(dump).not.toContain("sentinel-origin");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(h.logs.join("\n")).not.toContain(token);
    expect(h.logs.join("\n")).not.toContain("sentinel-origin");
  });

  it("no-store on 405, 413, 200 and on the SDK's own 202, 400, 406 and 415", async () => {
    const h = await harness();
    const g = await h.grant();
    const t = g.accessToken;
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    const answers: Array<[number, Response]> = [
      [405, await call(h, { token: t, method: "GET" })],
      [405, await call(h, { token: t, method: "DELETE" })],
      [413, await call(h, { token: t, body: "x".repeat(MCP_MAX_BODY_BYTES + 1) })],
      [200, await call(h, { token: t })],
      [202, await call(h, { token: t, json: notification })],
      [400, await call(h, { token: t, body: "{not json" })],
      [406, await call(h, { token: t, headers: { accept: "application/json" } })],
      [415, await call(h, { token: t, headers: { "content-type": "text/plain" } })],
      [
        400,
        await call(h, {
          token: t,
          json: { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernMeta() } },
        }),
      ],
    ];
    for (const [status, res] of answers) {
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control"), String(status)).toBe("no-store");
    }
  });
});

function modernMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
}

describe("modern-era claims", () => {
  it("get 400 -32022 with no data after authentication", async () => {
    const h = await harness();
    const g = await h.grant();
    const res = await call(h, {
      token: g.accessToken,
      headers: { "mcp-protocol-version": "2026-07-28" },
      json: { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernMeta() } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; data?: unknown } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toBeUndefined();
  });
  it("get 401, not -32022, without a token", async () => {
    const h = await harness();
    const res = await call(h, {
      headers: { "mcp-protocol-version": "2026-07-28" },
      json: { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernMeta() } },
    });
    expect(res.status).toBe(401);
  });
});

describe("D4: methods and body size", () => {
  it("GET and DELETE with a valid token answer 405 with Allow: POST and no stream", async () => {
    const h = await harness();
    const g = await h.grant();
    for (const method of ["GET", "DELETE"]) {
      const res = await call(h, { token: g.accessToken, method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("content-type")).not.toContain("event-stream");
    }
  });
  it("413 over the limit, and an exact-size body is not refused as too large", async () => {
    const h = await harness();
    const g = await h.grant();
    const over = await call(h, { token: g.accessToken, body: "x".repeat(MCP_MAX_BODY_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(await over.text()).toContain("Request body too large");
    const exact = await call(h, { token: g.accessToken, body: "x".repeat(MCP_MAX_BODY_BYTES) });
    expect(exact.status).not.toBe(413);
  });
  it("413 for an authenticated chunked body over the limit", async () => {
    const h = await harness();
    const g = await h.grant();
    const res = await call(h, { token: g.accessToken, body: chunked(MCP_MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
  });
  it("an unauthenticated chunked 3 MiB body gets 401 and is never read", async () => {
    const h = await harness();
    const pulled = { n: 0 };
    const res = await call(h, { body: chunked(3 * 1024 * 1024, pulled) });
    expect(res.status).toBe(401);
    // The Request constructor primes at most one chunk; reading 3 MiB would take 48.
    expect(pulled.n).toBeLessThanOrEqual(1);
  });
});

function chunked(total: number, pulled = { n: 0 }): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.n += 1;
      const size = Math.min(64 * 1024, total - sent);
      if (size <= 0) {
        controller.close();
        return;
      }
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(120));
    },
  });
}

describe("without the mcp option", () => {
  it("POST /mcp answers 404", async () => {
    const h = await harness({ withMcp: false });
    const g = await h.grant();
    expect((await call(h, { token: g.accessToken })).status).toBe(404);
  });
});

describe("R6.1: the SDK client through the endpoint", () => {
  function connectVia(h: H, token: string, negotiation?: "auto") {
    const seen: Response[] = [];
    const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const res = await h.app.request(request);
      seen.push(res.clone());
      return res;
    };
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      fetch: fetchLike,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "test-client", version: "1" },
      negotiation === undefined ? undefined : { versionNegotiation: { mode: negotiation } },
    );
    return { client, transport, seen };
  }

  it("connects, lists the registry's tools, and gets JSON with no session id", async () => {
    const h = await harness();
    const g = await h.grant();
    const { client, transport, seen } = connectVia(h, g.accessToken);
    await client.connect(transport);
    const listed = await client.listTools();
    await client.close();
    expect(listed.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    const posts = seen.filter((r) => r.status !== 405);
    expect(posts.length).toBeGreaterThan(1);
    for (const res of posts) {
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const type = res.headers.get("content-type") ?? "";
      expect(type).not.toContain("text/event-stream");
      if (res.status !== 202) expect(type).toContain("application/json");
    }
  });

  it("falls back from the modern probe in auto mode", async () => {
    const h = await harness();
    const g = await h.grant();
    const { client, transport } = connectVia(h, g.accessToken, "auto");
    await client.connect(transport);
    expect(Array.isArray((await client.listTools()).tools)).toBe(true);
    await client.close();
  });

  it("fails to connect with a bad token", async () => {
    const h = await harness();
    const { client, transport } = connectVia(h, newId());
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

describe("the request deadline", () => {
  it("answers a fixed 503 with no-store, and the next request still works", async () => {
    const hang: McpToolDefinition = {
      name: "hang",
      register(server) {
        server.registerTool("hang", { description: "never answers" }, () => new Promise(() => {}));
      },
    };
    const h = await harness({ deadlineMs: 100, tools: [hang] });
    const g = await h.grant();
    const call1 = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "hang" } };
    const res = await call(h, { token: g.accessToken, json: call1 });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Request timed out");
    expect((await call(h, { token: g.accessToken })).status).toBe(200);
  });
});

describe("what a tool sees", () => {
  it("authInfo.token is the grant id, never the bearer value", async () => {
    const seen: Array<{ token?: string; clientId?: string; resource?: string }> = [];
    const spy: McpToolDefinition = {
      name: "spy",
      register(server) {
        server.registerTool("spy", { description: "records authInfo" }, (ctx) => {
          const info = (ctx as unknown as { http?: { authInfo?: AuthInfo } }).http?.authInfo;
          seen.push({
            token: info?.token,
            clientId: info?.clientId,
            resource: info?.resource?.href,
          });
          return { content: [{ type: "text", text: "ok" }] };
        });
      },
    };
    const h = await harness({ tools: [spy] });
    const g = await h.grant();
    const res = await call(h, {
      token: g.accessToken,
      json: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "spy", arguments: {} } },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.token).toBe(g.id);
    expect(seen[0]?.token).not.toBe(g.accessToken);
    expect(seen[0]?.resource).toBe(RESOURCE);
  });
});

describe("D2: the tool registry", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(MCP_TOOLS)).toBe(true);
  });
  it("registers each tool once, with an McpServer and the same deps", () => {
    const calls: Array<[McpServer, McpServerDeps]> = [];
    const probe = {
      name: "probe",
      register: (s: McpServer, d: McpServerDeps) => calls.push([s, d]),
    };
    const server = createMcpServer(deps, [probe]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(server);
    expect(calls[0]?.[1]).toBe(deps);
  });
});
