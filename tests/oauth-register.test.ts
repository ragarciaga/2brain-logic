import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_IDLE_EVICTION_MS, isAllowedRedirectUri } from "../src/auth/oauth/register.js";
import {
  AUTH_STORE_FILE,
  AUTH_STORE_LIMITS,
  type AuthStore,
  newId,
  openAuthStore,
  sha256Hex,
} from "../src/auth/oauth/store.js";
import { createPublicApp, PUBLIC_PATHS } from "../src/mcp/app.js";

// Documentation addresses only.
const IP_A = "203.0.113.10";
const IP_B = "198.51.100.7";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"];
const ERR_META = {
  error: "invalid_client_metadata",
  error_description: "The client metadata is invalid",
};
const ERR_REDIRECT = {
  error: "invalid_redirect_uri",
  error_description:
    "Every redirect URI must be https on an allowed host or http on a loopback host",
};

const roots: string[] = [];
const stores: AuthStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let clockMs = Date.parse("2026-10-31T12:00:00.000Z");
const now = (): Date => new Date(clockMs);

interface Harness {
  store: AuthStore;
  authFile: string;
  logs: string[];
  post(body: string | Uint8Array | null, options?: PostOptions): Promise<Response>;
  json(body: unknown, options?: PostOptions): Promise<Response>;
}
interface PostOptions {
  ip?: string;
  contentType?: string | null;
}

async function harness(hosts: readonly string[] = DEFAULT_HOSTS): Promise<Harness> {
  clockMs = Date.parse("2026-10-31T12:00:00.000Z");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-register-")));
  roots.push(root);
  mkdirSync(join(root, "vault"));
  const store = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    now,
    log: () => undefined,
  });
  stores.push(store);
  const logs: string[] = [];
  const { app } = createPublicApp({
    baseUrl: "https://brain.example.com",
    log: (line) => logs.push(line),
    auth: { store, allowedRedirectHosts: hosts, trustProxyHops: 0 },
  });
  const post = (body: string | Uint8Array | null, options: PostOptions = {}) => {
    const headers = new Headers();
    const type = options.contentType === undefined ? "application/json" : options.contentType;
    if (type !== null) headers.set("content-type", type);
    const init: RequestInit = { method: "POST", headers, body };
    return Promise.resolve(
      app.request(PUBLIC_PATHS.register, init, {
        incoming: { socket: { remoteAddress: options.ip ?? IP_A } },
      }),
    );
  };
  return {
    store,
    authFile: join(root, "auth", AUTH_STORE_FILE),
    logs,
    post,
    json: (body, options) => post(JSON.stringify(body), options),
  };
}

interface Registered {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  error?: string;
  error_description?: string;
}

async function read(res: Response): Promise<Registered> {
  return (await res.json()) as Registered;
}

const GOOD = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };

