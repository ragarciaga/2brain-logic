import { describe, expect, it } from "vitest";
import { buildPublicUrls, createPublicApp, PUBLIC_PATHS } from "../src/mcp/app.js";

const BASE = "https://brain.example.com";
const INGEST_LIKE_TOKEN = "fictional-ingest-like-token-0123456789-abcdef";

describe("buildPublicUrls", () => {
  it("R1.4: builds the seven advertised URLs from the base", () => {
    expect(buildPublicUrls(BASE)).toEqual({
      issuer: "https://brain.example.com",
      resource: "https://brain.example.com/mcp",
      resourceMetadata: "https://brain.example.com/.well-known/oauth-protected-resource/mcp",
      authorizationEndpoint: "https://brain.example.com/authorize",
      tokenEndpoint: "https://brain.example.com/token",
      registrationEndpoint: "https://brain.example.com/register",
      revocationEndpoint: "https://brain.example.com/revoke",
    });
  });

  it("derives each endpoint path from the PUBLIC_PATHS table", () => {
    const urls = buildPublicUrls(BASE);
    expect(new URL(urls.resource).pathname).toBe(PUBLIC_PATHS.mcp);
    expect(new URL(urls.resourceMetadata).pathname).toBe(PUBLIC_PATHS.protectedResourceMetadata);
    expect(new URL(urls.authorizationEndpoint).pathname).toBe(PUBLIC_PATHS.authorize);
    expect(new URL(urls.tokenEndpoint).pathname).toBe(PUBLIC_PATHS.token);
    expect(new URL(urls.registrationEndpoint).pathname).toBe(PUBLIC_PATHS.register);
    expect(new URL(urls.revocationEndpoint).pathname).toBe(PUBLIC_PATHS.revoke);
    expect(Object.isFrozen(PUBLIC_PATHS)).toBe(true);
  });

  it("does not double the slash for a base with a trailing slash", () => {
    expect(buildPublicUrls(`${BASE}/`)).toEqual(buildPublicUrls(BASE));
    expect(buildPublicUrls(`${BASE}/`).resource).toBe("https://brain.example.com/mcp");
  });

  it("keeps a non-default port in every URL", () => {
    const urls = buildPublicUrls("http://127.0.0.1:8080");
    expect(urls.issuer).toBe("http://127.0.0.1:8080");
    expect(urls.resource).toBe("http://127.0.0.1:8080/mcp");
    expect(urls.tokenEndpoint).toBe("http://127.0.0.1:8080/token");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(buildPublicUrls(BASE))).toBe(true);
  });

  it("takes exactly one input, the base URL", () => {
    expect(buildPublicUrls.length).toBe(1);
  });
});

