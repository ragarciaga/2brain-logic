import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  CLIENT_AUTH_METHODS,
  protectedResourceMetadata,
} from "../src/auth/oauth/metadata.js";
import { buildPublicUrls, createPublicApp, PUBLIC_PATHS } from "../src/mcp/app.js";

const BASE = "https://brain.example.com";
const OTHER_BASE = "http://127.0.0.1:8080";

const PRM_PATHS = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
];
const AS_PATH = "/.well-known/oauth-authorization-server";
const DISCOVERY_PATHS = [...PRM_PATHS, AS_PATH];

const METHODS = ["none", "client_secret_post", "client_secret_basic"];

function expectedPrm(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  };
}

function expectedAs(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: METHODS,
    revocation_endpoint_auth_methods_supported: METHODS,
  };
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** The strings that are URLs (they contain a scheme separator). */
function urlStrings(value: unknown): string[] {
  return strings(value).filter((s) => s.includes("://"));
}

describe("R2.2: protected resource metadata", () => {
  for (const path of PRM_PATHS) {
    it(`GET ${path} returns the exact document as JSON`, async () => {
      const { app } = createPublicApp({ baseUrl: BASE });
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual(expectedPrm(BASE));
    });
  }

  it("names the issuer of the authorization server document as its authorization server", async () => {
    const { app, urls } = createPublicApp({ baseUrl: BASE });
    const prm = (await (await app.request(PRM_PATHS[0] as string)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    const as = (await (await app.request(AS_PATH)).json()) as { issuer: string };
    expect(prm.authorization_servers[0]).toBe(as.issuer);
    expect(prm.resource).toBe(urls.resource);
  });

  it("serves the same document at both paths", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    const [first, second] = await Promise.all(
      PRM_PATHS.map(async (p) => (await app.request(p)).json()),
    );
    expect(first).toEqual(second);
  });
});

describe("R2.3: authorization server metadata", () => {
  it("returns the exact document as JSON", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    const response = await app.request(AS_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(expectedAs(BASE));
  });

  it("lists exactly the three client auth methods, in one exported constant", () => {
    expect([...CLIENT_AUTH_METHODS]).toEqual(METHODS);
    expect(Object.isFrozen(CLIENT_AUTH_METHODS)).toBe(true);
  });

  it("uses the PUBLIC_PATHS table for the four endpoints", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    const doc = (await (await app.request(AS_PATH)).json()) as Record<string, string>;
    expect(new URL(doc.authorization_endpoint as string).pathname).toBe(PUBLIC_PATHS.authorize);
    expect(new URL(doc.token_endpoint as string).pathname).toBe(PUBLIC_PATHS.token);
    expect(new URL(doc.registration_endpoint as string).pathname).toBe(PUBLIC_PATHS.register);
    expect(new URL(doc.revocation_endpoint as string).pathname).toBe(PUBLIC_PATHS.revoke);
  });
});

describe("the route bodies equal the pure builders", () => {
  it("builds both documents from the URLs of the app", async () => {
    const { app, urls } = createPublicApp({ baseUrl: BASE });
    for (const path of PRM_PATHS) {
      expect(await (await app.request(path)).json()).toEqual(protectedResourceMetadata(urls));
    }
    expect(await (await app.request(AS_PATH)).json()).toEqual(authorizationServerMetadata(urls));
  });

  it("the builders take their URLs from the argument only", () => {
    const urls = buildPublicUrls(OTHER_BASE);
    expect(protectedResourceMetadata(urls)).toEqual(expectedPrm(OTHER_BASE));
    expect(authorizationServerMetadata(urls)).toEqual(expectedAs(OTHER_BASE));
  });
});

describe("R1.4: the documents ignore the request origin", () => {
  const forged = {
    host: "evil.example.net",
    "x-forwarded-host": "evil.example.net",
    "x-forwarded-proto": "http",
  };

  for (const base of [BASE, OTHER_BASE]) {
    for (const path of DISCOVERY_PATHS) {
      it(`GET ${path} on ${base}: every URL starts with the base, none names the forged host`, async () => {
        const { app } = createPublicApp({ baseUrl: base });
        const response = await app.request(`http://evil.example.net${path}`, { headers: forged });
        expect(response.status).toBe(200);
        const text = await response.text();
        const body = JSON.parse(text) as unknown;
        const urls = urlStrings(body);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) expect(url.startsWith(base)).toBe(true);
        expect(text).not.toContain("evil");
        expect(body).toEqual(path === AS_PATH ? expectedAs(base) : expectedPrm(base));
      });
    }
  }
});

describe("what is not served", () => {
  it("answers 404 to POST on the authorization server path", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    expect((await app.request(AS_PATH, { method: "POST" })).status).toBe(404);
  });

  it("answers 404 for OpenID discovery", async () => {
    const { app } = createPublicApp({ baseUrl: BASE });
    expect((await app.request("/.well-known/openid-configuration")).status).toBe(404);
  });
});