describe("POST /register: success (R3.1)", () => {
  it("stores a public client without a secret", async () => {
    const h = await harness();
    const res = await h.json({
      ...GOOD,
      token_endpoint_auth_method: "none",
      client_name: "Fictional",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await read(res);
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("client_secret_expires_at");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_name).toBe("Fictional");
    expect(body.client_id_issued_at).toBe(Math.floor(clockMs / 1000));
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    const stored = h.store.getClient(body.client_id);
    expect(stored?.secretHash).toBeUndefined();
    expect(stored?.name).toBe("Fictional");
  });

  it.each(["client_secret_post", "client_secret_basic", undefined])(
    "stores a confidential client with method %s and only the secret hash",
    async (method) => {
      const h = await harness();
      const res = await h.json({ ...GOOD, token_endpoint_auth_method: method });
      expect(res.status).toBe(201);
      const body = await read(res);
      const secret = body.client_secret as string;
      expect(body.token_endpoint_auth_method).toBe(method ?? "client_secret_basic");
      expect(body.client_secret).toHaveLength(43);
      expect(body.client_secret_expires_at).toBe(0);
      expect(h.store.getClient(body.client_id)?.secretHash).toBe(sha256Hex(secret));
      expect(h.store.verifyClientSecret(body.client_id, secret)).toBe(true);
      expect(readFileSync(h.authFile, "utf8")).not.toContain(secret);
    },
  );

  it("generates a different id and secret for every client", async () => {
    const h = await harness();
    const first = await read(await h.json(GOOD));
    const second = await read(await h.json(GOOD));
    expect(second.client_id).not.toBe(first.client_id);
    expect(second.client_secret).not.toBe(first.client_secret);
  });

  it("ignores unknown metadata and a __proto__ key", async () => {
    const h = await harness();
    const res = await h.post(
      `{"redirect_uris":["https://claude.ai/cb"],"logo_uri":"https://x.example.net/l.png","__proto__":{"authMethod":"none"}}`,
    );
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body).not.toHaveProperty("logo_uri");
    expect(h.store.getClient(body.client_id)?.authMethod).toBe("client_secret_basic");
  });

  it("echoes accepted grant and response types", async () => {
    const h = await harness();
    const res = await h.json({
      ...GOOD,
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect((await read(res)).grant_types).toEqual(["authorization_code"]);
  });
});

describe("redirect URI allowlist (R3.2)", () => {
  it.each([
    "http://127.0.0.1:51234/cb",
    "http://localhost:3118/cb",
    "http://[::1]:8080/cb",
    "http://localhost/cb",
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/api/mcp/auth_callback",
    "https://claude.ai/cb?x=1",
  ])("accepts %s", async (uri) => {
    const h = await harness();
    expect(isAllowedRedirectUri(uri, DEFAULT_HOSTS)).toBe(true);
    const res = await h.json({ redirect_uris: [uri] });
    expect(res.status).toBe(201);
    expect((await read(res)).redirect_uris).toEqual([uri]);
  });

  it("uses the configured list instead of the defaults", async () => {
    const h = await harness(["brain-client.example.com"]);
    expect((await h.json({ redirect_uris: ["https://brain-client.example.com/cb"] })).status).toBe(
      201,
    );
    const refused = await h.json({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(refused.status).toBe(400);
    expect(await read(refused)).toEqual(ERR_REDIRECT);
  });

  it.each([
    "https://claude.ai:8443/cb",
    "https://claude.ai:443/cb",
    "https://sub.claude.ai/cb",
    "https://user@claude.ai/cb",
    "https://claude.ai/cb#x",
    "https://claude.ai/cb#",
    "HTTPS://claude.ai/cb",
    "https://CLAUDE.ai/cb",
    "https://claude.ai./cb",
    "http://localhost.:5/cb",
    "http://[0:0:0:0:0:0:0:1]:5/cb",
    "http://[::ffff:127.0.0.1]:5/cb",
    "http://127.1:5/cb",
    "https:claude.ai/cb",
    "https://claude.ai\\@evil.example.net/",
    "https://claude.ai@evil.example.net/",
    "https://claude.ai/../x",
    "https://claude.ai/c b",
    "https://claude.ai/c\tb",
    "https://claude.ai",
    "https://evil.example.net/cb",
    "http://claude.ai/cb",
    "javascript:alert(1)",
    "not a url",
    "http://0.0.0.0:5/cb",
  ])("refuses %s", (uri) => {
    expect(isAllowedRedirectUri(uri, DEFAULT_HOSTS)).toBe(false);
  });
});

describe("refused redirect URIs store nothing (R3.3)", () => {
  it.each([
    ["an evil host", ["https://evil.example.net/cb"]],
    ["http on a non-loopback host", ["http://claude.ai/cb"]],
    ["javascript", ["javascript:alert(1)"]],
    ["one good and one bad", ["https://claude.ai/cb", "https://evil.example.net/cb"]],
  ])("%s", async (_name, uris) => {
    const h = await harness();
    const res = await h.json({ redirect_uris: uris });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await read(res)).toEqual(ERR_REDIRECT);
    expect(h.store.clientCount()).toBe(0);
  });
});

describe("invalid metadata (D2)", () => {
  const SENTINEL = "SENTINEL_VALUE_7731";
  const longUri = `https://claude.ai/${"a".repeat(AUTH_STORE_LIMITS.maxRedirectUriLength)}`;
  const cases: [string, () => Promise<{ h: Harness; res: Response }>][] = [];
  const add = (name: string, make: (h: Harness) => Promise<Response>) =>
    cases.push([
      name,
      async () => {
        const h = await harness();
        return { h, res: await make(h) };
      },
    ]);
  add("invalid JSON", (h) => h.post(`{"redirect_uris": ${SENTINEL}`));
  add("an array body", (h) => h.post("[]"));
  add("a null body", (h) => h.post("null"));
  add("a string body", (h) => h.post(`"${SENTINEL}"`));
  add("text/plain", (h) => h.json(GOOD, { contentType: "text/plain" }));
  add("no content type", (h) =>
    h.post(new TextEncoder().encode(JSON.stringify(GOOD)), { contentType: null }),
  );
  add("missing redirect_uris", (h) => h.json({ client_name: SENTINEL }));
  add("empty redirect_uris", (h) => h.json({ redirect_uris: [] }));
  add("an empty redirect URI", (h) => h.json({ redirect_uris: [""] }));
  add("redirect_uris not an array", (h) => h.json({ redirect_uris: SENTINEL }));
  add("unknown auth method", (h) =>
    h.json({ ...GOOD, token_endpoint_auth_method: "private_key_jwt" }),
  );
  add("implicit grant", (h) => h.json({ ...GOOD, grant_types: ["implicit"] }));
  add("token response type", (h) => h.json({ ...GOOD, response_types: ["token"] }));
  add("too many URIs", (h) =>
    h.json({
      redirect_uris: Array.from(
        { length: AUTH_STORE_LIMITS.maxRedirectUris + 1 },
        (_v, i) => `https://claude.ai/cb${i}`,
      ),
    }),
  );
  add("a too long URI", (h) => h.json({ redirect_uris: [longUri] }));
  add("a too long name", (h) =>
    h.json({ ...GOOD, client_name: "n".repeat(AUTH_STORE_LIMITS.maxNameLength + 1) }),
  );
  add("a control character in the name", (h) => h.json({ ...GOOD, client_name: "a\u0007b" }));
  add("a lone surrogate in the name", (h) => h.json({ ...GOOD, client_name: "\uD800" }));
  add("a bidi override in the name", (h) => h.json({ ...GOOD, client_name: "a‮b" }));
  add("a zero width space in the name", (h) => h.json({ ...GOOD, client_name: "a​b" }));
  add("a byte order mark in the name", (h) => h.json({ ...GOOD, client_name: "a﻿b" }));
  add("a line separator in the name", (h) => h.json({ ...GOOD, client_name: "a b" }));
  add("a NUL in a URI", (h) => h.json({ redirect_uris: ["https://claude.ai/a\u0000b"] }));
  add("a lone low surrogate in a URI", (h) =>
    h.json({ redirect_uris: ["https://claude.ai/a\uDC00b"] }),
  );
  add("a name that is not a string", (h) => h.json({ ...GOOD, client_name: 5 }));
  add("a body over 64 KiB", (h) => h.json({ ...GOOD, client_name: "x".repeat(70 * 1024) }));

  it.each(cases)("%s", async (_name, run) => {
    const { h, res } = await run();
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(ERR_META);
    expect(text).not.toContain(SENTINEL);
    expect(h.store.clientCount()).toBe(0);
  });
});

describe("client cap and eviction (R3.4, D1)", () => {
  async function seed(h: Harness, count: number, stepMs = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = newId();
      ids.push(id);
      await h.store.update((tx) =>
        tx.putClient(id, { authMethod: "none", redirectUris: ["https://claude.ai/cb"] }),
      );
      clockMs += stepMs;
    }
    return ids;
  }
  const ok = (h: Harness) => h.json(GOOD);

  it("registers the 50th client", async () => {
    const h = await harness();
    await seed(h, 49);
    expect((await ok(h)).status).toBe(201);
    expect(h.store.clientCount()).toBe(50);
  });

  it("refuses the 51st when nothing can be evicted, and logs it", async () => {
    const h = await harness();
    await seed(h, 50);
    const before = new Set(await ids(h));
    const res = await ok(h);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await read(res);
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toContain("50");
    expect(h.store.clientCount()).toBe(50);
    expect(new Set(await ids(h))).toEqual(before);
    expect(h.logs).toEqual(["register: client limit reached"]);
  });

  async function ids(h: Harness): Promise<string[]> {
    return Object.keys(JSON.parse(readFileSync(h.authFile, "utf8")).clients);
  }

  it("evicts the oldest grantless client older than 24 hours in the same write", async () => {
    const h = await harness();
    const seeded = await seed(h, 50, 1000);
    clockMs += DAY;
    const res = await ok(h);
    expect(res.status).toBe(201);
    const { client_id } = await read(res);
    expect(h.store.clientCount()).toBe(50);
    expect(h.store.getClient(seeded[0] as string)).toBeUndefined();
    for (const id of seeded.slice(1)) expect(h.store.getClient(id)).toBeDefined();
    expect(h.store.getClient(client_id)).toBeDefined();
    expect(h.logs).toEqual(["register: client evicted"]);
  });

  it("never evicts clients with a live or a revoked grant", async () => {
    const h = await harness();
    const seeded = await seed(h, 50, 1000);
    const grant = (clientId: string) => ({
      clientId,
      resource: "https://brain.example.com/mcp",
      accessToken: newId(),
      accessExpiresAt: new Date(clockMs + HOUR),
      refreshToken: newId(),
      refreshExpiresAt: new Date(clockMs + 90 * DAY),
    });
    const live = newId();
    const revoked = newId();
    await h.store.update((tx) => {
      tx.putGrant(live, grant(seeded[0] as string));
      tx.putGrant(revoked, grant(seeded[1] as string));
      tx.revokeGrant(revoked);
    });
    clockMs += DAY + 100_000;
    const res = await ok(h);
    expect(res.status).toBe(201);
    expect(h.store.getClient(seeded[0] as string)).toBeDefined();
    expect(h.store.getClient(seeded[1] as string)).toBeDefined();
    expect(h.store.getClient(seeded[2] as string)).toBeUndefined();
  });

  it("refuses when everything is exactly 24 hours old", async () => {
    const h = await harness();
    await seed(h, 50);
    clockMs += CLIENT_IDLE_EVICTION_MS;
    const res = await ok(h);
    expect(res.status).toBe(400);
    expect(h.store.clientCount()).toBe(50);
  });
});

describe("rate limit (R7.1, D3)", () => {
  it("answers 429 on the 11th request from one address and stores nothing for it", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i += 1) expect((await h.json(GOOD)).status).toBe(201);
    const res = await h.json(GOOD);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.store.clientCount()).toBe(10);
    expect((await h.json(GOOD, { ip: IP_B })).status).toBe(201);
  });

  it("counts invalid requests against the limit", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i += 1) expect((await h.post("{")).status).toBe(400);
    expect((await h.json(GOOD)).status).toBe(429);
    expect(h.store.clientCount()).toBe(0);
  });

  it("is not mounted without auth", async () => {
    const { app } = createPublicApp({ baseUrl: "https://brain.example.com" });
    const res = await app.request(PUBLIC_PATHS.register, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
