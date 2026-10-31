import type { Context, Hono } from "hono";
import { PUBLIC_PATHS, type PublicAppEnv } from "../../mcp/app.js";
import { isAllowedRedirectUri } from "./register.js";
import type { StoreReads } from "./store.js";

/**
 * `GET /authorize` (R4.1 to R4.3, R4.6): the request checks and the owner sign-in page.
 *
 * - Order is the control against open redirects: a bad client or redirect URI answers a fixed 400
 *   page and never redirects. Only after both are proven does any failure redirect to the client.
 * - The redirect URI shown, put in the form and redirected to is built from the stored canonical
 *   URI (with the request port for loopback), never from a decoded request value.
 * - Every value interpolated into the page goes through one escaping template helper.
 * - The check takes a plain parameter map so the POST handler can reuse it on form fields.
 */

/** Parameter map: every name with all its values, in order. */
export type AuthorizeParams = Readonly<Record<string, readonly string[]>>;

export interface ValidAuthorizeRequest {
  clientId: string;
  clientName?: string;
  /** The effective redirect URI: the stored one, with the request port for a loopback client. */
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** Always the resource URL. */
  resource: string;
  /** True when the request carried a `resource` parameter. */
  resourceGiven: boolean;
}

export type AuthorizeError = "invalid_request" | "unsupported_response_type" | "invalid_target";

export type AuthorizeFailure =
  | { kind: "page_error" }
  | { kind: "redirect_error"; redirectUri: string; error: AuthorizeError; state?: string };

export type AuthorizeCheck = { kind: "ok"; request: ValidAuthorizeRequest } | AuthorizeFailure;

export interface AuthorizeDeps {
  store: StoreReads;
  /** `ALLOWED_REDIRECT_HOSTS`. */
  allowedRedirectHosts: readonly string[];
}

export const AUTHORIZE_LIMITS = Object.freeze({ maxStateLength: 2048 });

export const ERROR_DESCRIPTIONS: Readonly<Record<AuthorizeError, string>> = Object.freeze({
  invalid_request: "The authorization request is invalid",
  unsupported_response_type: "Only the code response type is supported",
  invalid_target: "The resource is not served by this server",
});

const LOOPBACK_NAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CSP_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

function values(params: AuthorizeParams, name: string): readonly string[] {
  return Object.hasOwn(params, name) ? (params[name] ?? []) : [];
}

function single(params: AuthorizeParams, name: string): string | undefined {
  const list = values(params, name);
  return list.length === 1 && list[0] !== "" ? list[0] : undefined;
}

/**
 * Returns the redirect URI to use when `requested` is registered, or undefined. An exact string
 * match returns the stored string. A stored `http` loopback URI also matches the same URI with any
 * other port, and then the stored URI with the requested port is returned. `localhost` never
 * matches `127.0.0.1`.
 */
export function matchRedirectUri(
  requested: string,
  registered: readonly string[],
): string | undefined {
  if (requested.includes("#")) return undefined;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return undefined;
  }
  if (req.href !== requested) return undefined;
  if (req.username !== "" || req.password !== "") return undefined;
  if (registered.includes(requested)) return requested;
  if (req.protocol !== "http:" || !LOOPBACK_NAMES.includes(req.hostname)) return undefined;
  const reqBase = new URL(requested);
  reqBase.port = "";
  for (const stored of registered) {
    let url: URL;
    try {
      url = new URL(stored);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" || !LOOPBACK_NAMES.includes(url.hostname)) continue;
    const base = new URL(stored);
    base.port = "";
    if (base.href !== reqBase.href) continue;
    url.port = req.port;
    return url.href;
  }
  return undefined;
}

/** Validates an authorize request. Page errors come first; see the module comment. */
export function checkAuthorizeRequest(
  params: AuthorizeParams,
  resourceUrl: string,
  deps: AuthorizeDeps,
): AuthorizeCheck {
  const clientId = single(params, "client_id");
  const requested = single(params, "redirect_uri");
  if (clientId === undefined || requested === undefined) return { kind: "page_error" };
  const client = deps.store.getClient(clientId);
  if (client === undefined) return { kind: "page_error" };
  const effective = matchRedirectUri(requested, client.redirectUris);
  if (effective === undefined || !isAllowedRedirectUri(effective, deps.allowedRedirectHosts)) {
    return { kind: "page_error" };
  }

  const stateValues = values(params, "state");
  const stateBad =
    stateValues.length > 1 || (stateValues[0] ?? "").length > AUTHORIZE_LIMITS.maxStateLength;
  const state = !stateBad && stateValues[0] !== "" ? stateValues[0] : undefined;
  const fail = (error: AuthorizeError): AuthorizeFailure => ({
    kind: "redirect_error",
    redirectUri: effective,
    error,
    ...(state === undefined ? {} : { state }),
  });

  if (stateBad) return fail("invalid_request");
  for (const name of ["response_type", "code_challenge", "code_challenge_method"]) {
    if (values(params, name).length > 1) return fail("invalid_request");
  }
  const responseType = single(params, "response_type");
  if (responseType === undefined) return fail("invalid_request");
  if (responseType !== "code") return fail("unsupported_response_type");
  if (single(params, "code_challenge_method") !== "S256") return fail("invalid_request");
  const challenge = single(params, "code_challenge");
  if (challenge === undefined || !CHALLENGE.test(challenge)) return fail("invalid_request");
  const resources = values(params, "resource");
  if (resources.some((resource) => resource !== resourceUrl)) return fail("invalid_target");

  return {
    kind: "ok",
    request: {
      clientId,
      ...(client.name === undefined ? {} : { clientName: client.name }),
      redirectUri: effective,
      codeChallenge: challenge,
      ...(state === undefined ? {} : { state }),
      resource: resourceUrl,
      resourceGiven: resources.length > 0,
    },
  };
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Markup already built by `html`; inserted as is. */
class Markup {
  constructor(readonly text: string) {}
}

/** Template tag: every interpolated value is escaped unless it is `Markup` from this tag. */
function html(strings: TemplateStringsArray, ...parts: unknown[]): Markup {
  let out = strings[0] ?? "";
  parts.forEach((part, i) => {
    out += part instanceof Markup ? part.text : escapeHtml(String(part));
    out += strings[i + 1] ?? "";
  });
  return new Markup(out);
}

function stripUnsafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const bad =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      (code >= 0xd800 && code <= 0xdfff);
    if (!bad) out += ch;
  }
  return out;
}

