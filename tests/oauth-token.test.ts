import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CodeStore, createCodeStore } from "../src/auth/oauth/codes.js";
import { type AuthStore, newId, openAuthStore, sha256Hex } from "../src/auth/oauth/store.js";
import {
  parseBasicAuth,
  pkceS256Matches,
  TOKEN_ERROR_DESCRIPTIONS,
  TOKEN_LIFETIMES,
  TOKEN_MAX_BODY_BYTES,
} from "../src/auth/oauth/token.js";
import { createPublicApp } from "../src/mcp/app.js";

const ISSUER = "https://brain.example.com";
const RESOURCE = `${ISSUER}/mcp`;
const URI = "https://claude.ai/api/mcp/auth_callback";
const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");

const roots: string[] = [];
const stores: AuthStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Method = "none" | "client_secret_post" | "client_secret_basic";

interface Opts {
  io?: Parameters<typeof openAuthStore>[0]["io"];
  verify?: (p: string, s: string) => Promise<boolean>;
}

async function harness(opts: Opts = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-token-")));
  roots.push(root);
  mkdirSync(join(root, "vault"));
  const wall = { t: START };
  const mono = { t: 10_000 };
  const wallNow = () => new Date(wall.t);
  const store = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    now: wallNow,
    io: opts.io,
    log: () => undefined,
  });
  stores.push(store);
  const codes: CodeStore = createCodeStore({ now: () => mono.t });
  const logs: string[] = [];
  const { app } = createPublicApp({
    baseUrl: ISSUER,
    log: (l) => logs.push(l),
    auth: {
      store,
      allowedRedirectHosts: ["claude.ai"],
      trustProxyHops: 1,
      ownerPassphraseHash: "stored-hash",
      rateNow: () => mono.t,
      now: () => mono.t,
      tokenNow: wallNow,
      codes,
      verifyPassphrase: opts.verify ?? (async () => true),
    },
  });
  const clients = {} as Record<Method, { id: string; secret?: string }>;
  for (const method of ["none", "client_secret_post", "client_secret_basic"] as const) {
    const id = newId();
    const secret = method === "none" ? undefined : newId();
    clients[method] = { id, secret };
    await store.update((tx) =>
      tx.putClient(id, { authMethod: method, secret, redirectUris: [URI], name: "Example" }),
    );
  }
  return {
    root,
    app,
    store,
    codes,
    logs,
    wall,
    mono,
    clients,
    file: join(root, "auth", "auth.json"),
  };
}
type H = Awaited<ReturnType<typeof harness>>;

interface Send {
  ip?: string;
  type?: string | null;
  headers?: Record<string, string>;
  raw?: string;
  query?: string;
  path?: string;
}

