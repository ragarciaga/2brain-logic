// OAuthServerProvider for candidates A and B (the SDK and @hono/mcp only ship the HTTP handlers;
// storage, owner login, token issuing and the audience rule are always the integrator's code).
// In-memory stores; the real service would persist clients and refresh tokens.
import { createHash, randomBytes } from "node:crypto";
import { verifyPassphrase } from "./owner.mjs";
import { redirectAllowed } from "./policy.mjs";

const sha = (t) => createHash("sha256").update(t).digest("base64url");
const rand = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const same = (a, b) => String(a).replace(/#.*$/, "").replace(/\/$/, "") === String(b).replace(/#.*$/, "").replace(/\/$/, "");

/**
 * @param errors the SDK error module (so handlers map throws to OAuth error responses)
 * @param renderLogin (target, view) => void; target is an Express res (A) or a Hono context (B)
 */
export function makeProvider({ errors: E, resource, ownerHash, renderLogin, accessTtl = 3600, refreshTtl = 30 * 86400 }) {
  const clients = new Map(), pending = new Map(), codes = new Map(), access = new Map(), refresh = new Map(), used = new Map();

  function issue(clientId, scopes, res, family = rand()) {
    const at = rand(), rt = rand();
    access.set(sha(at), { clientId, scopes, resource: res, exp: now() + accessTtl, family });
    refresh.set(sha(rt), { clientId, scopes, resource: res, exp: now() + refreshTtl, family });
    return { access_token: at, token_type: "Bearer", expires_in: accessTtl, refresh_token: rt, scope: scopes.join(" ") };
  }
  function revokeFamily(family) {
    for (const m of [access, refresh]) for (const [k, v] of m) if (v.family === family) m.delete(k);
  }

  const provider = {
    clientsStore: {
      getClient: async (id) => clients.get(id),
      registerClient: async (info) => {
        const bad = (info.redirect_uris ?? []).find((u) => !redirectAllowed(u));
        if (bad) throw new E.InvalidClientMetadataError(`redirect_uri not allowed: ${new URL(bad).host}`);
        clients.set(info.client_id, info);
        return info;
      },
    },
    async authorize(client, params, target) {
      if (params.resource && !same(params.resource, resource)) throw new E.InvalidTargetError("Unknown resource");
      const rid = rand();
      pending.set(rid, { clientId: client.client_id, params, exp: now() + 600, tries: 0 });
      renderLogin(target, { rid, clientName: client.client_name, redirectHost: new URL(params.redirectUri).host });
    },
    async challengeForAuthorizationCode(client, code) {
      const c = codes.get(code);
      if (!c || c.clientId !== client.client_id || c.exp < now()) throw new E.InvalidGrantError("Invalid authorization code");
      return c.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, res) {
      const c = codes.get(code);
      codes.delete(code); // single use
      if (!c || c.clientId !== client.client_id || c.exp < now()) throw new E.InvalidGrantError("Invalid authorization code");
      if (redirectUri && redirectUri !== c.redirectUri) throw new E.InvalidGrantError("redirect_uri mismatch");
      if (res && !same(res, c.resource)) throw new E.InvalidTargetError("resource mismatch");
      return issue(client.client_id, c.scopes, c.resource);
    },
    async exchangeRefreshToken(client, rt, _scopes, res) {
      const h = sha(rt), r = refresh.get(h);
      if (!r) {
        const family = used.get(h); // reuse of a rotated token: revoke the whole family
        if (family) revokeFamily(family);
        throw new E.InvalidGrantError("Invalid refresh token");
      }
      if (r.clientId !== client.client_id || r.exp < now()) throw new E.InvalidGrantError("Invalid refresh token");
      if (res && !same(res, r.resource)) throw new E.InvalidTargetError("resource mismatch");
      refresh.delete(h);
      used.set(h, r.family);
      return issue(client.client_id, r.scopes, r.resource, r.family);
    },
    async verifyAccessToken(token) {
      const a = access.get(sha(token));
      if (!a) throw new E.InvalidTokenError("Invalid token");
      return { token, clientId: a.clientId, scopes: a.scopes, expiresAt: a.exp, resource: new URL(a.resource) };
    },
    async revokeToken(client, { token }) {
      const h = sha(token), hit = access.get(h) ?? refresh.get(h);
      if (hit && hit.clientId === client.client_id) revokeFamily(hit.family);
    },
  };

  /** Owner form POST: returns the URL to redirect the browser to, or an error string for the page. */
  async function completeLogin(rid, passphrase) {
    const p = pending.get(rid);
    if (!p || p.exp < now()) return { error: "This sign-in link expired. Start again from your client." };
    if (!(await verifyPassphrase(passphrase, ownerHash))) {
      if (++p.tries >= 5) pending.delete(rid); // a pending sign-in allows 5 attempts
      return { error: "Wrong passphrase." };
    }
    pending.delete(rid);
    const code = rand();
    codes.set(code, {
      clientId: p.clientId, challenge: p.params.codeChallenge, redirectUri: p.params.redirectUri,
      resource: p.params.resource?.href ?? resource, scopes: p.params.scopes ?? [], exp: now() + 60,
    });
    const u = new URL(p.params.redirectUri);
    u.searchParams.set("code", code);
    if (p.params.state) u.searchParams.set("state", p.params.state);
    return { redirect: u.href };
  }

  /** Test-only: mint an access token with chosen expiry and audience (enabled by SPIKE_TEST=1). */
  function mint({ expiresIn, aud }) {
    const at = rand();
    access.set(sha(at), { clientId: "test", scopes: [], resource: aud ?? resource, exp: now() + expiresIn, family: rand() });
    return at;
  }

  return { provider, completeLogin, mint };
}
