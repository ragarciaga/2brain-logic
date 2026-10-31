import type { Hono } from "hono";
import { PUBLIC_PATHS, type PublicAppEnv, type PublicUrls } from "../../mcp/app.js";

/** How a client proves who it is at the token and revocation endpoints (RFC 7591 names). */
export const CLIENT_AUTH_METHODS = Object.freeze([
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const);

export const RESPONSE_TYPES = Object.freeze(["code"] as const);
export const GRANT_TYPES = Object.freeze(["authorization_code", "refresh_token"] as const);
const CODE_CHALLENGE_METHODS = Object.freeze(["S256"] as const);
const BEARER_METHODS = Object.freeze(["header"] as const);

/** RFC 9728 protected resource metadata. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
}

/** RFC 8414 authorization server metadata. */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly revocation_endpoint_auth_methods_supported: readonly string[];
}

/** The protected resource document: every URL in it comes from `urls`. */
export function protectedResourceMetadata(urls: PublicUrls): ProtectedResourceMetadata {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: BEARER_METHODS,
  };
}

/** The authorization server document: every URL in it comes from `urls`. */
export function authorizationServerMetadata(urls: PublicUrls): AuthorizationServerMetadata {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    revocation_endpoint: urls.revocationEndpoint,
    response_types_supported: RESPONSE_TYPES,
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: CODE_CHALLENGE_METHODS,
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
  };
}

/**
 * Mounts the discovery documents on the public app: the protected resource metadata at both
 * paths and the authorization server metadata. Handlers read `c.var.urls` only.
 */
export function registerDiscoveryRoutes(app: Hono<PublicAppEnv>): void {
  app.get(PUBLIC_PATHS.protectedResourceMetadata, (c) =>
    c.json(protectedResourceMetadata(c.var.urls)),
  );
  app.get(PUBLIC_PATHS.protectedResourceMetadataRoot, (c) =>
    c.json(protectedResourceMetadata(c.var.urls)),
  );
  app.get(PUBLIC_PATHS.authorizationServerMetadata, (c) =>
    c.json(authorizationServerMetadata(c.var.urls)),
  );
}
