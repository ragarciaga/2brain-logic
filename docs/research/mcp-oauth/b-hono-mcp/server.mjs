// Candidate B: @hono/mcp 0.3.5 (Hono-native auth router and transport, on top of SDK 1.x types and errors).
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { bearerAuth, mcpAuthRouter } from "@hono/mcp/auth";
import * as errors from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { loginPage } from "../shared/login-page.mjs";
import { makeProvider } from "../shared/provider.mjs";

const port = Number(process.env.PORT), base = `http://127.0.0.1:${port}`, resource = `${base}/mcp`;
const { provider, completeLogin, mint } = makeProvider({
  errors, resource, ownerHash: process.env.OWNER_PASSPHRASE_HASH,
  renderLogin: (c, v) => { c.res = c.html(loginPage({ ...v, action: "/login" })); },
});
const same = (a, b) => String(a).replace(/\/$/, "") === String(b).replace(/\/$/, "");

const app = new Hono();
app.route("/", mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: new URL(resource) }));
app.post("/login", async (c) => {
  const b = await c.req.parseBody();
  const r = await completeLogin(b.rid, b.passphrase);
  return r.redirect ? c.redirect(r.redirect, 302) : c.html(loginPage({ rid: b.rid, error: r.error, action: "/login" }), 400);
});
if (process.env.SPIKE_TEST === "1") app.post("/__test/mint", async (c) => c.json({ token: mint(await c.req.json()) }));
app.all("/mcp", bearerAuth({
  verifyToken: async (token, c) => {
    try {
      const info = await provider.verifyAccessToken(token);
      if (!(info.expiresAt > Date.now() / 1000) || !same(info.resource, resource)) return false;
      c.set("auth", info);
      return true;
    } catch { return false; }
  },
}), async (c) => {
  const server = new McpServer({ name: "spike-b", version: "0.0.0" });
  server.registerTool("ping", { description: "Health check" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  await server.close();
  return res;
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => console.log(`ready ${port}`));
