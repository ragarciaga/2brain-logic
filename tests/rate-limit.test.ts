import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, createLimiter, RATE_RULES, rateKey, rateLimit } from "../src/auth/rate-limit.js";

// Documentation addresses only: 203.0.113.0/24, 198.51.100.0/24, 2001:db8::/32.
const A = "203.0.113.10";
const B = "203.0.113.11";
const C = "198.51.100.7";

type Probe = {
  status: number;
  retryAfter: string | null;
  cacheControl: string | null;
  body: string;
};

type RequestOptions = {
  socket?: string | null;
  forwarded?: string[];
  noEnv?: boolean;
};

async function call(app: Hono, path: string, options: RequestOptions = {}): Promise<Probe> {
  const headers = new Headers();
  for (const value of options.forwarded ?? []) headers.append("x-forwarded-for", value);
  const env = options.noEnv
    ? undefined
    : {
        incoming: {
          socket: options.socket === null ? {} : { remoteAddress: options.socket ?? A },
        },
      };
  const response = await app.request(path, { method: "POST", headers }, env);
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

function limitedApp(hops: number, now: () => number, maxBuckets?: number): Hono {
  const app = new Hono();
  for (const rule of Object.values(RATE_RULES)) {
    app.post(`/${rule.name}`, rateLimit(rule, { trustProxyHops: hops, now, maxBuckets }), (c) =>
      c.text("ok"),
    );
  }
  return app;
}

function ipApp(hops: number): Hono {
  const app = new Hono();
  app.post("/ip", (c) => c.text(clientIp(c, hops)));
  return app;
}

async function ipOf(hops: number, options: RequestOptions): Promise<string> {
  return (await call(ipApp(hops), "/ip", options)).body;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RATE_RULES", () => {
  it("holds the R7.1 limits and the global ceilings, each name equal to its key", () => {
    expect(RATE_RULES).toEqual({
      register: { name: "register", limit: 10, windowMs: 3_600_000, globalLimit: 30 },
      token: { name: "token", limit: 60, windowMs: 60_000, globalLimit: 600 },
      signin: { name: "signin", limit: 10, windowMs: 60_000, globalLimit: 30 },
    });
  });

  it("is frozen, rules included", () => {
    expect(Object.isFrozen(RATE_RULES)).toBe(true);
    for (const rule of Object.values(RATE_RULES)) expect(Object.isFrozen(rule)).toBe(true);
  });
});