async function post(h: H, fields: Record<string, string | undefined>, send: Send = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.append(k, v);
  const headers: Record<string, string> = {
    "x-forwarded-for": send.ip ?? "203.0.113.5",
    ...(send.headers ?? {}),
  };
  const text = send.raw ?? body.toString();
  let init: RequestInit;
  if (send.type === null) {
    init = { method: "POST", headers, body: new TextEncoder().encode(text) };
  } else {
    headers["content-type"] = send.type ?? "application/x-www-form-urlencoded";
    init = { method: "POST", headers, body: text };
  }
  const req = new Request(`http://internal/${send.path ?? "token"}${send.query ?? ""}`, init);
  if (send.type === null) req.headers.delete("content-type");
  return h.app.request(req);
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

function issue(
  h: H,
  method: Method = "none",
  over: Partial<{ uri: string; verifier: string }> = {},
) {
  const verifier = over.verifier ?? randomBytes(32).toString("base64url");
  const code = h.codes.issue({
    clientId: h.clients[method].id,
    redirectUri: over.uri ?? URI,
    codeChallenge: challengeOf(verifier),
    resource: RESOURCE,
  });
  return { code, verifier };
}

function exchangeFields(h: H, method: Method, c: { code: string; verifier: string }) {
  const base: Record<string, string | undefined> = {
    grant_type: "authorization_code",
    code: c.code,
    code_verifier: c.verifier,
    redirect_uri: URI,
  };
  if (method === "client_secret_post") {
    base.client_id = h.clients[method].id;
    base.client_secret = h.clients[method].secret;
  } else if (method === "none") base.client_id = h.clients[method].id;
  return base;
}

function exchange(h: H, method: Method = "none", c = issue(h, method), send: Send = {}) {
  const headers = { ...(send.headers ?? {}) };
  if (method === "client_secret_basic") {
    headers.authorization = basic(h.clients[method].id, h.clients[method].secret ?? "");
  }
  return post(h, exchangeFields(h, method, c), { ...send, headers });
}

const data = (h: H) => JSON.parse(readFileSync(h.file, "utf8"));
const grants = (h: H) => Object.entries(data(h).grants) as [string, Record<string, unknown>][];

async function login(h: H, method: Method = "none") {
  const res = await exchange(h, method);
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

function refreshFields(h: H, method: Method, refresh: string) {
  const f: Record<string, string | undefined> = {
    grant_type: "refresh_token",
    refresh_token: refresh,
  };
  if (method !== "client_secret_basic") f.client_id = h.clients[method].id;
  if (method === "client_secret_post") f.client_secret = h.clients[method].secret;
  return f;
}
function refresh(h: H, method: Method, token: string) {
  const headers: Record<string, string> = {};
  if (method === "client_secret_basic") {
    headers.authorization = basic(h.clients[method].id, h.clients[method].secret ?? "");
  }
  return post(h, refreshFields(h, method, token), { headers });
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: string; error_description: string };
  expect(body.error).toBe(error);
  expect(body.error_description).toBe(
    TOKEN_ERROR_DESCRIPTIONS[error as keyof typeof TOKEN_ERROR_DESCRIPTIONS],
  );
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
}

describe("POST /token authorization_code", () => {
  it("returns the token pair and stores only hashes", async () => {
    const h = await harness();
    const res = await exchange(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_token",
      "token_type",
    ]);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    const access = body.access_token as string;
    const refreshTok = body.refresh_token as string;
    const [[, grant]] = grants(h);
    expect(grant?.resource).toBe(RESOURCE);
    expect(grant?.clientId).toBe(h.clients.none.id);
    expect(Date.parse(grant?.accessExpiresAt as string) - START).toBe(TOKEN_LIFETIMES.accessMs);
    expect(Date.parse(grant?.refreshExpiresAt as string) - START).toBe(30 * DAY);
    expect(grant?.accessHash).toBe(sha256Hex(access));
    expect(grant?.refreshHash).toBe(sha256Hex(refreshTok));
    const file = readFileSync(h.file, "utf8");
    expect(file).not.toContain(access);
    expect(file).not.toContain(refreshTok);
  });

  it.each(["none", "client_secret_post", "client_secret_basic"] as const)(
    "authenticates %s",
    async (m) => {
      const h = await harness();
      expect((await exchange(h, m)).status).toBe(200);
    },
  );

  it("works end to end after POST /authorize", async () => {
    const h = await harness();
    const verifier = randomBytes(32).toString("base64url");
    const res = await h.app.request("http://internal/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        "x-forwarded-for": "203.0.113.9",
      },
      body: new URLSearchParams({
        response_type: "code",
        client_id: h.clients.none.id,
        redirect_uri: URI,
        code_challenge: challengeOf(verifier),
        code_challenge_method: "S256",
        passphrase: "x",
      }).toString(),
    });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    expect((await exchange(h, "none", { code, verifier })).status).toBe(200);
  });

  describe("client authentication", () => {
    const cases: [string, (h: H) => Promise<Response>, boolean][] = [
      [
        "wrong secret (post)",
        (h) =>
          post(h, {
            ...exchangeFields(h, "client_secret_post", issue(h, "client_secret_post")),
            client_secret: newId(),
          }),
        false,
      ],
      [
        "wrong secret (basic)",
        (h) =>
          post(h, exchangeFields(h, "client_secret_basic", issue(h, "client_secret_basic")), {
            headers: { authorization: basic(h.clients.client_secret_basic.id, newId()) },
          }),
        true,
      ],
      [
        "missing secret (post)",
        (h) => {
          const f = exchangeFields(h, "client_secret_post", issue(h, "client_secret_post"));
          f.client_secret = undefined;
          return post(h, f);
        },
        false,
      ],
      [
        "basic client sending post",
        (h) => {
          const c = issue(h, "client_secret_basic");
          return post(h, {
            ...exchangeFields(h, "none", c),
            client_id: h.clients.client_secret_basic.id,
            client_secret: h.clients.client_secret_basic.secret,
          });
        },
        false,
      ],
      [
        "none client sending a secret",
        (h) => post(h, { ...exchangeFields(h, "none", issue(h, "none")), client_secret: newId() }),
        false,
      ],
      [
        "unknown client",
        (h) => post(h, { ...exchangeFields(h, "none", issue(h, "none")), client_id: newId() }),
        false,
      ],
      [
        "basic id differs from body id",
        (h) =>
          post(
            h,
            { ...exchangeFields(h, "none", issue(h, "none")), client_id: newId() },
            {
              headers: {
                authorization: basic(
                  h.clients.client_secret_basic.id,
                  h.clients.client_secret_basic.secret ?? "",
                ),
              },
            },
          ),
        true,
      ],
      [
        "unparseable authorization",
        (h) =>
          post(h, exchangeFields(h, "none", issue(h, "none")), {
            headers: { authorization: "Bearer abc" },
          }),
        true,
      ],
    ];
    it.each(cases)("%s gives 401 and keeps the code", async (_name, run, wantsBasic) => {
      const h = await harness();
      const before = readFileSync(h.file, "utf8");
      const res = await run(h);
      await expectError(res, 401, "invalid_client");
      expect(res.headers.get("www-authenticate")).toBe(wantsBasic ? 'Basic realm="oauth"' : null);
      expect(h.codes.size()).toBe(1);
      expect(h.codes.consumedSize()).toBe(0);
      expect(readFileSync(h.file, "utf8")).toBe(before);
    });

    it("header and body secret together give 400", async () => {
      const h = await harness();
      const c = issue(h, "client_secret_basic");
      const res = await post(
        h,
        { ...exchangeFields(h, "client_secret_basic", c), client_secret: newId() },
        {
          headers: {
            authorization: basic(
              h.clients.client_secret_basic.id,
              h.clients.client_secret_basic.secret ?? "",
            ),
          },
        },
      );
      await expectError(res, 400, "invalid_request");
      expect(h.codes.size()).toBe(1);
    });

    it("an evicted client gives 401 and writes no grant", async () => {
      const h = await harness();
      const c = issue(h, "none");
      await h.store.update((tx) => tx.removeClient(h.clients.none.id));
      await expectError(await exchange(h, "none", c), 401, "invalid_client");
      expect(grants(h)).toHaveLength(0);
    });
  });

  it("a client evicted between authentication and the write gives 401 and no grant", async () => {
    let hold = false;
    let entered: () => void = () => undefined;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    let release: () => void = () => undefined;
    const h = await harness({
      io: {
        writeTemp: async (file, text) => {
          if (hold) {
            hold = false;
            entered();
            await new Promise<void>((r) => {
              release = r;
            });
          }
          const { writeFile } = await import("node:fs/promises");
          await writeFile(file, text, { mode: 0o600, flag: "wx" });
        },
      },
    });
    const c = issue(h);
    hold = true;
    const removal = h.store.update((tx) => tx.removeClient(h.clients.none.id));
    await enteredP;
    const pending = exchange(h, "none", c);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await removal;
    await expectError(await pending, 401, "invalid_client");
    expect(grants(h)).toHaveLength(0);
  });

  describe("invalid_grant", () => {
    it("rejects an expired code and accepts one just inside the ttl", async () => {
      const h = await harness();
      const a = issue(h);
      h.mono.t += 60_000;
      await expectError(await exchange(h, "none", a), 400, "invalid_grant");
      const b = issue(h);
      h.mono.t += 59_999;
      expect((await exchange(h, "none", b)).status).toBe(200);
    });

    it("rejects a wrong verifier", async () => {
      const h = await harness();
      const c = issue(h);
      const res = await exchange(h, "none", {
        code: c.code,
        verifier: randomBytes(32).toString("base64url"),
      });
      await expectError(res, 400, "invalid_grant");
      expect(grants(h)).toHaveLength(0);
    });

    it("rejects a redirect_uri that differs by a trailing slash", async () => {
      const h = await harness();
      const c = issue(h);
      const res = await post(h, { ...exchangeFields(h, "none", c), redirect_uri: `${URI}/` });
      await expectError(res, 400, "invalid_grant");
    });

    it("rejects a code issued to another client", async () => {
      const h = await harness();
      const c = issue(h, "client_secret_post");
      const res = await post(h, exchangeFields(h, "none", c));
      await expectError(res, 400, "invalid_grant");
    });

    it("a replayed code revokes its grant, and a second replay writes nothing", async () => {
      const h = await harness();
      const c = issue(h);
      expect((await exchange(h, "none", c)).status).toBe(200);
      await expectError(await exchange(h, "none", c), 400, "invalid_grant");
      expect(grants(h)[0]?.[1]?.revoked).toBe(true);
      expect(h.logs).toContain("token: code replayed, grant revoked");
      const before = readFileSync(h.file, "utf8");
      await expectError(await exchange(h, "none", c), 400, "invalid_grant");
      expect(readFileSync(h.file, "utf8")).toBe(before);
    });

    it("a replay that lands before attach revokes the grant and releases no token", async () => {
      let release: () => void = () => undefined;
      let hold = false;
      let entered: () => void = () => undefined;
      const enteredP = new Promise<void>((r) => {
        entered = r;
      });
      const h = await harness({
        io: {
          writeTemp: async (file, text) => {
            if (hold) {
              entered();
              await new Promise<void>((r) => {
                release = r;
              });
            }
            const { writeFile } = await import("node:fs/promises");
            await writeFile(file, text, { mode: 0o600, flag: "wx" });
          },
        },
      });
      const c = issue(h);
      hold = true;
      const first = exchange(h, "none", c);
      await enteredP;
      hold = false;
      const replay = await exchange(h, "none", c);
      await expectError(replay, 400, "invalid_grant");
      release();
      const res = await first;
      await expectError(res, 400, "invalid_grant");
      expect(grants(h)[0]?.[1]?.revoked).toBe(true);
    });
  });

  it("answers 500 when the write fails and releases no token", async () => {
    let fail = false;
    const h = await harness({
      io: {
        rename: async (from, to) => {
          if (fail) throw new Error("boom");
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      },
    });
    const c = issue(h);
    fail = true;
    await expectError(await exchange(h, "none", c), 500, "server_error");
    expect(grants(h)).toHaveLength(0);
  });
});