const hidden = (name: string, value: string): Markup =>
  html`<input type="hidden" name="${name}" value="${value}">`;

/** The sign-in page. `actionPath` is a relative path. */
export function renderSignInPage(request: ValidAuthorizeRequest, actionPath: string): string {
  const name = stripUnsafe(request.clientName ?? "");
  const redirectHost = new URL(request.redirectUri).host;
  const fields = [
    hidden("client_id", request.clientId),
    hidden("redirect_uri", request.redirectUri),
    hidden("response_type", "code"),
    hidden("code_challenge", request.codeChallenge),
    hidden("code_challenge_method", "S256"),
    ...(request.state === undefined ? [] : [hidden("state", request.state)]),
    ...(request.resourceGiven ? [hidden("resource", request.resource)] : []),
  ];
  const declared = name === "" ? html`An unnamed client` : html`The client calls itself "${name}"`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in</title>
</head>
<body>
<h1>Sign in to your second brain</h1>
<p>Redirect host: <strong>${redirectHost}</strong></p>
<p>Redirect address: <strong>${request.redirectUri}</strong></p>
<p>${declared} (self-declared, not verified).</p>
<form method="post" action="${actionPath}">
${new Markup(fields.map((field) => field.text).join("\n"))}
<label>Passphrase <input type="password" name="passphrase" autocomplete="current-password" required></label>
<button type="submit">Authorize</button>
</form>
</body>
</html>
`.text;
}

/** The fixed 400 page: no request value. */
export function renderErrorPage(): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorization error</title>
</head>
<body>
<h1>Authorization error</h1>
<p>This authorization request cannot be completed. Return to the application and try again.</p>
</body>
</html>
`.text;
}

/** Security headers for every page. `formTarget` is the redirect URI the form leads to. */
export function setPageHeaders(c: Context, formTarget?: string): void {
  let formAction = "'none'";
  if (formTarget !== undefined) {
    const origin = new URL(formTarget).origin;
    formAction = CSP_ORIGIN.test(origin) ? `'self' ${origin}` : "'self'";
  }
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`,
  );
}

/**
 * Appends OAuth parameters to a redirect URI without re-encoding what is already there, and
 * redirects with 302, `no-store` and `no-referrer`.
 */
export function redirectWithParams(
  c: Context,
  redirectUri: string,
  entries: Readonly<Record<string, string | undefined>>,
): Response {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.append(key, value);
  }
  const separator = redirectUri.endsWith("?") ? "" : new URL(redirectUri).search === "" ? "?" : "&";
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(`${redirectUri}${separator}${params.toString()}`, 302);
}

/** The answer for a failed check: the 400 page or the error redirect. */
export function authorizeFailureResponse(c: Context, failure: AuthorizeFailure): Response {
  if (failure.kind === "page_error") {
    setPageHeaders(c);
    return c.html(renderErrorPage(), 400);
  }
  return redirectWithParams(c, failure.redirectUri, {
    error: failure.error,
    error_description: ERROR_DESCRIPTIONS[failure.error],
    state: failure.state,
  });
}

/** The 200 sign-in page for a valid request. */
export function signInPageResponse(
  c: Context,
  request: ValidAuthorizeRequest,
  actionPath: string,
): Response {
  setPageHeaders(c, request.redirectUri);
  return c.html(renderSignInPage(request, actionPath), 200);
}

/** Mounts `GET /authorize` on the public app. */
export function registerAuthorizeRoute(app: Hono<PublicAppEnv>, deps: AuthorizeDeps): void {
  app.get(PUBLIC_PATHS.authorize, (c) => {
    const check = checkAuthorizeRequest(c.req.queries(), c.var.urls.resource, deps);
    if (check.kind !== "ok") return authorizeFailureResponse(c, check);
    return signInPageResponse(c, check.request, PUBLIC_PATHS.authorize);
  });
}
