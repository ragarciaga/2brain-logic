import { Hono } from "hono";
import { registerAuthorizeRoute } from "../auth/oauth/authorize.js";
import { registerDiscoveryRoutes } from "../auth/oauth/metadata.js";
import { registerClientRoute } from "../auth/oauth/register.js";
import type { AuthStore } from "../auth/oauth/store.js";

/**
 * Every path the public app serves or advertises. Routes are mounted from these constants and
 * `buildPublicUrls` derives the advertised URLs from them, so a path exists in one place only.
 */
export const PUBLIC_PATHS = Object.freeze({
  mcp: "/mcp",
  authorize: "/authorize",
  token: "/token",
  register: "/register",
  revoke: "/revoke",
  protectedResourceMetadata: "/.well-known/oauth-protected-resource/mcp",
  protectedResourceMetadataRoot: "/.well-known/oauth-protected-resource",
  authorizationServerMetadata: "/.well-known/oauth-authorization-server",
});

/** URLs this service advertises to OAuth and MCP clients. Built once from the configured base. */
export interface PublicUrls {
  /** The authorization server issuer: the base origin. */
  readonly issuer: string;
  /** The protected resource: the MCP endpoint. */
  readonly resource: string;
  /** Where clients find the protected resource metadata. */
  readonly resourceMetadata: string;
  /** The OAuth authorization endpoint. */
  readonly authorizationEndpoint: string;
  /** The OAuth token endpoint. */
  readonly tokenEndpoint: string;
  /** The RFC 7591 dynamic client registration endpoint. */
  readonly registrationEndpoint: string;
  /** The RFC 7009 token revocation endpoint. */
  readonly revocationEndpoint: string;
}

export type PublicAppEnv = { Variables: { urls: PublicUrls } };

export interface PublicAppOptions {
  /** `PUBLIC_BASE_URL` as read by `loadEnv`: an origin. Never the whole public environment. */
  baseUrl: string;
  /** Where the one-line internal error record goes. Defaults to `console.error`. */
  log?: (line: string) => void;
  /**
   * What the OAuth routes need. Without it only the discovery documents are served and
   * `POST /register` and `GET /authorize` answer 404.
   */
  auth?: {
    store: AuthStore;
    /** `ALLOWED_REDIRECT_HOSTS`. */
    allowedRedirectHosts: readonly string[];
    /** `TRUST_PROXY_HOPS`. */
    trustProxyHops: number;
    /** Test seam for the rate limiter clock. */
    rateNow?: () => number;
  };
}

/**
 * The only place an advertised URL is built. Its only input is the configured base URL, so a
 * request can never change what the service advertises.
 */
export function buildPublicUrls(baseUrl: string): PublicUrls {
  const origin = new URL(baseUrl).origin;
  return Object.freeze({
    issuer: origin,
    resource: `${origin}${PUBLIC_PATHS.mcp}`,
    resourceMetadata: `${origin}${PUBLIC_PATHS.protectedResourceMetadata}`,
    authorizationEndpoint: `${origin}${PUBLIC_PATHS.authorize}`,
    tokenEndpoint: `${origin}${PUBLIC_PATHS.token}`,
    registrationEndpoint: `${origin}${PUBLIC_PATHS.register}`,
    revocationEndpoint: `${origin}${PUBLIC_PATHS.revoke}`,
  });
}

/**
 * The public Hono app, served on `MCP_PORT`. It serves the discovery documents (RFC 9728 and
 * RFC 8414) and, when `auth` is given, `POST /register` (RFC 7591) and `GET /authorize` (the
 * sign-in page); every other path answers 404
 * (Hono's default), including the ingest routes: the ingest API never answers here, with or
 * without the ingest token. Later tasks mount their routes on this app from `PUBLIC_PATHS`.
 *
 * Handlers read the advertised URLs from `c.var.urls`. They never derive a URL from the request.
 *
 * Any thrown error, whatever its type, answers 500 `{"error":"server_error"}` with
 * `Cache-Control: no-store` and logs the single line `mcp: internal_error`. The error and the
 * headers set before it was thrown are dropped: the handler never looks at them.
 */
export function createPublicApp({ baseUrl, log = console.error, auth }: PublicAppOptions): {
  app: Hono<PublicAppEnv>;
  urls: PublicUrls;
} {
  const urls = buildPublicUrls(baseUrl);
  const app = new Hono<PublicAppEnv>();

  // First registration: every handler mounted later sees the same URLs.
  app.use("*", async (c, next) => {
    c.set("urls", urls);
    try {
      await next();
    } catch (thrown) {
      // Hono hands only Error instances to the error handler; wrap anything else.
      throw thrown instanceof Error ? thrown : new Error("non_error_throw");
    }
  });

  // The error argument is ignored on purpose: nothing about it may reach the body or the log.
  app.onError((_error, c) => {
    log("mcp: internal_error");
    // Hono merges the headers of the response set so far into the one assigned next. Clearing
    // it first keeps a Location, Set-Cookie or WWW-Authenticate set before the throw off the 500.
    c.res = undefined as unknown as Response;
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });

  registerDiscoveryRoutes(app);
  if (auth !== undefined) {
    registerClientRoute(app, { ...auth, log });
    registerAuthorizeRoute(app, {
      store: auth.store,
      allowedRedirectHosts: auth.allowedRedirectHosts,
    });
  }

  return { app, urls };
}
