import { Hono } from "hono";

/** URLs this service advertises to OAuth and MCP clients. Built once from the configured base. */
export interface PublicUrls {
  /** The authorization server issuer: the base origin. */
  readonly issuer: string;
  /** The protected resource: the MCP endpoint. */
  readonly resource: string;
  /** Where clients find the protected resource metadata. */
  readonly resourceMetadata: string;
}

export type PublicAppEnv = { Variables: { urls: PublicUrls } };

export interface PublicAppOptions {
  /** `PUBLIC_BASE_URL` as read by `loadEnv`: an origin. Never the whole public environment. */
  baseUrl: string;
}

/**
 * The only place an advertised URL is built. Its only input is the configured base URL, so a
 * request can never change what the service advertises.
 */
export function buildPublicUrls(baseUrl: string): PublicUrls {
  const origin = new URL(baseUrl).origin;
  return Object.freeze({
    issuer: origin,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
  });
}

/**
 * The public Hono app, served on `MCP_PORT`. It has no routes yet, so every path answers 404
 * (Hono's default), including the ingest routes: the ingest API never answers here, with or
 * without the ingest token. Later tasks mount their routes on this app.
 *
 * Handlers read the advertised URLs from `c.var.urls`. They never derive a URL from `Host` or
 * from an `X-Forwarded-*` header.
 */
export function createPublicApp({ baseUrl }: PublicAppOptions): {
  app: Hono<PublicAppEnv>;
  urls: PublicUrls;
} {
  const urls = buildPublicUrls(baseUrl);
  const app = new Hono<PublicAppEnv>();

  // First registration: every handler mounted later sees the same URLs.
  app.use("*", async (c, next) => {
    c.set("urls", urls);
    await next();
  });

  return { app, urls };
}