describe("createPublicApp", () => {
  it("exposes the same URLs as buildPublicUrls", () => {
    expect(createPublicApp({ baseUrl: BASE }).urls).toEqual(buildPublicUrls(BASE));
  });

  it("R1.4: a handler sees the configured URLs for a request with forged Host and forwarded headers", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    app.get("/probe", (c) => c.json(c.var.urls));
    const response = await app.request("http://evil.example.net/probe", {
      headers: {
        host: "evil.example.net",
        "x-forwarded-host": "evil.example.net",
        "x-forwarded-proto": "http",
      },
    });
    expect(response.status).toBe(200);
    const seen = (await response.json()) as Record<string, string>;
    expect(seen).toEqual({ ...buildPublicUrls(BASE) });
    expect(Object.values(seen).join(" ")).not.toContain("evil");
  });

  it("registers the URL context before any later route", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    app.get("/issuer", (c) => c.text(c.var.urls.issuer));
    const response = await app.request("/issuer");
    expect(await response.text()).toBe(BASE);
  });

  const paths: Array<[string, string]> = [
    ["POST", "/notes"],
    ["PATCH", "/notes"],
    ["POST", "/notes/archive"],
    ["GET", "/health"],
    ["GET", "/no-such-path"],
  ];

  for (const [method, path] of paths) {
    it(`answers 404, never 401, for ${method} ${path} without a token`, async () => {
      const { app } = createPublicApp({ baseUrl: BASE });
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
      expect((await response.text()).toLowerCase()).not.toContain("unauthorized");
    });

    it(`answers 404, never 401, for ${method} ${path} with an ingest-like bearer`, async () => {
      const { app } = createPublicApp({ baseUrl: BASE });
      const response = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${INGEST_LIKE_TOKEN}` },
      });
      expect(response.status).toBe(404);
      expect((await response.text()).toLowerCase()).not.toContain("unauthorized");
    });
  }
});

describe("D1: the error handler", () => {
  const MARKER = "ERRMARKER-secret";

  function appWithLog() {
    const lines: string[] = [];
    const { app } = createPublicApp({ baseUrl: BASE, log: (line) => lines.push(line) });
    return { app, lines };
  }

  async function expectGeneric500(response: Response, lines: string[]): Promise<void> {
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "server_error" });
    expect(text).not.toContain(MARKER);
    expect(lines).toEqual(["mcp: internal_error"]);
  }

  it("answers a synchronous throw with the generic 500 and one log line", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom", () => {
      throw new Error(MARKER);
    });
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("answers an asynchronous rejection with the generic 500 and one log line", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom", async () => {
      await Promise.resolve();
      throw new Error(MARKER);
    });
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("answers a throw in a later middleware with the generic 500 and one log line", async () => {
    const { app, lines } = appWithLog();
    app.use("/boom", async () => {
      throw new Error(MARKER);
    });
    app.get("/boom", (c) => c.text("unreachable"));
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("answers a thrown string, which is not an Error, with the generic 500", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom", () => {
      throw MARKER;
    });
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("answers a thrown object, which is not an Error, with the generic 500", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom", () => {
      throw { message: MARKER };
    });
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("does not let a thrown HTTPException choose the status or the body", async () => {
    const { HTTPException } = await import("hono/http-exception");
    const { app, lines } = appWithLog();
    app.get("/boom", () => {
      throw new HTTPException(418, { message: MARKER });
    });
    await expectGeneric500(await app.request("/boom"), lines);
  });

  it("sends exactly two headers: nothing set before the throw rides along", async () => {
    const { app, lines } = appWithLog();
    app.use("/boom", async (c, next) => {
      c.header("Location", "https://evil.example.net/");
      c.header("Set-Cookie", "session=leak");
      c.header("WWW-Authenticate", "Bearer realm=leak");
      await next();
    });
    app.get("/boom", (c) => {
      c.header("X-Leak", MARKER);
      throw new Error(MARKER);
    });
    const response = await app.request("/boom");
    await expectGeneric500(response, lines);
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("sends exactly two headers when a middleware throws after the handler already answered", async () => {
    const { app, lines } = appWithLog();
    app.use("/boom", async (_c, next) => {
      await next();
      throw new Error(MARKER);
    });
    app.get("/boom", (c) => {
      c.header("Location", "https://evil.example.net/");
      c.header("Set-Cookie", "session=leak");
      c.header("WWW-Authenticate", "Bearer realm=leak");
      return c.json({ leak: MARKER }, 302);
    });
    const response = await app.request("/boom");
    await expectGeneric500(response, lines);
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });

  it("keeps the handler working after a failed request", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom", () => {
      throw new Error(MARKER);
    });
    await app.request("/boom");
    const ok = await app.request("/.well-known/oauth-authorization-server");
    expect(ok.status).toBe(200);
    expect(lines).toEqual(["mcp: internal_error"]);
  });

  it("logs to console.error by default, with the same single line", async () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const { app } = createPublicApp({ baseUrl: BASE });
      app.get("/boom", () => {
        throw new Error(MARKER);
      });
      const response = await app.request("/boom");
      expect(response.status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(calls).toEqual([["mcp: internal_error"]]);
  });
});
