import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ingestTokenAuth, isAuthorizedHeader } from "../src/auth/ingest-token.js";
import { createApp } from "../src/server/app.js";

const TOKEN = "fictional-auth-token-0123456789-abcdefghij";
const tokenDigest = createHash("sha256").update(TOKEN, "utf8").digest();

describe("isAuthorizedHeader", () => {
  it.each([
    ["Bearer scheme", `Bearer ${TOKEN}`],
    ["lowercase bearer scheme", `bearer ${TOKEN}`],
    ["uppercase BEARER scheme", `BEARER ${TOKEN}`],
  ])("accepts the %s", (_name, header) => {
    expect(isAuthorizedHeader(header, tokenDigest)).toBe(true);
  });

  const rejected: Array<[string, string | undefined]> = [
    ["an undefined header", undefined],
    ["an empty header", ""],
    ["the scheme alone", "Bearer"],
    ["the scheme and a space", "Bearer "],
    ["the Basic scheme", `Basic ${TOKEN}`],
    ["the Token scheme", `Token ${TOKEN}`],
    ["the bare token", TOKEN],
    ["the last character changed", `Bearer ${TOKEN.slice(0, -1)}X`],
    ["an extra character", `Bearer ${TOKEN}X`],
    ["a missing character", `Bearer ${TOKEN.slice(0, -1)}`],
    ["two spaces", `Bearer  ${TOKEN}`],
    ["a trailing space", `Bearer ${TOKEN} `],
  ];

  it.each(rejected)("rejects %s", (_name, header) => {
    expect(isAuthorizedHeader(header, tokenDigest)).toBe(false);
  });
});

describe("ingestTokenAuth", () => {
  it("throws for a 31-character token without echoing it", () => {
    const token = "SHORTMARKER".padEnd(31, "x");
    expect(token).toHaveLength(31);
    let message = "";
    try {
      ingestTokenAuth(token);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/at least 32 characters/);
    expect(message).not.toContain("SHORTMARKER");
  });

  it("accepts a 32-character token", () => {
    expect(() => ingestTokenAuth("x".repeat(32))).not.toThrow();
  });
});

function setup() {
  const writer = {
    write: vi.fn(async () => ({ path: "x.md", commit: "abc" })),
    patch: vi.fn(async () => ({ path: "x.md", commit: "abc" })),
    archive: vi.fn(async () => ({ path: "archive/x.md", commit: "abc" })),
  };
  const app = createApp({ writer, ingestToken: TOKEN, log: () => undefined });
  return { app, writer };
}

const valid = JSON.stringify({ path: "Inbox/idea.md", frontmatter: {}, body: "text\n" });

describe("token check through createApp", () => {
  const headers: Array<[string, Record<string, string>]> = [
    ["no header", {}],
    ["a Basic scheme", { authorization: `Basic ${TOKEN}` }],
    ["a wrong token of the same length", { authorization: `Bearer ${TOKEN.slice(0, -1)}X` }],
    ["a token of a different length", { authorization: "Bearer short" }],
    ["an empty credential", { authorization: "Bearer " }],
  ];
  const routes = ["/notes", "/unknown"];
  const cases = routes.flatMap((route) =>
    headers.map(([name, extra]) => [route, name, extra] as const),
  );

  it.each(cases)("POST %s with %s returns 401 and calls no writer", async (route, _name, extra) => {
    const { app, writer } = setup();
    const response = await app.request(route, {
      method: "POST",
      body: valid,
      headers: { "content-type": "application/json", ...extra },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("answers 401 for an unknown GET route and a non-GET /health without a token", async () => {
    const { app } = setup();
    expect((await app.request("/unknown")).status).toBe(401);
    expect((await app.request("/health", { method: "POST" })).status).toBe(401);
  });

  it("lets an authorized request reach the router: unknown route 404, POST /notes 201", async () => {
    const { app, writer } = setup();
    const authorization = `Bearer ${TOKEN}`;
    const unknown = await app.request("/unknown", { method: "POST", headers: { authorization } });
    expect(unknown.status).toBe(404);
    const created = await app.request("/notes", {
      method: "POST",
      body: valid,
      headers: { "content-type": "application/json", authorization },
    });
    expect(created.status).toBe(201);
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it("serves GET /health without a header and with a wrong one", async () => {
    const { app } = setup();
    for (const headers of [undefined, { authorization: "Bearer wrong" }]) {
      const response = await app.request("/health", { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
  });
});
