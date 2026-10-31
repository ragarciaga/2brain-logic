// Candidate A: SDK 1.32.2. Auth router is Express-only, so Hono hands the OAuth paths to an
// Express app through @hono/node-server's raw request/response; /mcp uses the web-standard transport.
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import * as errors from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import express from "express"; // not a direct dependency: arrives through the SDK
import { Hono } from "hono";
import { bearerGate } from "../shared/bearer-hono.mjs";
import { loginPage } from "../shared/login-page.mjs";
import { makeProvider } from "../shared/provider.mjs";

const port = Number(process.env.PORT), base = `http://127.0.0.1:${port}`, resource = `${base}/mcp`;
const { provider, completeLogin, mint } = makeProvider({
  errors, resource, ownerHash: process.env.OWNER_PASSPHRASE_HASH,
  renderLogin: (res, v) => res.type("html").send(loginPage({ ...v, action: "/login" })),
});

const ex = express();
ex.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL(resource) }));
ex.post("/login", express.urlencoded({ extended: false }), async (req, res) => {
  const r = await completeLogin(req.body.rid, req.body.passphrase);
  if (r.redirect) return res.redirect(302, r.redirect);
  res.status(400).type("html").send(loginPage({ rid: req.body.rid, error: r.error, action: "/login" }));
});
const viaExpress = (c) => new Promise((resolve) => {
  c.env.outgoing.on("close", () => resolve(RESPONSE_ALREADY_SENT));
  ex(c.env.incoming, c.env.outgoing);
});

const app = new Hono();
for (const p of ["/authorize", "/token", "/register", "/revoke", "/login", "/.well-known/*"]) app.all(p, viaExpress);
if (process.env.SPIKE_TEST === "1") app.post("/__test/mint", async (c) => c.json({ token: mint(await c.req.json()) }));
app.all("/mcp", bearerGate({ verify: (t) => provider.verifyAccessToken(t), resource,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)) }), async (c) => {
  const server = new McpServer({ name: "spike-a", version: "0.0.0" });
  server.registerTool("ping", { description: "Health check" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c.req.raw, { authInfo: c.get("auth") });
  await server.close();
  return res;
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => console.log(`ready ${port}`));
