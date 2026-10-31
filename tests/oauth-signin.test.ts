import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING_VERIFICATIONS, SIGNIN_ERROR } from "../src/auth/oauth/authorize.js";
import { type CodeStore, createCodeStore } from "../src/auth/oauth/codes.js";
import { type AuthStore, newId, openAuthStore } from "../src/auth/oauth/store.js";
import { createSignInLockout, hashPassphrase, SIGNIN_LOCKOUT } from "../src/auth/owner.js";
import { createPublicApp } from "../src/mcp/app.js";

const ISSUER = "https://brain.example.com";
const RESOURCE = `${ISSUER}/mcp`;
const URI = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "A".repeat(43);
// Fixture passphrases are built at runtime so no secret-shaped literal sits in the source.
const RIGHT = ["fixture", "right", "phrase", "one"].join("-");
const WRONG = ["fixture", "wrong", "phrase", "two"].join("-");
const MIN = 60_000;

const roots: string[] = [];
const stores: AuthStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Options {
  verify?: (passphrase: string, stored: string) => Promise<boolean>;
  realHash?: string;
  redirectUris?: string[];
  maxCodes?: number;
}

async function harness(options: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-signin-")));
  roots.push(root);
  mkdirSync(join(root, "vault"));
  const store = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    log: () => undefined,
  });
  stores.push(store);
  const clock = { t: 10_000 };
  const now = () => clock.t;
  const codes: CodeStore = createCodeStore({ now, maxCodes: options.maxCodes });
  const logs: string[] = [];
  const verify = vi.fn(options.verify ?? (async (p: string) => p === RIGHT));
  const { app } = createPublicApp({
    baseUrl: ISSUER,
    log: (line) => logs.push(line),
    auth: {
      store,
      allowedRedirectHosts: ["claude.ai", "claude.com"],
      trustProxyHops: 1,
      ownerPassphraseHash: options.realHash ?? "stored-hash",
      rateNow: now,
      now,
      codes,
      ...(options.realHash === undefined ? { verifyPassphrase: verify } : {}),
    },
  });
  const clientId = newId();
  await store.update((tx) =>
    tx.putClient(clientId, {
      authMethod: "none",
      redirectUris: options.redirectUris ?? [URI],
      name: "Example Client",
    }),
  );
  return { app, clientId, clock, codes, logs, verify };
}

type H = Awaited<ReturnType<typeof harness>>;

interface Send {
  ip?: string;
  origin?: string | null;
  type?: string | null;
  fields?: Record<string, string | undefined>;
  extra?: [string, string][];
  rawBody?: string;
  query?: string;
}

function fieldsFor(h: H, passphrase: string | undefined, overrides: Send["fields"] = {}) {
  const base: Record<string, string | undefined> = {
    client_id: h.clientId,
    redirect_uri: URI,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st1",
    passphrase,
    ...overrides,
  };
  return base;
}

async function post(h: H, passphrase: string | undefined, send: Send = {}): Promise<Response> {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(fieldsFor(h, passphrase, send.fields))) {
    if (v !== undefined) pairs.push([k, v]);
  }
  pairs.push(...(send.extra ?? []));
  const text = send.rawBody ?? new URLSearchParams(pairs).toString();
  const headers: Record<string, string> = { "x-forwarded-for": send.ip ?? "203.0.113.5" };
  if (send.origin !== null) headers.origin = send.origin ?? ISSUER;
  const type = send.type === undefined ? "application/x-www-form-urlencoded" : send.type;
  if (type !== null) headers["content-type"] = type;
  // A Uint8Array body gets no automatic content type; a string body gets text/plain.
  const body = type === null ? new TextEncoder().encode(text) : text;
  return h.app.request(`/authorize${send.query ?? ""}`, { method: "POST", headers, body });
}

function expectPageHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
}

function codeFrom(res: Response): string {
  const location = new URL(res.headers.get("location") ?? "");
  return location.searchParams.get("code") ?? "";
}

