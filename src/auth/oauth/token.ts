import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PUBLIC_PATHS, type PublicAppEnv } from "../../mcp/app.js";
import { RATE_RULES, rateLimit } from "../rate-limit.js";
import type { CodeStore } from "./codes.js";
import { type AuthStore, type ClientAuthMethod, newId, type StoreReads } from "./store.js";

/**
 * `POST /token` (RFC 6749 sections 4.1.3 and 6) and `POST /revoke` (RFC 7009) on the public app
 * (R5.1 to R5.4, R7.1).
 *
 * - Both routes: per-IP limiter, body size cap, then a strict urlencoded parse. The query is
 *   never read and any repeated parameter name is refused.
 * - Client authentication is exactly the registered method: Basic, post or none.
 * - A code is consumed only after every cheap request check passed. A replayed code revokes the
 *   grant it produced. Raw tokens are released only after the store write committed.
 * - A refresh token rotates inside one store transaction; presenting a rotated-out token again
 *   revokes the grant in that same transaction.
 * - Every error body carries a fixed description. No request value reaches a body, header or log.
 */

export const TOKEN_LIFETIMES = Object.freeze({
  accessMs: 3_600_000,
  refreshMs: 30 * 86_400_000,
});
export const TOKEN_MAX_BODY_BYTES = 16 * 1024;

export type TokenError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_target"
  | "server_error";

export const TOKEN_ERROR_DESCRIPTIONS: Readonly<Record<TokenError, string>> = Object.freeze({
  invalid_request: "The token request is invalid",
  invalid_client: "Client authentication failed",
  invalid_grant: "The grant is invalid, expired or revoked",
  unsupported_grant_type: "Only authorization_code and refresh_token are supported",
  invalid_target: "The resource is not served by this server",
  server_error: "The server could not complete the request",
});

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const BASIC_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

type FormMap = Readonly<Record<string, readonly string[]>>;

function parseForm(text: string): FormMap {
  const map: Record<string, string[]> = Object.create(null);
  for (const [name, value] of new URLSearchParams(text)) {
    const list = Object.hasOwn(map, name) ? map[name] : undefined;
    if (list === undefined) map[name] = [value];
    else list.push(value);
  }
  return map;
}

function hasDuplicate(map: FormMap): boolean {
  return Object.values(map).some((list) => list.length > 1);
}

/** The value of `name` when there is exactly one and it is non-empty. */
function one(map: FormMap, name: string): string | undefined {
  if (!Object.hasOwn(map, name)) return undefined;
  const list = map[name];
  return list !== undefined && list.length === 1 && list[0] !== "" ? list[0] : undefined;
}

