// Hono bearer gate for SDK v1 (v1 ships requireBearerAuth for Express only).
const same = (a, b) => String(a).replace(/#.*$/, "").replace(/\/$/, "") === String(b).replace(/#.*$/, "").replace(/\/$/, "");

export function bearerGate({ verify, resource, resourceMetadataUrl }) {
  return async (c, next) => {
    const deny = (code, msg) => {
      c.header("WWW-Authenticate", `Bearer error="${code}", error_description="${msg}", resource_metadata="${resourceMetadataUrl}"`);
      return c.json({ error: code, error_description: msg }, 401);
    };
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return deny("invalid_token", "Missing bearer token");
    let info;
    try { info = await verify(m[1]); } catch { return deny("invalid_token", "Invalid token"); }
    if (!(info.expiresAt > Date.now() / 1000)) return deny("invalid_token", "Token has expired");
    if (!same(info.resource, resource)) return deny("invalid_token", "Token was not issued for this resource");
    c.set("auth", info);
    await next();
  };
}
