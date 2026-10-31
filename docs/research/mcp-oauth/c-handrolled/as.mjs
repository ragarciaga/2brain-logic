// Candidate C: hand-rolled single-owner OAuth 2.1 authorization server mounted on any Hono app.
// No imports from an MCP SDK, so it pairs with SDK v1 (server.mjs) or v2 (../c2-handrolled-v2).
// In-memory stores; the real service would persist clients and refresh tokens.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loginPage } from "../shared/login-page.mjs";
import { verifyPassphrase } from "../shared/owner.mjs";
import { redirectAllowed } from "../shared/policy.mjs";

const sha = (t) => createHash("sha256").update(t).digest("base64url");
const rand = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const same = (a, b) => String(a).replace(/\/$/, "") === String(b).replace(/\/$/, "");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function redirectMatches(req, reg) { // exact, or RFC 8252 loopback with any port
  if (req === reg) return true;
  try {
    const a = new URL(req), b = new URL(reg);
    return LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.protocol === b.protocol && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

export function mountAuth(app, { issuer, resource, ownerHash, accessTtl = 3600, refreshTtl = 30 * 86400, maxClients = 50 }) {
  const clients = new Map(), pending = new Map(), codes = new Map(), access = new Map(), refresh = new Map(), used = new Map();
  const err = (c, error, desc, status = 400) => { c.header("Cache-Control", "no-store"); return c.json({ error, error_description: desc }, status); };
  const prmUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
  const asMeta = {
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
  const prm = { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"] };
  for (const p of ["/.well-known/oauth-protected-resource", new URL(prmUrl).pathname]) app.get(p, (c) => c.json(prm));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMeta));

  function issue(clientId, res, family = rand()) {
    const at = rand(), rt = rand();
    access.set(sha(at), { clientId, resource: res, exp: now() + accessTtl, family });
    refresh.set(sha(rt), { clientId, resource: res, exp: now() + refreshTtl, family });
    return { access_token: at, token_type: "Bearer", expires_in: accessTtl, refresh_token: rt };
  }
  const revokeFamily = (f) => { for (const m of [access, refresh]) for (const [k, v] of m) if (v.family === f) m.delete(k); };

  app.post("/register", async (c) => { // RFC 7591
    const m = await c.req.json().catch(() => null);
    const uris = m?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.some((u) => typeof u !== "string" || !redirectAllowed(u)))
      return err(c, "invalid_redirect_uri", "redirect_uris must be loopback or an allowed https host");
    if (clients.size >= maxClients) return err(c, "invalid_client_metadata", "Too many registered clients", 429);
    const method = m.token_endpoint_auth_method ?? "client_secret_basic";
    if (!asMeta.token_endpoint_auth_methods_supported.includes(method)) return err(c, "invalid_client_metadata", "Unsupported auth method");
    const info = { client_id: rand(), client_id_issued_at: now(), redirect_uris: uris, token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: String(m.client_name ?? "").slice(0, 100) };
    const secret = method === "none" ? undefined : rand();
    clients.set(info.client_id, { ...info, secretHash: secret && sha(secret) });
    c.header("Cache-Control", "no-store");
    return c.json({ ...info, ...(secret && { client_secret: secret, client_secret_expires_at: 0 }) }, 201);
  });

  app.get("/authorize", (c) => {
    const q = c.req.query(), client = clients.get(q.client_id ?? "");
    if (!client) return err(c, "invalid_client", "Unknown client_id");
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.some((r) => redirectMatches(redirectUri, r))) return err(c, "invalid_request", "Unregistered redirect_uri");
    const back = (error, desc) => { const u = new URL(redirectUri); u.searchParams.set("error", error); u.searchParams.set("error_description", desc); if (q.state) u.searchParams.set("state", q.state); return c.redirect(u.href, 302); };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE S256 required");
    if (q.resource && !same(q.resource, resource)) return back("invalid_target", "Unknown resource");
    const rid = rand();
    pending.set(rid, { clientId: client.client_id, redirectUri, challenge: q.code_challenge, state: q.state, exp: now() + 600, tries: 0 });
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    return c.html(loginPage({ rid, clientName: client.client_name, redirectHost: new URL(redirectUri).host, action: "/login" }));
  });

  app.post("/login", async (c) => {
    const b = await c.req.parseBody(), p = pending.get(String(b.rid));
    if (!p || p.exp < now()) return c.html(loginPage({ error: "This sign-in expired. Start again from your client.", action: "/login" }), 400);
    if (!(await verifyPassphrase(b.passphrase, ownerHash))) {
      if (++p.tries >= 5) pending.delete(String(b.rid));
      return c.html(loginPage({ rid: b.rid, error: "Wrong passphrase.", action: "/login" }), 401);
    }
    pending.delete(String(b.rid));
    const code = rand();
    codes.set(sha(code), { ...p, exp: now() + 60 });
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    return c.redirect(u.href, 302);
  });

  async function authClient(c, b) { // none, client_secret_post or client_secret_basic
    let id = b.client_id, secret = b.client_secret;
    const basic = /^Basic (.+)$/.exec(c.req.header("authorization") ?? "");
    if (basic) [id, secret] = Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent);
    const client = clients.get(String(id ?? ""));
    if (!client) return undefined;
    if (client.secretHash ? !(secret && eq(sha(String(secret)), client.secretHash)) : secret !== undefined) return undefined;
    return client;
  }

  app.post("/token", async (c) => {
    const b = await c.req.parseBody(), client = await authClient(c, b);
    if (!client) return err(c, "invalid_client", "Client authentication failed", 401);
    if (b.resource && !same(b.resource, resource)) return err(c, "invalid_target", "Unknown resource");
    c.header("Cache-Control", "no-store");
    if (b.grant_type === "authorization_code") {
      const k = sha(String(b.code ?? "")), code = codes.get(k);
      codes.delete(k); // single use
      if (!code || code.clientId !== client.client_id || code.exp < now()) return err(c, "invalid_grant", "Invalid code");
      if (b.redirect_uri && b.redirect_uri !== code.redirectUri) return err(c, "invalid_grant", "redirect_uri mismatch");
      const challenge = createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url");
      if (!b.code_verifier || !eq(challenge, code.challenge)) return err(c, "invalid_grant", "PKCE verification failed");
      return c.json(issue(client.client_id, resource));
    }
    if (b.grant_type === "refresh_token") {
      const h = sha(String(b.refresh_token ?? "")), r = refresh.get(h);
      if (!r) { const f = used.get(h); if (f) revokeFamily(f); return err(c, "invalid_grant", "Invalid refresh token"); }
      if (r.clientId !== client.client_id || r.exp < now()) return err(c, "invalid_grant", "Invalid refresh token");
      refresh.delete(h);
      used.set(h, r.family);
      return c.json(issue(client.client_id, r.resource, r.family));
    }
    return err(c, "unsupported_grant_type", "Unsupported grant_type");
  });

  app.post("/revoke", async (c) => { // RFC 7009: always 200
    const b = await c.req.parseBody(), client = await authClient(c, b);
    if (!client) return err(c, "invalid_client", "Client authentication failed", 401);
    const h = sha(String(b.token ?? "")), hit = access.get(h) ?? refresh.get(h);
    if (hit && hit.clientId === client.client_id) revokeFamily(hit.family);
    return c.body(null, 200);
  });

  async function verify(token) {
    const a = access.get(sha(token));
    if (!a) throw new Error("invalid");
    return { token, clientId: a.clientId, scopes: [], expiresAt: a.exp, resource: new URL(a.resource) };
  }
  function mint({ expiresIn, aud }) { // test only
    const at = rand();
    access.set(sha(at), { clientId: "test", resource: aud ?? resource, exp: now() + expiresIn, family: rand() });
    return at;
  }
  return { verify, prmUrl, mint };
}
