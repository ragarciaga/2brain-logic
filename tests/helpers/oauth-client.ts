import { randomBytes } from "node:crypto";
import {
  type AuthorizationServerMetadata,
  Client,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientInformationFull,
  registerClient,
  StreamableHTTPClientTransport,
  startAuthorization,
} from "@modelcontextprotocol/client";

/**
 * Client side of the connector journey, over loopback, for tests that drive a real process.
 * Discovery, registration and the authorize URL use the SDK helpers; the token calls are plain
 * form posts so a test can read the status and the error body.
 */

/**
 * `fetch` with `connection: close`: a restarted server never meets a stale keep-alive socket
 * from the previous process.
 */
export async function flowFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

export interface Discovered {
  resource: string;
  authorizationServers: string[];
  metadata: AuthorizationServerMetadata;
}

/** Protected resource metadata, then authorization server metadata, both through the SDK. */
export async function discover(base: string): Promise<Discovered> {
  const prm = await discoverOAuthProtectedResourceMetadata(
    `${base}/mcp`,
    { resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp` },
    flowFetch,
  );
  const metadata = await discoverAuthorizationServerMetadata(base, { fetchFn: flowFetch });
  if (metadata === undefined) throw new Error("no authorization server metadata");
  return {
    resource: String(prm.resource),
    authorizationServers: (prm.authorization_servers ?? []).map(String),
    metadata,
  };
}

export const REDIRECT_URI = "http://127.0.0.1:8765/callback";

/** Register a `client_secret_basic` client with the SDK. */
export async function register(
  base: string,
  metadata: AuthorizationServerMetadata,
  clientName: string,
): Promise<OAuthClientInformationFull> {
  return registerClient(base, {
    metadata,
    fetchFn: flowFetch,
    clientMetadata: {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_basic",
      client_name: clientName,
    },
  });
}

export interface Pkce {
  url: URL;
  verifier: string;
  state: string;
}

/** The authorize URL from the SDK, with a random `state`, and the PKCE verifier behind it. */
export async function authorizeUrl(
  base: string,
  metadata: AuthorizationServerMetadata,
  client: OAuthClientInformationFull,
): Promise<Pkce> {
  const state = randomBytes(12).toString("base64url");
  const { authorizationUrl, codeVerifier } = await startAuthorization(base, {
    metadata,
    clientInformation: client,
    redirectUrl: REDIRECT_URI,
    state,
    resource: `${base}/mcp`,
  });
  return { url: authorizationUrl, verifier: codeVerifier, state };
}

/** The sign-in page for an authorize URL. */
export function authorizePage(url: URL): Promise<Response> {
  return flowFetch(url);
}

/** Submit the sign-in form the page would send: the query as hidden fields plus the passphrase. */
export function signIn(base: string, url: URL, passphrase: string): Promise<Response> {
  const form = new URLSearchParams(url.search);
  form.set("passphrase", passphrase);
  return flowFetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: form.toString(),
  });
}

const basic = (client: OAuthClientInformationFull): string =>
  `Basic ${Buffer.from(
    `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret ?? "")}`,
  ).toString("base64")}`;

function postForm(
  base: string,
  path: string,
  client: OAuthClientInformationFull,
  form: Record<string, string>,
): Promise<Response> {
  return flowFetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basic(client),
    },
    body: new URLSearchParams(form).toString(),
  });
}

/** `POST /token` with any grant fields. */
export function rawToken(
  base: string,
  client: OAuthClientInformationFull,
  form: Record<string, string>,
): Promise<Response> {
  return postForm(base, "/token", client, form);
}

/** Exchange an authorization code. */
export function exchange(
  base: string,
  client: OAuthClientInformationFull,
  code: string,
  verifier: string,
): Promise<Response> {
  return rawToken(base, client, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: `${base}/mcp`,
  });
}

/** Rotate a refresh token. */
export function refresh(
  base: string,
  client: OAuthClientInformationFull,
  refreshToken: string,
): Promise<Response> {
  return rawToken(base, client, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: `${base}/mcp`,
  });
}

/** `POST /revoke`. */
export function revoke(
  base: string,
  client: OAuthClientInformationFull,
  token: string,
): Promise<Response> {
  return postForm(base, "/revoke", client, { token });
}

/** A bare JSON-RPC post to `/mcp`, with a Bearer token when one is given. */
export function rawMcp(base: string, token?: string): Promise<Response> {
  return flowFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** An SDK client connected to `/mcp` with a Bearer token. Close it when done. */
export async function connectMcp(base: string, token: string): Promise<Client> {
  const client = new Client({ name: "flow-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch: flowFetch,
      authProvider: { token: async () => token },
    }),
  );
  return client;
}