describe("POST /authorize: success (R4.4)", () => {
  it("redirects with a code bound to the request, usable once", async () => {
    const h = await harness();
    const res = await post(h, RIGHT);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(`${URI}?`)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("st1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const code = codeFrom(res);
    expect(code).not.toBe("");
    const first = h.codes.consume(code);
    expect(first).toMatchObject({
      kind: "ok",
      binding: {
        clientId: h.clientId,
        redirectUri: URI,
        codeChallenge: CHALLENGE,
        resource: RESOURCE,
      },
    });
    expect(h.codes.consume(code).kind).toBe("replayed");
  });

  it("gives different codes to two sign-ins", async () => {
    const h = await harness();
    const a = codeFrom(await post(h, RIGHT));
    const b = codeFrom(await post(h, RIGHT));
    expect(a).not.toBe(b);
  });

  it("accepts a code at 59,999 ms and refuses one at 60,000 ms", async () => {
    const h = await harness();
    const early = codeFrom(await post(h, RIGHT));
    const late = codeFrom(await post(h, RIGHT));
    h.clock.t += 59_999;
    expect(h.codes.consume(early).kind).toBe("ok");
    h.clock.t += 1;
    expect(h.codes.consume(late).kind).toBe("invalid");
  });

  it("works with a real scrypt hash", async () => {
    const realHash = await hashPassphrase(RIGHT);
    const h = await harness({ realHash });
    expect((await post(h, WRONG)).status).toBe(200);
    expect((await post(h, RIGHT)).status).toBe(302);
  });

  it("appends the code with & to a redirect URI that already has a query", async () => {
    const uri = "https://claude.ai/cb?x=1";
    const h = await harness({ redirectUris: [uri] });
    const res = await post(h, RIGHT, { fields: { redirect_uri: uri } });
    expect(res.headers.get("location")?.startsWith(`${uri}&code=`)).toBe(true);
  });

  it("redirects a loopback client to the port it asked for", async () => {
    const h = await harness({ redirectUris: ["http://127.0.0.1:1234/cb"] });
    const res = await post(h, RIGHT, { fields: { redirect_uri: "http://127.0.0.1:5678/cb" } });
    expect(res.headers.get("location")?.startsWith("http://127.0.0.1:5678/cb?code=")).toBe(true);
  });

  it("answers a [::1] redirect with a same-origin continue page", async () => {
    const uri = "http://[::1]:1234/cb";
    const h = await harness({ redirectUris: [uri] });
    const res = await post(h, RIGHT, { fields: { redirect_uri: uri, state: "a&b<c" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expectPageHeaders(res);
    const body = await res.text();
    expect(h.codes.size()).toBe(1);
    expect(body).toMatch(
      /<meta http-equiv="refresh" content="0; url=http:\/\/\[::1\]:1234\/cb\?code=/,
    );
    expect(body).toContain('<a href="http://[::1]:1234/cb?code=');
    expect(body).toContain("state=a%26b%3Cc");
    expect(body).not.toContain("<c");
  });
});

describe("POST /authorize: request checks issue no code", () => {
  it("shows the 400 page for an unknown client", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, { fields: { client_id: "nope" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(h.codes.size()).toBe(0);
  });

  it("shows the 400 page for an unregistered redirect URI", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, {
      fields: { redirect_uri: "https://claude.ai/other" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(h.codes.size()).toBe(0);
  });

  it("shows the 400 page for a duplicated client_id", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, { extra: [["client_id", h.clientId]] });
    expect(res.status).toBe(400);
    expect(h.codes.size()).toBe(0);
  });

  it.each([
    ["plain challenge method", { code_challenge_method: "plain" }, "invalid_request"],
    ["missing challenge", { code_challenge: undefined }, "invalid_request"],
    ["foreign resource", { resource: "https://evil.example.net/mcp" }, "invalid_target"],
  ])("redirects an error for %s", async (_name, fields, error) => {
    const h = await harness();
    const res = await post(h, RIGHT, { fields });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe(error);
    expect(location.searchParams.get("code")).toBeNull();
    expect(h.codes.size()).toBe(0);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("ignores the query string", async () => {
    const h = await harness();
    const query = `?${new URLSearchParams(Object.entries(fieldsFor(h, RIGHT)) as [string, string][])}`;
    const res = await post(h, RIGHT, { rawBody: "", query });
    expect(res.status).toBe(400);
    expect(h.codes.size()).toBe(0);
  });
});

describe("POST /authorize: Origin", () => {
  it.each([
    ["missing", null],
    ["null", "null"],
    ["foreign", "https://evil.example.net"],
    ["other port", "https://brain.example.com:444"],
  ])("refuses a %s Origin without a count or scrypt", async (_name, origin) => {
    const h = await harness();
    for (let i = 0; i < 6; i++) {
      const res = await post(h, RIGHT, { origin, ip: "198.51.100.1" });
      expect(res.status).toBe(403);
      expectPageHeaders(res);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.codes.size()).toBe(0);
    h.clock.t += MIN;
    expect((await post(h, RIGHT, { ip: "198.51.100.1" })).status).toBe(302);
  });

  it("answers a bad client with 400 before the Origin check", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, { origin: null, fields: { client_id: "nope" } });
    expect(res.status).toBe(400);
  });

  it("never redirects an error to a cross-origin POST", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, {
      origin: "https://evil.example.net",
      fields: { code_challenge_method: "plain" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("POST /authorize: body", () => {
  it.each([
    ["text/plain", "text/plain"],
    ["missing", null],
    ["json", "application/json"],
  ])("answers the 400 page for content type %s", async (_name, type) => {
    const h = await harness();
    const res = await post(h, RIGHT, { type });
    expect(res.status).toBe(400);
    expectPageHeaders(res);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("accepts a content type with parameters and upper case", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, {
      type: "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
    });
    expect(res.status).toBe(302);
  });

  it("answers the 400 page for a body over 32 KiB", async () => {
    const h = await harness();
    const res = await post(h, RIGHT, { rawBody: `x=${"a".repeat(33 * 1024)}` });
    expect(res.status).toBe(400);
    expectPageHeaders(res);
    expect(h.verify).not.toHaveBeenCalled();
  });
});

describe("POST /authorize: passphrase field and generic error", () => {
  it.each([
    ["duplicated", RIGHT, [["passphrase", WRONG]] as [string, string][]],
    ["empty", "", []],
    ["missing", undefined, []],
    ["over 1024 bytes", "é".repeat(513), []],
  ])("shows the generic page for a %s passphrase without scrypt", async (_n, value, extra) => {
    const h = await harness();
    const res = await post(h, value, { extra });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain(SIGNIN_ERROR);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.codes.size()).toBe(0);
  });

  it("passes a 1024-byte passphrase to verify", async () => {
    const h = await harness();
    await post(h, "é".repeat(512));
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("counts malformed fields toward the lockout", async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) await post(h, "");
    expect((await post(h, RIGHT)).status).toBe(429);
  });

  it("shows the page again for a wrong passphrase, with the fixed error", async () => {
    const h = await harness();
    const res = await post(h, WRONG);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expectPageHeaders(res);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://claude.ai",
    );
    const body = await res.text();
    expect(body).toContain(SIGNIN_ERROR);
    expect(body).toContain(`name="client_id" value="${h.clientId}"`);
    expect(body).toContain('name="state" value="st1"');
    expect(body).not.toContain(WRONG);
    expect(h.codes.size()).toBe(0);
  });

  it("answers the generic page and one fixed line when verify throws", async () => {
    const h = await harness({
      verify: async () => {
        throw new Error(`secret ${RIGHT}`);
      },
    });
    const res = await post(h, RIGHT);
    expect(res.status).toBe(500);
    expectPageHeaders(res);
    expect(await res.text()).toContain(SIGNIN_ERROR);
    expect(h.logs).toEqual(["authorize: passphrase check failed"]);
  });

  it("leaks no passphrase into a body, header or log", async () => {
    const h = await harness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const seen: string[] = [];
    for (const value of [RIGHT, WRONG]) {
      const res = await post(h, value);
      seen.push(await res.text());
      for (const [k, v] of res.headers) seen.push(`${k}: ${v}`);
    }
    seen.push(...h.logs, JSON.stringify(errorSpy.mock.calls), JSON.stringify(logSpy.mock.calls));
    for (const text of seen) {
      expect(text).not.toContain(RIGHT);
      expect(text).not.toContain(WRONG);
    }
    expect(h.logs).toEqual(["authorize: signin ok", "authorize: signin failed"]);
  });
});

describe("POST /authorize: lockout (R4.5)", () => {
  it("lets the right passphrase through after 4 wrong attempts", async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) expect((await post(h, WRONG)).status).toBe(200);
    expect((await post(h, RIGHT)).status).toBe(302);
  });

  it("locks the 6th request after 5 wrong attempts, scrypt called 5 times", async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) await post(h, WRONG);
    const res = await post(h, RIGHT);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expectPageHeaders(res);
    expect(res.headers.get("location")).toBeNull();
    expect(h.verify).toHaveBeenCalledTimes(5);
    expect(h.codes.size()).toBe(0);
  });

  it("does not lock another IP, and a /64 shares one lock", async () => {
    const h = await harness();
    const v6 = "2001:db8:1:2::1";
    for (let i = 0; i < 5; i++) await post(h, WRONG, { ip: v6 });
    expect((await post(h, RIGHT, { ip: v6 })).status).toBe(429);
    expect((await post(h, RIGHT, { ip: "2001:db8:1:2::ffff" })).status).toBe(429);
    expect((await post(h, RIGHT, { ip: "2001:db8:1:3::1" })).status).toBe(302);
    expect((await post(h, RIGHT, { ip: "203.0.113.77" })).status).toBe(302);
  });

  it("unlocks exactly 15 minutes after the 5th attempt", async () => {
    const h = await harness();
    const start = h.clock.t;
    for (let i = 0; i < 5; i++) {
      h.clock.t = start + i * 3 * MIN;
      await post(h, WRONG);
    }
    const fifth = start + 12 * MIN;
    h.clock.t = fifth + 15 * MIN - 1;
    expect((await post(h, RIGHT)).status).toBe(429);
    h.clock.t = fifth + 15 * MIN;
    expect((await post(h, RIGHT)).status).toBe(302);
  });

  it("starts a fresh count after the window passes", async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) await post(h, WRONG);
    h.clock.t += 15 * MIN;
    await post(h, WRONG);
    expect((await post(h, RIGHT)).status).toBe(302);
  });

  it("slides: a burst across a window edge still locks (no fixed-window reset)", async () => {
    const h = await harness();
    await post(h, WRONG);
    h.clock.t += 14 * MIN;
    for (let i = 0; i < 3; i++) await post(h, WRONG);
    h.clock.t += MIN;
    await post(h, WRONG);
    await post(h, WRONG);
    expect((await post(h, RIGHT)).status).toBe(429);
  });

  it("clears the count after a right passphrase", async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) await post(h, WRONG);
    expect((await post(h, RIGHT)).status).toBe(302);
    for (let i = 0; i < 4; i++) await post(h, WRONG);
    expect((await post(h, RIGHT)).status).toBe(302);
  });
});

