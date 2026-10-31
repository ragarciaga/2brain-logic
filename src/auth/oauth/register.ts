import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PUBLIC_PATHS, type PublicAppEnv } from "../../mcp/app.js";
import { RATE_RULES, rateLimit } from "../rate-limit.js";
import { CLIENT_AUTH_METHODS, GRANT_TYPES, RESPONSE_TYPES } from "./metadata.js";
import { AUTH_STORE_LIMITS, type AuthStore, newId } from "./store.js";

/**
 * RFC 7591 dynamic client registration: `POST /register` on the public app (R3.1 to R3.4, R7.1).
 *
 * - Every error answer is a fixed string. No Zod text and no request value reaches a body or a log.
 * - A redirect URI is accepted only in its canonical form (`new URL(uri).href === uri`), so the
 *   exact match at authorize (T8) cannot be fooled by a parser difference.
 * - The 50-client cap evicts the oldest client with no grant that is more than 24 hours old, in the
 *   same write that stores the new one. Clients never expire, so without this a few addresses could
 *   fill every slot for good.
 */

/** A client with no grant older than this may be evicted to make room at the cap. */
export const CLIENT_IDLE_EVICTION_MS = 24 * 3_600_000;
export const REGISTER_MAX_BODY_BYTES = 64 * 1024;

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

const MESSAGES = Object.freeze({
  metadata: "The client metadata is invalid",
  redirect: "Every redirect URI must be https on an allowed host or http on a loopback host",
  full: `Client limit reached: at most ${AUTH_STORE_LIMITS.maxClients} clients can be registered`,
});

/** True for a control, invisible or direction-changing character, or a lone surrogate. */
function hasUnsafeText(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * True when `uri` is https on a host in `hosts` (exact match, default port) or http on a loopback
 * host with any port, in canonical form, with no credentials and no fragment.
 */
export function isAllowedRedirectUri(uri: string, hosts: readonly string[]): boolean {
  if (uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.href !== uri) return false;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return url.port === "" && hosts.includes(url.hostname);
  if (url.protocol === "http:") return LOOPBACK_HOSTS.includes(url.hostname);
  return false;
}

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !hasUnsafeText(text));

// Built on first use, not at import: metadata.ts imports the app, which imports this module, so
// its constants are not set yet when this file is first evaluated.
function buildMetadataSchema() {
  return z.object({
    redirect_uris: z
      .array(safeText(AUTH_STORE_LIMITS.maxRedirectUriLength).pipe(z.string().min(1)))
      .min(1)
      .max(AUTH_STORE_LIMITS.maxRedirectUris),
    token_endpoint_auth_method: z.enum(CLIENT_AUTH_METHODS).default("client_secret_basic"),
    client_name: safeText(AUTH_STORE_LIMITS.maxNameLength).optional(),
    grant_types: z.array(z.enum(GRANT_TYPES)).optional(),
    response_types: z.array(z.enum(RESPONSE_TYPES)).optional(),
  });
}

export interface RegisterDeps {
  store: AuthStore;
  /** `ALLOWED_REDIRECT_HOSTS`. */
  allowedRedirectHosts: readonly string[];
  /** `TRUST_PROXY_HOPS`. */
  trustProxyHops: number;
  /** Test seam for the rate limiter clock. */
  rateNow?: () => number;
  /** Where the two fixed audit lines go. Defaults to `console.error`. */
  log?: (line: string) => void;
}

function fail(
  c: Context,
  status: 400 | 500,
  body: { error: string; error_description?: string },
): Response {
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

const invalidMetadata = (c: Context): Response =>
  fail(c, 400, { error: "invalid_client_metadata", error_description: MESSAGES.metadata });

/** Mounts `POST /register` on the public app. */
export function registerClientRoute(app: Hono<PublicAppEnv>, deps: RegisterDeps): void {
  const log = deps.log ?? console.error;
  const metadataSchema = buildMetadataSchema();
  app.post(
    PUBLIC_PATHS.register,
    rateLimit(RATE_RULES.register, { trustProxyHops: deps.trustProxyHops, now: deps.rateNow }),
    bodyLimit({ maxSize: REGISTER_MAX_BODY_BYTES, onError: invalidMetadata }),
    async (c) => {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return invalidMetadata(c);
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text());
      } catch {
        return invalidMetadata(c);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return invalidMetadata(c);
      }
      const parsed = metadataSchema.safeParse(raw);
      if (!parsed.success) return invalidMetadata(c);
      const meta = parsed.data;
      const redirectUris = [...meta.redirect_uris];
      if (!redirectUris.every((uri) => isAllowedRedirectUri(uri, deps.allowedRedirectHosts))) {
        return fail(c, 400, {
          error: "invalid_redirect_uri",
          error_description: MESSAGES.redirect,
        });
      }
      const authMethod = meta.token_endpoint_auth_method;
      const name = meta.client_name;
      const clientId = newId();
      const secret = authMethod === "none" ? undefined : newId();

      const outcome = await deps.store.update((tx) => {
        let evicted = false;
        if (tx.clientCount() >= AUTH_STORE_LIMITS.maxClients) {
          const victim = tx.oldestIdleClient(CLIENT_IDLE_EVICTION_MS);
          if (victim === undefined) return { full: true as const };
          tx.removeClient(victim);
          evicted = true;
        }
        tx.putClient(clientId, { authMethod, secret, redirectUris, name });
        return {
          full: false as const,
          evicted,
          createdAt: tx.getClient(clientId)?.createdAt ?? "",
        };
      });
      if (!outcome.ok) return fail(c, 500, { error: "server_error" });
      if (outcome.value.full) {
        log("register: client limit reached");
        return fail(c, 400, { error: "invalid_client_metadata", error_description: MESSAGES.full });
      }
      if (outcome.value.evicted) log("register: client evicted");

      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json(
        {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.parse(outcome.value.createdAt) / 1000),
          ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
          redirect_uris: redirectUris,
          token_endpoint_auth_method: authMethod,
          grant_types: meta.grant_types ?? GRANT_TYPES,
          response_types: meta.response_types ?? RESPONSE_TYPES,
          ...(name === undefined ? {} : { client_name: name }),
        },
        201,
      );
    },
  );
}
