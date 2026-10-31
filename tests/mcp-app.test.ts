import { describe, expect, it } from "vitest";
import { buildPublicUrls, createPublicApp } from "../src/mcp/app.js";

const BASE = "https://brain.example.com";
const INGEST_LIKE_TOKEN = "fictional-ingest-like-token-0123456789-abcdef";

describe("buildPublicUrls", () => {
  it("R1.4: builds issuer, resource and resource metadata URL from the base", () => {
    expect(buildPublicUrls(BASE)).toEqual({
      issuer: "https://brain.example.com",
      resource: "https://brain.example.com/mcp",
      resourceMetadata: "https://brain.example.com/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("does not double the slash for a base with a trailing slash", () => {
    expect(buildPublicUrls(`${BASE}/`)).toEqual(buildPublicUrls(BASE));
    expect(buildPublicUrls(`${BASE}/`).resource).toBe("https://brain.example.com/mcp");
  });

  it("keeps a non-default port in every URL", () => {
    const urls = buildPublicUrls("http://127.0.0.1:8080");
    expect(urls.issuer).toBe("http://127.0.0.1:8080");
    expect(urls.resource).toBe("http://127.0.0.1:8080/mcp");
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
