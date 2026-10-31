import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthorizeParams,
  checkAuthorizeRequest,
  escapeHtml,
  matchRedirectUri,
} from "../src/auth/oauth/authorize.js";
import { type AuthStore, newId, openAuthStore } from "../src/auth/oauth/store.js";
import { createPublicApp } from "../src/mcp/app.js";

const RESOURCE = "https://brain.example.com/mcp";
const HOSTS = ["claude.ai", "claude.com"];
const CHALLENGE = "A".repeat(43);
const URI = "https://claude.ai/api/mcp/auth_callback";
const LOOP = "http://127.0.0.1:1234/cb";

const roots: string[] = [];
const stores: AuthStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function harness(hosts: readonly string[] = HOSTS, withAuth = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-authorize-")));
  roots.push(root);
  mkdirSync(join(root, "vault"));
  const store = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    log: () => undefined,
  });
  stores.push(store);
  const make = (allowed: readonly string[]) =>
    createPublicApp({
      baseUrl: "https://brain.example.com",
      log: () => undefined,
      auth: withAuth ? { store, allowedRedirectHosts: allowed, trustProxyHops: 0 } : undefined,
    }).app;
  const app = make(hosts);
  async function client(redirectUris: string[], name?: string): Promise<string> {
    const id = newId();
    await store.update((tx) => tx.putClient(id, { authMethod: "none", redirectUris, name }));
    return id;
  }
  return { store, app, make, client };
}

function query(pairs: [string, string][]): string {
  return `/authorize?${new URLSearchParams(pairs).toString()}`;
}

function good(clientId: string, extra: Record<string, string> = {}): [string, string][] {
  const base: Record<string, string> = {
    client_id: clientId,
    redirect_uri: URI,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st1",
    ...extra,
  };
  return Object.entries(base).filter(([, v]) => v !== "\u0000");
}

function without(pairs: [string, string][], key: string): [string, string][] {
  return pairs.filter(([k]) => k !== key);
}

function expectPageHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).not.toContain("script-src");
}

