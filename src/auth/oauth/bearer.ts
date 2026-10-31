import type { AuthInfo } from "@modelcontextprotocol/server";
import type { PublicUrls } from "../../mcp/app.js";
import type { StoreReads } from "./store.js";

/**
 * The checks in front of `/mcp` (R2.1, R6.2, R6.3): the Origin allowlist, the `Authorization`
 * header parse, the token lookup and the fixed 401 and 403 answers.
 *
 * - Pure functions: the route in `src/mcp/server.ts` decides the order. The Origin check runs
 *   before the token lookup.
 * - A token is looked up only through `StoreReads.findGrantByAccessToken`, which compares hashes.
 * - Every body and header here is a fixed string. No token, header value or URL from the request
 *   reaches a response.
 * - `authInfo.token` is the grant id, never the bearer value, so nothing downstream can leak it.
 */

/** The fixed JSON bodies of the 401 and 403 answers. */
export const MCP_AUTH_BODIES = Object.freeze({
  unauthorized: '{"error":"unauthorized"}',
  invalidToken: '{"error":"invalid_token"}',
  forbiddenOrigin: '{"error":"forbidden_origin"}',
});

const MAX_TOKEN_LENGTH = 512;
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The Origins a browser may send: the public origin and `https://` plus each redirect host. */
export function allowedMcpOrigins(issuer: string, hosts: readonly string[]): ReadonlySet<string> {
  return new Set([issuer, ...hosts.map((host) => `https://${host}`)]);
}

/** A missing Origin passes (not a browser); anything else must be an exact member. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}

export type BearerCheck = { ok: true; authInfo: AuthInfo } | { ok: false; invalidToken: boolean };

/**
 * `invalidToken: false` when no Bearer credentials were sent; `true` when some were and they are
 * malformed, unknown, expired, revoked or issued for another resource.
 */
export function checkBearer(
  authorization: string | undefined,
  store: StoreReads,
  urls: PublicUrls,
): BearerCheck {
  if (authorization === undefined) return { ok: false, invalidToken: false };
  const space = authorization.indexOf(" ");
  const scheme = space === -1 ? authorization : authorization.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return { ok: false, invalidToken: false };
  const token = space === -1 ? "" : authorization.slice(space).replace(/^ +/, "");
  if (token === "" || token.length > MAX_TOKEN_LENGTH || !TOKEN68.test(token)) {
    return { ok: false, invalidToken: true };
  }
  const found = store.findGrantByAccessToken(token);
  if (found === undefined || found.state !== "live" || found.grant.resource !== urls.resource) {
    return { ok: false, invalidToken: true };
  }
  return {
    ok: true,
    authInfo: {
      token: found.id,
      clientId: found.grant.clientId,
      scopes: [],
      expiresAt: Math.floor(Date.parse(found.grant.accessExpiresAt) / 1000),
      resource: new URL(urls.resource),
      resourceMetadataUrl: urls.resourceMetadata,
    },
  };
}

/** The 401 with the exact challenge of R2.1. */
export function bearerChallenge(urls: PublicUrls, invalidToken: boolean): Response {
  const base = `Bearer resource_metadata="${urls.resourceMetadata}"`;
  return new Response(invalidToken ? MCP_AUTH_BODIES.invalidToken : MCP_AUTH_BODIES.unauthorized, {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": invalidToken ? `${base}, error="invalid_token"` : base,
    },
  });
}

/** The 403 for an Origin outside the allowlist. */
export function forbiddenOrigin(): Response {
  return new Response(MCP_AUTH_BODIES.forbiddenOrigin, {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