describe("POST /token refresh_token", () => {
  it("rotates the pair", async () => {
    const h = await harness();
    const first = await login(h);
    h.wall.t += 1000;
    const res = await refresh(h, "none", first.refresh_token);
    expect(res.status).toBe(200);
    const next = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(next.expires_in).toBe(3600);
    const [[, grant]] = grants(h);
    expect(grant?.accessHash).toBe(sha256Hex(next.access_token));
    expect(grant?.refreshHash).toBe(sha256Hex(next.refresh_token));
    expect(Date.parse(grant?.accessExpiresAt as string)).toBe(h.wall.t + 3_600_000);
  });

  it("reuse of the old refresh token revokes the grant and the new one stops working", async () => {
    const h = await harness();
    const first = await login(h);
    const next = (await (await refresh(h, "none", first.refresh_token)).json()) as {
      refresh_token: string;
    };
    await expectError(await refresh(h, "none", first.refresh_token), 400, "invalid_grant");
    expect(grants(h)[0]?.[1]?.revoked).toBe(true);
    expect(h.logs).toContain("token: refresh reuse, grant revoked");
    const before = readFileSync(h.file, "utf8");
    await expectError(await refresh(h, "none", next.refresh_token), 400, "invalid_grant");
    await expectError(await refresh(h, "none", first.refresh_token), 400, "invalid_grant");
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("slides the refresh lifetime from each refresh", async () => {
    const h = await harness();
    const first = await login(h);
    h.wall.t += 20 * DAY;
    const next = (await (await refresh(h, "none", first.refresh_token)).json()) as {
      refresh_token: string;
    };
    h.wall.t = START + 45 * DAY;
    const again = await refresh(h, "none", next.refresh_token);
    expect(again.status).toBe(200);
    const third = (await again.json()) as { refresh_token: string };
    h.wall.t = START + 76 * DAY;
    await expectError(await refresh(h, "none", third.refresh_token), 400, "invalid_grant");
  });

  it("rejects a refresh token at 31 days", async () => {
    const h = await harness();
    const first = await login(h);
    h.wall.t += 31 * DAY;
    await expectError(await refresh(h, "none", first.refresh_token), 400, "invalid_grant");
  });

  it("rejects another client and changes nothing", async () => {
    const h = await harness();
    const first = await login(h);
    const before = readFileSync(h.file, "utf8");
    await expectError(
      await refresh(h, "client_secret_post", first.refresh_token),
      400,
      "invalid_grant",
    );
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("an unknown refresh token writes nothing", async () => {
    const h = await harness();
    await login(h);
    const before = readFileSync(h.file, "utf8");
    await expectError(await refresh(h, "none", newId()), 400, "invalid_grant");
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("rejects a grant whose resource is not the resource URL", async () => {
    const h = await harness();
    const refreshTok = newId();
    await h.store.update((tx) =>
      tx.putGrant(newId(), {
        clientId: h.clients.none.id,
        resource: `${ISSUER}/other`,
        accessToken: newId(),
        accessExpiresAt: new Date(START + 1000),
        refreshToken: refreshTok,
        refreshExpiresAt: new Date(START + DAY),
      }),
    );
    const before = readFileSync(h.file, "utf8");
    await expectError(await refresh(h, "none", refreshTok), 400, "invalid_grant");
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("answers 500 when the rotation write fails", async () => {
    let fail = false;
    const h = await harness({
      io: {
        rename: async (from, to) => {
          if (fail) throw new Error("boom");
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      },
    });
    const first = await login(h);
    fail = true;
    await expectError(await refresh(h, "none", first.refresh_token), 500, "server_error");
  });
});

describe("POST /revoke", () => {
  const revokeAs = (h: H, token: string, method: Method = "none", send: Send = {}) => {
    const headers: Record<string, string> = { ...(send.headers ?? {}) };
    const f: Record<string, string | undefined> = { token };
    if (method === "client_secret_basic") {
      headers.authorization = basic(h.clients[method].id, h.clients[method].secret ?? "");
    } else {
      f.client_id = h.clients[method].id;
      if (method === "client_secret_post") f.client_secret = h.clients[method].secret;
    }
    return post(h, f, { ...send, headers, path: "revoke" });
  };

  it.each(["access_token", "refresh_token"] as const)("revokes by %s", async (which) => {
    const h = await harness();
    const t = await login(h);
    const res = await revokeAs(h, t[which]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(grants(h)[0]?.[1]?.revoked).toBe(true);
  });

  it("an unknown token answers 200 and writes nothing", async () => {
    const h = await harness();
    await login(h);
    const before = readFileSync(h.file, "utf8");
    expect((await revokeAs(h, newId())).status).toBe(200);
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("a second revoke writes nothing", async () => {
    const h = await harness();
    const t = await login(h);
    await revokeAs(h, t.access_token);
    const before = readFileSync(h.file, "utf8");
    expect((await revokeAs(h, t.access_token)).status).toBe(200);
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("another client revoking answers 200 and changes nothing", async () => {
    const h = await harness();
    const t = await login(h);
    const before = readFileSync(h.file, "utf8");
    expect((await revokeAs(h, t.refresh_token, "client_secret_post")).status).toBe(200);
    expect(readFileSync(h.file, "utf8")).toBe(before);
    expect(grants(h)[0]?.[1]?.revoked).toBe(false);
  });

  it("answers 500 when the write fails", async () => {
    let fail = false;
    const h = await harness({
      io: {
        rename: async (from, to) => {
          if (fail) throw new Error("boom");
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      },
    });
    const t = await login(h);
    fail = true;
    await expectError(await revokeAs(h, t.access_token), 500, "server_error");
  });

  it("requires a token and client authentication", async () => {
    const h = await harness();
    const f = { client_id: h.clients.none.id };
    await expectError(await post(h, f, { path: "revoke" }), 400, "invalid_request");
    const bad = await post(
      h,
      { token: newId(), client_id: h.clients.client_secret_post.id, client_secret: newId() },
      { path: "revoke" },
    );
    await expectError(bad, 401, "invalid_client");
  });

  it("is rate limited separately from /token", async () => {
    const h = await harness();
    for (let i = 0; i < 60; i += 1) await post(h, {}, { path: "token" });
    expect((await post(h, {}, { path: "token" })).status).toBe(429);
    expect((await post(h, {}, { path: "revoke" })).status).toBe(400);
  });
});

describe("request shape", () => {
  const bodyCases: [string, Send, number][] = [
    ["text/plain", { type: "text/plain" }, 400],
    ["missing content type", { type: null }, 400],
    ["json", { type: "application/json" }, 400],
  ];
  it.each(bodyCases)("%s gives 400 and keeps the code", async (_n, send) => {
    const h = await harness();
    const res = await exchange(h, "none", issue(h), send);
    await expectError(res, 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
    expect(h.codes.consumedSize()).toBe(0);
  });

  it("a body over the limit gives 400 with the fixed description", async () => {
    const h = await harness();
    const c = issue(h);
    const res = await exchange(h, "none", c, {
      raw: `pad=${"a".repeat(TOKEN_MAX_BODY_BYTES + 1)}`,
    });
    await expectError(res, 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
  });

  it("a duplicated parameter gives 400", async () => {
    const h = await harness();
    const c = issue(h);
    const raw = `${new URLSearchParams(exchangeFields(h, "none", c) as Record<string, string>)}&code=${newId()}`;
    await expectError(await exchange(h, "none", c, { raw }), 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
  });

  it("fields only in the query give 400", async () => {
    const h = await harness();
    const c = issue(h);
    const q = `?${new URLSearchParams(exchangeFields(h, "none", c) as Record<string, string>)}`;
    await expectError(await post(h, {}, { query: q }), 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
  });

  it("a duplicated unrelated parameter gives 400", async () => {
    const h = await harness();
    const c = issue(h);
    const raw = `${new URLSearchParams(exchangeFields(h, "none", c) as Record<string, string>)}&scope=a&scope=b`;
    await expectError(await exchange(h, "none", c, { raw }), 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
  });

  it("a missing field gives 400 and a malformed verifier keeps the code", async () => {
    const h = await harness();
    const c = issue(h);
    const f = exchangeFields(h, "none", c);
    await expectError(await post(h, { ...f, code_verifier: "short" }), 400, "invalid_request");
    await expectError(await post(h, { ...f, redirect_uri: undefined }), 400, "invalid_request");
    await expectError(await post(h, { ...f, grant_type: undefined }), 400, "invalid_request");
    expect(h.codes.size()).toBe(1);
  });

  it("an unknown grant_type and a foreign resource are refused", async () => {
    const h = await harness();
    const c = issue(h);
    const f = exchangeFields(h, "none", c);
    await expectError(
      await post(h, { ...f, grant_type: "password" }),
      400,
      "unsupported_grant_type",
    );
    await expectError(
      await post(h, { ...f, resource: "https://evil.example.com/mcp" }),
      400,
      "invalid_target",
    );
    expect(h.codes.size()).toBe(1);
    expect((await post(h, { ...f, resource: RESOURCE })).status).toBe(200);
  });

  it("ignores scope and unknown parameters", async () => {
    const h = await harness();
    const f = { ...exchangeFields(h, "none", issue(h)), scope: "x", whatever: "y" };
    expect((await post(h, f)).status).toBe(200);
  });

  it("the 61st request in a minute gets 429 with Retry-After, another IP is served", async () => {
    const h = await harness();
    for (let i = 0; i < 60; i += 1) expect((await post(h, {})).status).toBe(400);
    const res = await post(h, {});
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(h, {}, { ip: "198.51.100.7" })).status).toBe(400);
  });

  it("no request value reaches a body, header or log", async () => {
    const h = await harness();
    const sentinel = "SENTINEL-value-1234567890";
    const responses = [
      await post(h, { grant_type: "authorization_code", client_id: sentinel, code: sentinel }),
      await post(h, {
        ...exchangeFields(h, "none", issue(h)),
        code: sentinel,
        code_verifier: sentinel.padEnd(50, "a"),
      }),
      await post(h, { grant_type: sentinel, client_id: h.clients.none.id }),
      await post(h, { token: sentinel, client_id: sentinel }, { path: "revoke" }),
      await post(h, {
        grant_type: "refresh_token",
        refresh_token: sentinel,
        client_id: h.clients.none.id,
      }),
    ];
    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toContain(sentinel);
      expect(JSON.stringify([...res.headers])).not.toContain(sentinel);
    }
    expect(h.logs.join("\n")).not.toContain(sentinel);
  });
});

describe("helpers", () => {
  const enc = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  it("parseBasicAuth decodes form-encoded halves", () => {
    expect(parseBasicAuth(enc("id:a%3Ab"))).toEqual({ clientId: "id", secret: "a:b" });
    expect(parseBasicAuth(enc("id:a+b"))).toEqual({ clientId: "id", secret: "a b" });
    expect(parseBasicAuth(enc("noColon"))).toBeUndefined();
    expect(parseBasicAuth(enc(":secret"))).toBeUndefined();
    expect(parseBasicAuth(enc("id:%zz"))).toBeUndefined();
    expect(parseBasicAuth("Basic !!!")).toBeUndefined();
    expect(parseBasicAuth(enc("id:s").replace("Basic", "basic"))).toEqual({
      clientId: "id",
      secret: "s",
    });
  });

  it("pkceS256Matches compares the S256 transform", () => {
    const v = randomBytes(32).toString("base64url");
    expect(pkceS256Matches(v, challengeOf(v))).toBe(true);
    expect(pkceS256Matches(v, challengeOf(`${v}x`))).toBe(false);
    expect(pkceS256Matches(v, v)).toBe(false);
    const other = challengeOf(v).replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    expect(pkceS256Matches(v, other)).toBe(false);
  });
});