describe("GET /authorize: sign-in page (R4.1, R4.6)", () => {
  it("answers 200 HTML naming the client and the redirect host", async () => {
    const h = await harness();
    const id = await h.client([URI], "Example Client");
    const res = await h.app.request(query(good(id)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expectPageHeaders(res);
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://claude.ai",
    );
    const body = await res.text();
    expect(body).toContain("Example Client");
    expect(body).toContain("<strong>claude.ai</strong>");
    expect(body).toContain(URI);
    expect(body).toMatch(/<form method="post" action="\/authorize">/);
    expect(body).toContain('type="password" name="passphrase"');
    expect(body).not.toContain("<script");
    for (const [name, value] of [
      ["client_id", id],
      ["redirect_uri", URI],
      ["response_type", "code"],
      ["code_challenge", CHALLENGE],
      ["code_challenge_method", "S256"],
      ["state", "st1"],
    ] as const) {
      expect(body).toContain(`<input type="hidden" name="${name}" value="${value}">`);
    }
    expect(body).not.toContain('name="resource"');
  });

  it("carries resource only when given, and accepts several equal values", async () => {
    const h = await harness();
    const id = await h.client([URI]);
    const given = await h.app.request(query([...good(id), ["resource", RESOURCE]]));
    expect(given.status).toBe(200);
    expect(await given.text()).toContain(`name="resource" value="${RESOURCE}"`);
    const twice = await h.app.request(
      query([...good(id), ["resource", RESOURCE], ["resource", RESOURCE]]),
    );
    expect(twice.status).toBe(200);
  });

  it("treats an empty state as absent", async () => {
    const h = await harness();
    const id = await h.client([URI]);
    const res = await h.app.request(query(good(id, { state: "" })));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('name="state"');
  });

  it("omits an unrepresentable [::1] origin from form-action", async () => {
    const h = await harness();
    const id = await h.client(["http://[::1]:1234/cb"]);
    const res = await h.app.request(query(good(id, { redirect_uri: "http://[::1]:9/cb" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("content-security-policy")).not.toContain("[::1]");
  });
});

describe("GET /authorize: redirect URI matching", () => {
  it("accepts another port for a registered loopback http URI and shows it", async () => {
    const h = await harness();
    const id = await h.client([LOOP]);
    const res = await h.app.request(query(good(id, { redirect_uri: "http://127.0.0.1:5678/cb" })));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<strong>127.0.0.1:5678</strong>");
    expect(body).toContain('name="redirect_uri" value="http://127.0.0.1:5678/cb"');
    expect(res.headers.get("content-security-policy")).toContain("http://127.0.0.1:5678");
    const noPort = await h.app.request(query(good(id, { redirect_uri: "http://127.0.0.1/cb" })));
    expect(noPort.status).toBe(200);
  });

  it("accepts another port for [::1]", async () => {
    const h = await harness();
    const id = await h.client(["http://[::1]:1234/cb"]);
    const res = await h.app.request(query(good(id, { redirect_uri: "http://[::1]:99/cb" })));
    expect(res.status).toBe(200);
  });

  it.each([
    ["other path", LOOP, "http://127.0.0.1:5678/other"],
    ["localhost vs 127.0.0.1", LOOP, "http://localhost:5678/cb"],
    ["https other port", URI, "https://claude.ai:8443/api/mcp/auth_callback"],
    ["trailing slash", URI, `${URI}/`],
    ["case", URI, "https://Claude.ai/api/mcp/auth_callback"],
    ["uppercase scheme", URI, "HTTPS://claude.ai/api/mcp/auth_callback"],
    ["dot segments", URI, "https://claude.ai/a/../api/mcp/auth_callback"],
    ["non-canonical loopback", LOOP, "http://127.0.0.1:5678/a/../cb"],
    ["fragment", URI, `${URI}#frag`],
    ["credentials", URI, "https://u:p@claude.ai/api/mcp/auth_callback"],
    ["unparseable", URI, "not a url"],
  ])("answers the 400 page for %s", async (_label, registered, requested) => {
    const h = await harness();
    const id = await h.client([registered]);
    const res = await h.app.request(query(good(id, { redirect_uri: requested })));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("matchRedirectUri exact and port rules", () => {
    expect(matchRedirectUri(URI, [URI])).toBe(URI);
    expect(matchRedirectUri(URI, ["https://claude.ai/x"])).toBeUndefined();
    expect(matchRedirectUri("http://127.0.0.1:2/cb", [LOOP])).toBe("http://127.0.0.1:2/cb");
    expect(matchRedirectUri("https://claude.ai:2/cb", ["https://claude.ai/cb"])).toBeUndefined();
  });

  it("answers the 400 page when the host is no longer allowed (D4)", async () => {
    const h = await harness();
    const id = await h.client([URI]);
    const narrowed = h.make(["claude.com"]);
    const res = await narrowed.request(query(good(id)));
    expect(res.status).toBe(400);
  });

  it("shows a percent-encoded bidi path as encoded (D3)", async () => {
    const h = await harness();
    const uri = "https://claude.ai/cb%E2%80%AE";
    const id = await h.client([uri]);
    const res = await h.app.request(query(good(id, { redirect_uri: uri })));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("cb%E2%80%AE");
    expect(body).not.toContain("‮");
  });
});

describe("GET /authorize: 400 page (R4.2)", () => {
  it("is fixed, without Location or echoed values, for every client and URI failure", async () => {
    const h = await harness();
    const id = await h.client([URI]);
    const secretish = "zzz-unique-value";
    const cases: [string, [string, string][]][] = [
      ["unknown client", good(`${secretish}-client`)],
      ["missing client", without(good(id), "client_id")],
      ["duplicated client", [...good(id), ["client_id", id]]],
      ["missing redirect", without(good(id), "redirect_uri")],
      ["duplicated redirect", [...good(id), ["redirect_uri", URI]]],
      ["unregistered", good(id, { redirect_uri: `https://claude.ai/${secretish}` })],
      ["fragment", good(id, { redirect_uri: `${URI}#${secretish}` })],
    ];
    const bodies = new Set<string>();
    for (const [label, pairs] of cases) {
      const res = await h.app.request(query(pairs));
      expect(res.status, label).toBe(400);
      expect(res.headers.get("location"), label).toBeNull();
      expectPageHeaders(res);
      expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
      const body = await res.text();
      expect(body).not.toContain(secretish);
      expect(body).not.toContain(id);
      expect(body).not.toContain("claude.ai");
      bodies.add(body);
    }
    expect(bodies.size).toBe(1);
  });
});

describe("GET /authorize: redirect errors (R4.3)", () => {
  async function failing(pairs: (id: string) => [string, string][]) {
    const h = await harness();
    const id = await h.client([URI]);
    const res = await h.app.request(query(pairs(id)));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const url = new URL(res.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(URI);
    return url;
  }

  it.each([
    ["missing code_challenge", (p: [string, string][]) => without(p, "code_challenge")],
    ["missing method", (p: [string, string][]) => without(p, "code_challenge_method")],
    ["missing response_type", (p: [string, string][]) => without(p, "response_type")],
    [
      "plain",
      (p: [string, string][]) => [
        ...without(p, "code_challenge_method"),
        ["code_challenge_method", "plain"] as [string, string],
      ],
    ],
    [
      "42 char challenge",
      (p: [string, string][]) => [
        ...without(p, "code_challenge"),
        ["code_challenge", "A".repeat(42)] as [string, string],
      ],
    ],
    [
      "bad alphabet",
      (p: [string, string][]) => [
        ...without(p, "code_challenge"),
        ["code_challenge", `${"A".repeat(42)}+`] as [string, string],
      ],
    ],
    [
      "duplicated challenge",
      (p: [string, string][]) => [...p, ["code_challenge", CHALLENGE] as [string, string]],
    ],
    [
      "duplicated response_type",
      (p: [string, string][]) => [...p, ["response_type", "code"] as [string, string]],
    ],
    ["duplicated state", (p: [string, string][]) => [...p, ["state", "b"] as [string, string]]],
  ])("invalid_request for %s", async (_label, mutate) => {
    const url = await failing((id) => mutate(good(id)));
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("error_description")).toBe("The authorization request is invalid");
  });

  it("echoes state when it is a single value", async () => {
    const url = await failing((id) => without(good(id), "code_challenge"));
    expect(url.searchParams.get("state")).toBe("st1");
  });

  it("omits state when absent, empty, duplicated or over the cap", async () => {
    const none = await failing((id) => without(without(good(id), "code_challenge"), "state"));
    expect(none.searchParams.has("state")).toBe(false);
    const empty = await failing((id) => without(good(id, { state: "" }), "code_challenge"));
    expect(empty.searchParams.has("state")).toBe(false);
    const long = await failing((id) => good(id, { state: "s".repeat(2049) }));
    expect(long.searchParams.get("error")).toBe("invalid_request");
    expect(long.searchParams.has("state")).toBe(false);
    const edge = await failing((id) =>
      without(good(id, { state: "s".repeat(2048) }), "code_challenge"),
    );
    expect(edge.searchParams.get("state")).toHaveLength(2048);
    const twice = await failing((id) => [...good(id), ["state", "b"]]);
    expect(twice.searchParams.get("error")).toBe("invalid_request");
    expect(twice.searchParams.has("state")).toBe(false);
  });

  it("appends after a bare question mark without a second separator", async () => {
    const h = await harness();
    const registered = "https://claude.ai/cb?";
    const id = await h.client([registered]);
    const res = await h.app.request(
      query(without(good(id, { redirect_uri: registered }), "code_challenge")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/claude\.ai\/cb\?error=/);
  });

  it("unsupported_response_type for token", async () => {
    const url = await failing((id) => good(id, { response_type: "token" }));
    expect(url.searchParams.get("error")).toBe("unsupported_response_type");
    expect(url.searchParams.get("error_description")).toBe(
      "Only the code response type is supported",
    );
  });

  it.each(["https://other.example.com/mcp", `${RESOURCE}/`])(
    "invalid_target for resource %s",
    async (resource) => {
      const url = await failing((id) => [...good(id), ["resource", resource]]);
      expect(url.searchParams.get("error")).toBe("invalid_target");
      expect(url.searchParams.get("error_description")).toBe(
        "The resource is not served by this server",
      );
    },
  );

  it("invalid_target when one of several resource values differs", async () => {
    const url = await failing((id) => [
      ...good(id),
      ["resource", RESOURCE],
      ["resource", "https://other.example.com/mcp"],
    ]);
    expect(url.searchParams.get("error")).toBe("invalid_target");
  });

  it("keeps a registered query byte for byte", async () => {
    const h = await harness();
    const registered = "https://claude.ai/cb?x=a%20b";
    const id = await h.client([registered]);
    const res = await h.app.request(
      query(without(good(id, { redirect_uri: registered }), "code_challenge")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/claude\.ai\/cb\?x=a%20b&error=/);
  });
});

describe("GET /authorize: escaping (D1)", () => {
  it("escapes the client name, state and the URI", async () => {
    const h = await harness();
    const id = await h.client([URI], "<script>alert(1)</script>");
    const res = await h.app.request(query(good(id, { state: '"><img src=x>' })));
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script");
    expect(body).toContain('name="state" value="&quot;&gt;&lt;img src=x&gt;"');
    expect(body).not.toContain("<img");
  });

  it("strips bidi and control characters from the name and labels it self-declared", async () => {
    const h = await harness();
    const id = await h.client([URI], "Acme‮\u0007Corp");
    const body = await (await h.app.request(query(good(id)))).text();
    expect(body).toContain("AcmeCorp");
    expect(body).not.toContain("‮");
    expect(body).toContain("self-declared");
  });

  it("names a client without a name as unnamed", async () => {
    const h = await harness();
    const id = await h.client([URI]);
    expect(await (await h.app.request(query(good(id)))).text()).toContain("An unnamed client");
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("checkAuthorizeRequest export (D2)", () => {
  it("takes a parameter map", async () => {
    const h = await harness();
    const id = await h.client([URI], "N");
    const deps = { store: h.store, allowedRedirectHosts: HOSTS };
    const map: AuthorizeParams = {
      client_id: [id],
      redirect_uri: [URI],
      response_type: ["code"],
      code_challenge: [CHALLENGE],
      code_challenge_method: ["S256"],
    };
    const ok = checkAuthorizeRequest(map, RESOURCE, deps);
    expect(ok).toMatchObject({
      kind: "ok",
      request: {
        clientId: id,
        clientName: "N",
        redirectUri: URI,
        resource: RESOURCE,
        resourceGiven: false,
      },
    });
    expect(checkAuthorizeRequest({ ...map, client_id: ["nope"] }, RESOURCE, deps)).toEqual({
      kind: "page_error",
    });
    expect(checkAuthorizeRequest({ ...map, response_type: ["x"] }, RESOURCE, deps)).toEqual({
      kind: "redirect_error",
      redirectUri: URI,
      error: "unsupported_response_type",
    });
  });
});

describe("routing", () => {
  it("answers 404 to POST /authorize for now", async () => {
    const h = await harness();
    const res = await h.app.request("/authorize", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("answers 404 to GET /authorize without auth", async () => {
    const h = await harness(HOSTS, false);
    const res = await h.app.request("/authorize");
    expect(res.status).toBe(404);
  });
});