describe("rateLimit on a probe app (R7.1)", () => {
  it.each([
    ["register", 10],
    ["token", 60],
    ["signin", 10],
  ])("%s: request %i passes and the next one gets 429 with Retry-After", async (name, limit) => {
    const app = limitedApp(0, () => 0);
    for (let i = 1; i <= limit; i += 1) {
      expect((await call(app, `/${name}`)).status).toBe(200);
    }
    const refused = await call(app, `/${name}`);
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(refused.retryAfter))).toBe(true);
    expect((await call(app, `/${name}`, { socket: B })).status).toBe(200);
  });

  it("rules never share a bucket", async () => {
    const app = limitedApp(0, () => 0);
    for (let i = 0; i < 10; i += 1) await call(app, "/register");
    expect((await call(app, "/register")).status).toBe(429);
    expect((await call(app, "/signin")).status).toBe(200);
    expect((await call(app, "/token")).status).toBe(200);
  });

  it("answers Retry-After with the seconds left, rounded up, and resets exactly at the window end", async () => {
    let now = 0;
    const app = limitedApp(0, () => now);
    for (let i = 0; i < 10; i += 1) expect((await call(app, "/register")).status).toBe(200);
    now = 100_000;
    expect((await call(app, "/register")).retryAfter).toBe("3500");
    now = 100_500;
    expect((await call(app, "/register")).retryAfter).toBe("3500");
    now = 3_599_999;
    const last = await call(app, "/register");
    expect(last.status).toBe(429);
    expect(last.retryAfter).toBe("1");
    now = 3_600_000;
    for (let i = 0; i < 10; i += 1) expect((await call(app, "/register")).status).toBe(200);
    expect((await call(app, "/register")).status).toBe(429);
  });

  it("counts a refused request neither against the key nor the window", async () => {
    let now = 0;
    const app = limitedApp(0, () => now);
    for (let i = 0; i < 10; i += 1) await call(app, "/signin");
    now = 59_000;
    for (let i = 0; i < 20; i += 1) expect((await call(app, "/signin")).status).toBe(429);
    now = 60_000;
    expect((await call(app, "/signin")).status).toBe(200);
  });

  it("answers a fixed body and no-store without the client IP or any header value", async () => {
    const app = limitedApp(1, () => 0);
    const options = { socket: "203.0.113.77", forwarded: [`198.51.100.99, ${C}`] };
    for (let i = 0; i < 10; i += 1) await call(app, "/signin", options);
    const refused = await call(app, "/signin", {
      socket: "203.0.113.77",
      forwarded: [`marker-header-value, ${C}`],
    });
    expect(refused.status).toBe(429);
    expect(refused.cacheControl).toBe("no-store");
    expect(JSON.parse(refused.body)).toEqual({
      error: "too_many_requests",
      error_description: "Too many requests, retry later",
    });
    for (const secret of ["198.51.100", "203.0.113", "marker-header-value"]) {
      expect(refused.body).not.toContain(secret);
    }
  });

  it("never logs with hops 0", async () => {
    const app = limitedApp(0, () => 0);
    for (let i = 0; i < 12; i += 1) await call(app, "/signin");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs exactly one fixed line with hops 1 and a missing forwarded entry, across requests", async () => {
    vi.resetModules();
    const fresh = await import("../src/auth/rate-limit.js");
    const app = new Hono();
    app.post(
      "/signin",
      fresh.rateLimit(fresh.RATE_RULES.signin, { trustProxyHops: 1, now: () => 0 }),
      (c) => c.text("ok"),
    );
    for (let i = 0; i < 12; i += 1) await call(app, "/signin", { socket: C });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "rate-limit: forwarded entry missing or not an IP; keyed on socket",
    );
  });

  it("does not call the next handler on 429", async () => {
    const next = vi.fn(async () => undefined);
    const app = new Hono();
    app.post(
      "/x",
      rateLimit({ name: "x", limit: 1, windowMs: 1000 }, { trustProxyHops: 0, now: () => 0 }),
      (c) => {
        next();
        return c.text("ok");
      },
    );
    await call(app, "/x");
    await call(app, "/x");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("global ceilings", () => {
  it("refuses a client with an empty bucket once all keys together reach the ceiling", async () => {
    let now = 0;
    const app = limitedApp(0, () => now);
    for (let i = 0; i < 30; i += 1) {
      const address = `198.51.100.${i + 1}`;
      expect((await call(app, "/register", { socket: address })).status).toBe(200);
    }
    const refused = await call(app, "/register", { socket: "198.51.100.200" });
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("3600");
    now = 3_600_000;
    expect((await call(app, "/register", { socket: "198.51.100.200" })).status).toBe(200);
  });

  it("token: several IPs reach the 600 per minute ceiling and a fresh IP is refused until the window ends", async () => {
    let now = 0;
    const app = limitedApp(0, () => now);
    for (let i = 0; i < 600; i += 1) {
      const address = `198.51.100.${(i % 10) + 1}`;
      // 10 addresses x 60 requests each: no key limit is hit, only the sum reaches 600.
      expect((await call(app, "/token", { socket: address })).status).toBe(200);
    }
    const refused = await call(app, "/token", { socket: "198.51.100.200" });
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("60");
    now = 60_000;
    expect((await call(app, "/token", { socket: "198.51.100.200" })).status).toBe(200);
  });

  it("does not touch another rule", async () => {
    const app = limitedApp(0, () => 0);
    for (let i = 0; i < 30; i += 1) await call(app, "/signin", { socket: `198.51.100.${i + 1}` });
    expect((await call(app, "/signin", { socket: "198.51.100.200" })).status).toBe(429);
    expect((await call(app, "/token", { socket: "198.51.100.200" })).status).toBe(200);
  });

  it("counts only admitted requests, so refusals by key do not use the ceiling", () => {
    const limiter = createLimiter(
      { name: "x", limit: 1, windowMs: 1000, globalLimit: 2 },
      { now: () => 0 },
    );
    expect(limiter.hit("a").ok).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(limiter.hit("a").ok).toBe(false);
    expect(limiter.hit("b").ok).toBe(true);
    expect(limiter.hit("c").ok).toBe(false);
  });

  it("does not count a request refused by the ceiling against its own key", () => {
    let now = 0;
    const limiter = createLimiter(
      { name: "x", limit: 2, windowMs: 1000, globalLimit: 1 },
      { now: () => now },
    );
    expect(limiter.hit("a").ok).toBe(true);
    expect(limiter.hit("b").ok).toBe(false);
    expect(limiter.size()).toBe(1);
    now = 1000;
    expect(limiter.hit("b").ok).toBe(true);
    expect(limiter.hit("b").ok).toBe(false);
  });
});

describe("client IP selection (R7.2)", () => {
  it("hops 0 uses the socket even with X-Forwarded-For, and does not read it", async () => {
    for (const forwarded of [[B], ["198.51.100.1, 198.51.100.2"], [A]]) {
      expect(await ipOf(0, { socket: A, forwarded })).toBe(A);
    }
    expect(await ipOf(0, { socket: C, forwarded: [A] })).toBe(C);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("hops 1 uses the rightmost entry; rotating the leftmost does not change it", async () => {
    for (const left of ["198.51.100.1", "198.51.100.2", "not-an-ip", ""]) {
      expect(await ipOf(1, { forwarded: [`${left}, ${B}`] })).toBe(B);
    }
    expect(await ipOf(1, { forwarded: [B] })).toBe(B);
  });

  it("hops 1 as a limiter key: a rotating leftmost value does not give a fresh bucket", async () => {
    const app = limitedApp(1, () => 0);
    for (let i = 0; i < 10; i += 1) {
      const result = await call(app, "/signin", { forwarded: [`198.51.100.${i + 1}, ${B}`] });
      expect(result.status).toBe(200);
    }
    expect((await call(app, "/signin", { forwarded: [`198.51.100.200, ${B}`] })).status).toBe(429);
    expect((await call(app, "/signin", { forwarded: [`198.51.100.200, ${C}`] })).status).toBe(200);
  });

  it("hops N uses the N-th entry from the right", async () => {
    const header = `198.51.100.1, ${B}, ${C}`;
    expect(await ipOf(1, { forwarded: [header] })).toBe(C);
    expect(await ipOf(2, { forwarded: [header] })).toBe(B);
    expect(await ipOf(3, { forwarded: [header] })).toBe("198.51.100.1");
  });

  it("joins two X-Forwarded-For headers", async () => {
    expect(await ipOf(1, { forwarded: ["198.51.100.1", B] })).toBe(B);
    expect(await ipOf(2, { forwarded: ["198.51.100.1", B] })).toBe("198.51.100.1");
  });

  it("accepts the longest valid IP text, 45 characters", async () => {
    const longest = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255";
    expect(longest).toHaveLength(45);
    expect(await ipOf(1, { socket: C, forwarded: [longest] })).toBe(longest);
  });

  it("lowercases an IPv6 entry", async () => {
    expect(await ipOf(1, { forwarded: ["2001:DB8::ABCD"] })).toBe("2001:db8::abcd");
  });

  describe("falls back to the socket (D1)", () => {
    const cases: Array<[string, number, string[] | undefined]> = [
      ["an absent header", 1, undefined],
      ["an empty header", 1, [""]],
      ["fewer entries than hops (2 hops, 1 entry)", 2, [B]],
      ["fewer entries than hops (3 hops, 2 entries)", 3, [`${B}, ${C}`]],
      ["a name instead of an IP", 1, ["unknown"]],
      ["an IP with a port", 1, ["203.0.113.9:443"]],
      ["a bracketed IPv6", 1, ["[2001:db8::1]"]],
      ["an empty trailing entry", 1, [`${B},`]],
      ["an IPv6 with a zone", 1, ["fe80::1%eth0"]],
      ["an entry longer than 45 characters", 1, [`${"1".repeat(46)}`]],
      ["an IPv4 with a leading zero", 1, ["203.000.113.005"]],
    ];
    it.each(cases)("%s", async (_name, hops, forwarded) => {
      expect(await ipOf(hops, { socket: C, forwarded })).toBe(C);
    });

    it("keeps the first entry honest: a spoofed leftmost never wins on a bad selected entry", async () => {
      expect(await ipOf(1, { socket: C, forwarded: [`${B}, garbage`] })).toBe(C);
    });
  });

  it("logs one fixed line per process for the fallback, without any value (hops 1 or more)", async () => {
    vi.resetModules();
    const fresh = await import("../src/auth/rate-limit.js");
    const app = new Hono();
    app.post("/ip", (c) => c.text(fresh.clientIp(c, 1)));
    await call(app, "/ip", { socket: C, forwarded: [`${B}, marker-secret-value`] });
    await call(app, "/ip", { socket: C });
    await call(app, "/ip", { socket: C, forwarded: [""] });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "rate-limit: forwarded entry missing or not an IP; keyed on socket",
    );
  });

  it("does not log when the selected entry is an IP", async () => {
    vi.resetModules();
    const fresh = await import("../src/auth/rate-limit.js");
    const app = new Hono();
    app.post("/ip", (c) => c.text(fresh.clientIp(c, 1)));
    await call(app, "/ip", { socket: C, forwarded: [B] });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not log for hops 0 with no header", async () => {
    vi.resetModules();
    const fresh = await import("../src/auth/rate-limit.js");
    const app = new Hono();
    app.post("/ip", (c) => c.text(fresh.clientIp(c, 0)));
    await call(app, "/ip", { socket: C });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("no socket address (D2)", () => {
  it.each([
    ["no env at all", { noEnv: true }],
    ["a socket without remoteAddress", { socket: null }],
  ] as Array<[string, RequestOptions]>)(
    "%s shares one unknown bucket and still limits",
    async (_n, options) => {
      expect(await ipOf(0, options)).toBe("unknown");
      const app = limitedApp(0, () => 0);
      for (let i = 0; i < 10; i += 1)
        expect((await call(app, "/signin", options)).status).toBe(200);
      expect((await call(app, "/signin", options)).status).toBe(429);
      expect((await call(app, "/signin", { socket: A })).status).toBe(200);
    },
  );

  it("hops 1 with a bad header and no socket shares the unknown bucket", async () => {
    expect(await ipOf(1, { noEnv: true, forwarded: ["garbage"] })).toBe("unknown");
  });
});

describe("rateKey", () => {
  it("maps an IPv4-mapped IPv6 address to the dotted IPv4 key", () => {
    for (const mapped of [
      "::ffff:203.0.113.5",
      "::FFFF:203.0.113.5",
      "0:0:0:0:0:ffff:203.0.113.5",
      "::ffff:cb00:7105",
      "0000:0000:0000:0000:0000:ffff:cb00:7105",
      "::ffff:203.0.113.5%eth0",
    ]) {
      expect(rateKey(mapped)).toBe(rateKey("203.0.113.5"));
    }
    expect(rateKey("203.0.113.5")).toBe("203.0.113.5");
    expect(rateKey("::ffff:203.0.113.250")).toBe("203.0.113.250");
    expect(rateKey("::ffff:c633:64ff")).toBe("198.51.100.255");
  });

  it("gives two different IPv4-mapped addresses two keys", () => {
    expect(rateKey("::ffff:203.0.113.5")).not.toBe(rateKey("::ffff:203.0.113.6"));
  });

  it("canonicalizes IPv6 and groups it to the /64 prefix", () => {
    expect(rateKey("2001:DB8:0:0::1")).toBe(rateKey("2001:db8::1"));
    expect(rateKey("2001:db8::1")).toBe(rateKey("2001:db8::2"));
    expect(rateKey("2001:db8::1")).toBe(rateKey("2001:db8:0:0:ffff:ffff:ffff:ffff"));
    expect(rateKey("2001:db8:0:1::1")).not.toBe(rateKey("2001:db8::1"));
    expect(rateKey("2001:db8:0:0:1::")).toBe(rateKey("2001:db8::"));
    expect(rateKey("2001:db8:0:0::1%eth0")).toBe(rateKey("2001:db8::1"));
  });

  it("never lets an IPv4 client fall into an IPv6 bucket", () => {
    const v6 = rateKey("2001:db8::1");
    for (const v4 of ["203.0.113.5", "198.51.100.7", "0.0.0.1", "32.1.13.184"]) {
      expect(rateKey(v4)).not.toBe(v6);
    }
    expect(rateKey("::1")).not.toBe(rateKey("0.0.0.1"));
    expect(rateKey("::ffff:0:1")).toBe(rateKey("0.0.0.1"));
    expect(rateKey("::1:0:1")).not.toBe(rateKey("0.0.0.1"));
  });

  it("returns a non-IP unchanged", () => {
    expect(rateKey("unknown")).toBe("unknown");
  });

  it("shares a bucket through the middleware", async () => {
    const app = limitedApp(0, () => 0);
    for (let i = 0; i < 5; i += 1) await call(app, "/signin", { socket: "::ffff:203.0.113.5" });
    for (let i = 0; i < 5; i += 1) await call(app, "/signin", { socket: "203.0.113.5" });
    expect((await call(app, "/signin", { socket: "::FFFF:cb00:7105" })).status).toBe(429);
    for (let i = 0; i < 10; i += 1) await call(app, "/signin", { socket: `2001:db8::${i + 1}` });
    expect((await call(app, "/signin", { socket: "2001:db8::ff" })).status).toBe(429);
    expect((await call(app, "/signin", { socket: "2001:db8:0:1::1" })).status).toBe(200);
  });
});

describe("createLimiter memory bounds (D3)", () => {
  const rule = { name: "x", limit: 2, windowMs: 1000 };

  it("drops expired buckets on later hits", () => {
    let now = 0;
    const limiter = createLimiter(rule, { now: () => now });
    expect(limiter.size()).toBe(0);
    limiter.hit("a");
    expect(limiter.size()).toBe(1);
    now = 500;
    limiter.hit("b");
    expect(limiter.size()).toBe(2);
    now = 1000;
    limiter.hit("c");
    expect(limiter.size()).toBe(2);
    now = 1500;
    limiter.hit("c");
    expect(limiter.size()).toBe(1);
  });

  it("never holds more than maxBuckets and evicts the oldest", () => {
    const limiter = createLimiter({ ...rule, limit: 1 }, { now: () => 0, maxBuckets: 2 });
    limiter.hit("a");
    limiter.hit("b");
    limiter.hit("c");
    expect(limiter.size()).toBe(2);
    expect(limiter.hit("b").ok).toBe(false);
    expect(limiter.hit("c").ok).toBe(false);
    expect(limiter.hit("a").ok).toBe(true);
    expect(limiter.size()).toBe(2);
  });

  it("evicts in window-start order after a key is renewed", () => {
    let now = 0;
    const limiter = createLimiter({ ...rule, limit: 1 }, { now: () => now, maxBuckets: 2 });
    limiter.hit("a");
    now = 400;
    limiter.hit("b");
    now = 1000;
    limiter.hit("a");
    now = 1100;
    limiter.hit("c");
    expect(limiter.hit("a").ok).toBe(false);
    expect(limiter.hit("c").ok).toBe(false);
  });

  it("clamps Retry-After to the window length when the clock steps back", () => {
    let now = 100;
    const limiter = createLimiter(rule, { now: () => now });
    limiter.hit("a");
    limiter.hit("a");
    now = 0;
    expect(limiter.hit("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("never refuses an expired bucket that sits behind a live one", () => {
    let now = 500;
    const limiter = createLimiter({ ...rule, limit: 1 }, { now: () => now });
    limiter.hit("a");
    now = 0;
    limiter.hit("b");
    now = 1000;
    expect(limiter.hit("b").ok).toBe(true);
    expect(limiter.hit("b").ok).toBe(false);
    expect(limiter.size()).toBe(2);
  });

  it("holds 10,000 buckets by default", () => {
    const limiter = createLimiter(rule, { now: () => 0 });
    for (let i = 0; i < 10_001; i += 1) limiter.hit(`key-${i}`);
    expect(limiter.size()).toBe(10_000);
  });

  it("uses a monotonic default clock: a wall-clock jump does not reset a window", () => {
    const limiter = createLimiter({ name: "x", limit: 1, windowMs: 60_000 });
    expect(limiter.hit("a").ok).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    expect(limiter.hit("a").ok).toBe(false);
  });

  it("uses the default clock when none is injected", () => {
    const limiter = createLimiter({ name: "x", limit: 1, windowMs: 60_000 });
    expect(limiter.hit("a").ok).toBe(true);
    const refused = limiter.hit("a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});

describe("validation (D5)", () => {
  const rule = { name: "x", limit: 1, windowMs: 1000 };

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rateLimit and clientIp reject trustProxyHops %s",
    async (hops) => {
      expect(() => rateLimit(rule, { trustProxyHops: hops })).toThrow(RangeError);
      const response = await ipApp(hops).request("/ip", { method: "POST" });
      expect(response.status).toBe(500);
    },
  );

  it.each([0, 1, 5])("rateLimit accepts trustProxyHops %i", (hops) => {
    expect(() => rateLimit(rule, { trustProxyHops: hops })).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "createLimiter and rateLimit reject maxBuckets %s",
    (maxBuckets) => {
      expect(() => createLimiter(rule, { maxBuckets })).toThrow(RangeError);
      expect(() => rateLimit(rule, { trustProxyHops: 0, maxBuckets })).toThrow(RangeError);
    },
  );

  it("accepts maxBuckets 1", () => {
    expect(() => createLimiter(rule, { maxBuckets: 1 })).not.toThrow();
  });

  it.each([
    ["limit 0", { ...rule, limit: 0 }],
    ["limit 1.5", { ...rule, limit: 1.5 }],
    ["windowMs 0", { ...rule, windowMs: 0 }],
    ["windowMs NaN", { ...rule, windowMs: Number.NaN }],
    ["globalLimit 0", { ...rule, globalLimit: 0 }],
    ["globalLimit -1", { ...rule, globalLimit: -1 }],
  ])("createLimiter rejects %s", (_name, bad) => {
    expect(() => createLimiter(bad)).toThrow(RangeError);
  });

  it("names the field and never a value in the message", () => {
    expect(() => createLimiter({ ...rule, limit: 1.5 })).toThrow(/limit/);
  });
});