function formDecode(part: string): string | undefined {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

/** Parses an `Authorization` header as Basic (RFC 6749 section 2.3.1), or undefined. */
export function parseBasicAuth(header: string): { clientId: string; secret: string } | undefined {
  const match = /^basic ([^ ]+)$/i.exec(header);
  const payload = match?.[1];
  if (payload === undefined || !BASIC_PAYLOAD.test(payload)) return undefined;
  const decoded = Buffer.from(payload, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  const clientId = formDecode(decoded.slice(0, colon));
  const secret = formDecode(decoded.slice(colon + 1));
  if (clientId === undefined || secret === undefined || clientId === "") return undefined;
  return { clientId, secret };
}

/** True when `verifier` hashes (S256) to `challenge`. Constant-time compare. */
export function pkceS256Matches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

type ClientAuth =
  | { ok: true; clientId: string }
  | { ok: false; status: 400 | 401; error: "invalid_request" | "invalid_client"; basic: boolean };

function authenticateClient(
  map: FormMap,
  authorization: string | undefined,
  store: StoreReads,
): ClientAuth {
  const bodyHasSecret = Object.hasOwn(map, "client_secret");
  let method: ClientAuthMethod;
  let clientId: string | undefined;
  let secret: string | undefined;
  if (authorization !== undefined) {
    if (bodyHasSecret) return { ok: false, status: 400, error: "invalid_request", basic: false };
    const parsed = parseBasicAuth(authorization);
    if (parsed === undefined)
      return { ok: false, status: 401, error: "invalid_client", basic: true };
    const bodyId = one(map, "client_id");
    if (Object.hasOwn(map, "client_id") && bodyId !== parsed.clientId) {
      return { ok: false, status: 401, error: "invalid_client", basic: true };
    }
    method = "client_secret_basic";
    clientId = parsed.clientId;
    secret = parsed.secret;
  } else {
    clientId = one(map, "client_id");
    if (clientId === undefined) {
      return { ok: false, status: 400, error: "invalid_request", basic: false };
    }
    if (bodyHasSecret) {
      method = "client_secret_post";
      secret = one(map, "client_secret") ?? "";
    } else {
      method = "none";
    }
  }
  const basic = method === "client_secret_basic";
  const fail = { ok: false, status: 401, error: "invalid_client", basic } as const;
  const client = store.getClient(clientId);
  if (client === undefined || client.authMethod !== method) return fail;
  if (method !== "none" && !store.verifyClientSecret(clientId, secret ?? "")) return fail;
  return { ok: true, clientId };
}

export interface TokenDeps {
  store: AuthStore;
  codes: CodeStore;
  trustProxyHops: number;
  rateNow?: () => number;
  /** Test seam: must equal the store clock. Production leaves it unset. */
  tokenNow?: () => Date;
  log: (line: string) => void;
}

type Ctx = Context<PublicAppEnv>;

function noStore(c: Ctx): void {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
}

function fail(c: Ctx, status: 400 | 401 | 500, error: TokenError, basic = false): Response {
  noStore(c);
  if (status === 401 && basic) c.header("WWW-Authenticate", 'Basic realm="oauth"');
  return c.json({ error, error_description: TOKEN_ERROR_DESCRIPTIONS[error] }, status);
}

function success(c: Ctx, body: Record<string, unknown>): Response {
  noStore(c);
  return c.json(body, 200);
}

type Prepared = { map: FormMap; clientId: string };

/** The shared request checks of both routes. Returns a response on failure. */
async function prepare(c: Ctx, store: StoreReads): Promise<Prepared | Response> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return fail(c, 400, "invalid_request");
  const map = parseForm(await c.req.text());
  if (hasDuplicate(map)) return fail(c, 400, "invalid_request");
  const auth = authenticateClient(map, c.req.header("authorization"), store);
  if (!auth.ok) return fail(c, auth.status, auth.error, auth.basic);
  return { map, clientId: auth.clientId };
}

/** Revokes a grant that exists and is not yet revoked; otherwise changes nothing. */
function revokeIfLive(
  tx: { getGrant(id: string): { revoked: boolean } | undefined; revokeGrant(id: string): boolean },
  id: string,
): void {
  const grant = tx.getGrant(id);
  if (grant !== undefined && !grant.revoked) tx.revokeGrant(id);
}

export function registerTokenRoutes(app: Hono<PublicAppEnv>, deps: TokenDeps): void {
  const { store, codes, log } = deps;
  const tokenNow = deps.tokenNow ?? (() => new Date());
  const limits = () => ({ trustProxyHops: deps.trustProxyHops, now: deps.rateNow });
  const tooBig = (c: Ctx) => fail(c, 400, "invalid_request");

  async function revokeGrantOf(id: string): Promise<boolean> {
    const out = await store.update((tx) => revokeIfLive(tx, id));
    return out.ok;
  }

  async function authorizationCode(c: Ctx, map: FormMap, clientId: string): Promise<Response> {
    const resource = c.var.urls.resource;
    const code = one(map, "code");
    const verifier = one(map, "code_verifier");
    const redirectUri = one(map, "redirect_uri");
    if (
      code === undefined ||
      verifier === undefined ||
      redirectUri === undefined ||
      !VERIFIER.test(verifier)
    ) {
      return fail(c, 400, "invalid_request");
    }
    if (Object.hasOwn(map, "resource") && one(map, "resource") !== resource) {
      return fail(c, 400, "invalid_target");
    }

    const r = codes.consume(code);
    if (r.kind === "invalid") return fail(c, 400, "invalid_grant");
    if (r.kind === "replayed") {
      if (r.grantId === undefined) return fail(c, 400, "invalid_grant");
      if (!(await revokeGrantOf(r.grantId))) return fail(c, 500, "server_error");
      log("token: code replayed, grant revoked");
      return fail(c, 400, "invalid_grant");
    }
    const { binding } = r;
    if (
      binding.clientId !== clientId ||
      binding.redirectUri !== redirectUri ||
      binding.resource !== resource ||
      !pkceS256Matches(verifier, binding.codeChallenge)
    ) {
      return fail(c, 400, "invalid_grant");
    }

    const grantId = newId();
    const accessToken = newId();
    const refreshToken = newId();
    const at = tokenNow().getTime();
    const out = await store.update((tx) => {
      if (tx.getClient(clientId) === undefined) return "no_client" as const;
      tx.putGrant(grantId, {
        clientId,
        resource,
        accessToken,
        accessExpiresAt: new Date(at + TOKEN_LIFETIMES.accessMs),
        refreshToken,
        refreshExpiresAt: new Date(at + TOKEN_LIFETIMES.refreshMs),
      });
      return "ok" as const;
    });
    if (!out.ok) return fail(c, 500, "server_error");
    if (out.value === "no_client") return fail(c, 401, "invalid_client");

    if (codes.attachGrant(r.codeHash, grantId).replayed) {
      const revoked = await revokeGrantOf(grantId);
      log("token: code replayed, grant revoked");
      return revoked ? fail(c, 400, "invalid_grant") : fail(c, 500, "server_error");
    }
    return success(c, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIMES.accessMs / 1000,
      refresh_token: refreshToken,
    });
  }

  async function refreshToken(c: Ctx, map: FormMap, clientId: string): Promise<Response> {
    const resource = c.var.urls.resource;
    const raw = one(map, "refresh_token");
    if (raw === undefined) return fail(c, 400, "invalid_request");
    if (Object.hasOwn(map, "resource") && one(map, "resource") !== resource) {
      return fail(c, 400, "invalid_target");
    }
    // Cheap pre-check on committed data: an unknown, revoked or expired token never writes.
    const seen = store.findGrantByRefreshToken(raw);
    if (
      seen === undefined ||
      seen.grant.revoked ||
      Date.parse(seen.grant.refreshExpiresAt) <= tokenNow().getTime()
    ) {
      return fail(c, 400, "invalid_grant");
    }

    const next = {
      accessToken: newId(),
      refreshToken: newId(),
    };
    const at = tokenNow().getTime();
    const out = await store.update((tx) => {
      const f = tx.findGrantByRefreshToken(raw);
      if (f === undefined || f.grant.clientId !== clientId) return "invalid" as const;
      if (f.reused) {
        revokeIfLive(tx, f.id);
        return "reused" as const;
      }
      if (f.grant.resource !== resource) return "invalid" as const;
      if (tx.getClient(clientId) === undefined) return "no_client" as const;
      const rotated = tx.rotateGrant(f.id, raw, {
        accessToken: next.accessToken,
        accessExpiresAt: new Date(at + TOKEN_LIFETIMES.accessMs),
        refreshToken: next.refreshToken,
        refreshExpiresAt: new Date(at + TOKEN_LIFETIMES.refreshMs),
      });
      if (rotated.ok) return "ok" as const;
      if (rotated.reason === "reused") {
        revokeIfLive(tx, f.id);
        return "reused" as const;
      }
      return "invalid" as const;
    });
    if (!out.ok) return fail(c, 500, "server_error");
    switch (out.value) {
      case "ok":
        return success(c, {
          access_token: next.accessToken,
          token_type: "Bearer",
          expires_in: TOKEN_LIFETIMES.accessMs / 1000,
          refresh_token: next.refreshToken,
        });
      case "reused":
        log("token: refresh reuse, grant revoked");
        return fail(c, 400, "invalid_grant");
      case "no_client":
        return fail(c, 401, "invalid_client");
      default:
        return fail(c, 400, "invalid_grant");
    }
  }

  app.post(
    PUBLIC_PATHS.token,
    rateLimit(RATE_RULES.token, limits()),
    bodyLimit({ maxSize: TOKEN_MAX_BODY_BYTES, onError: tooBig }),
    async (c) => {
      const prepared = await prepare(c, store);
      if (prepared instanceof Response) return prepared;
      const { map, clientId } = prepared;
      const grantType = one(map, "grant_type");
      if (grantType === undefined) return fail(c, 400, "invalid_request");
      if (grantType === "authorization_code") return authorizationCode(c, map, clientId);
      if (grantType === "refresh_token") return refreshToken(c, map, clientId);
      return fail(c, 400, "unsupported_grant_type");
    },
  );

  app.post(
    PUBLIC_PATHS.revoke,
    rateLimit(RATE_RULES.token, limits()),
    bodyLimit({ maxSize: TOKEN_MAX_BODY_BYTES, onError: tooBig }),
    async (c) => {
      const prepared = await prepare(c, store);
      if (prepared instanceof Response) return prepared;
      const { map, clientId } = prepared;
      const token = one(map, "token");
      if (token === undefined) return fail(c, 400, "invalid_request");

      const ok = () => {
        noStore(c);
        return c.body(null, 200);
      };
      const lookup = (reads: StoreReads) =>
        reads.findGrantByAccessToken(token) ?? reads.findGrantByRefreshToken(token);
      const seen = lookup(store);
      if (seen === undefined || seen.grant.clientId !== clientId || seen.grant.revoked) {
        return ok();
      }
      const out = await store.update((tx) => {
        const f = lookup(tx);
        if (f !== undefined && f.grant.clientId === clientId) revokeIfLive(tx, f.id);
      });
      return out.ok ? ok() : fail(c, 500, "server_error");
    },
  );
}