describe("createSignInLockout", () => {
  it("refuses a new key when the table is full of live entries, keeps locks", () => {
    const t = { now: 0 };
    const lockout = createSignInLockout({ now: () => t.now, maxEntries: 2 });
    for (let i = 0; i < SIGNIN_LOCKOUT.maxAttempts; i++) lockout.record("a");
    expect(lockout.record("b")).toEqual({ ok: true });
    const refused = lockout.record("c");
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 900 });
    expect(lockout.check("a").ok).toBe(false);
    expect(lockout.size()).toBe(2);
    t.now += SIGNIN_LOCKOUT.windowMs;
    expect(lockout.record("c")).toEqual({ ok: true });
  });

  it("reports the remaining time in whole seconds, at least 1", () => {
    const t = { now: 0 };
    const lockout = createSignInLockout({ now: () => t.now });
    for (let i = 0; i < 5; i++) lockout.record("a");
    t.now = SIGNIN_LOCKOUT.lockMs - 1;
    expect(lockout.check("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
    t.now = 1;
    expect(lockout.check("a")).toEqual({ ok: false, retryAfterSeconds: 900 });
  });
});

describe("POST /authorize: rate limit and verification cap", () => {
  it("answers the 11th submission in a minute with 429 JSON", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) {
      expect((await post(h, RIGHT, { origin: "https://evil.example.net" })).status).toBe(403);
    }
    const res = await post(h, RIGHT);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "too_many_requests" });
    expect((await post(h, RIGHT, { ip: "203.0.113.99" })).status).toBe(302);
  });

  it("refuses a sign-in past the in-flight cap without counting it", async () => {
    const waiting: ((ok: boolean) => void)[] = [];
    const h = await harness({ verify: () => new Promise<boolean>((r) => waiting.push(r)) });
    const inFlight = [] as Promise<Response>[];
    for (let i = 0; i < MAX_PENDING_VERIFICATIONS; i++) inFlight.push(post(h, WRONG));
    await vi.waitFor(() => expect(waiting).toHaveLength(MAX_PENDING_VERIFICATIONS));
    const refused = await post(h, WRONG);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expectPageHeaders(refused);
    expect(waiting).toHaveLength(MAX_PENDING_VERIFICATIONS);
    for (const resolve of waiting) resolve(false);
    for (const res of await Promise.all(inFlight)) expect(res.status).toBe(200);
    // 4 attempts were counted; had the refused one counted, this one would be locked out.
    const next = post(h, RIGHT);
    await vi.waitFor(() => expect(waiting).toHaveLength(MAX_PENDING_VERIFICATIONS + 1));
    waiting[MAX_PENDING_VERIFICATIONS]?.(true);
    expect((await next).status).toBe(302);
  });
});
