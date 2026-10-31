// Candidate C2: hand-rolled AS (../c-handrolled/as.mjs) + SDK v2 @modelcontextprotocol/server 2.4.0
// (web-standard createMcpHandler and requireBearerAuth; no Express anywhere).
import { serve } from "@hono/node-server";
import { McpServer, OAuthError, OAuthErrorCode, createMcpHandler, requireBearerAuth } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { mountAuth } from "../c-handrolled/as.mjs";

const port = Number(process.env.PORT), base = `http://127.0.0.1:${port}`, resource = `${base}/mcp`;
const app = new Hono();
const { verify, prmUrl, mint } = mountAuth(app, { issuer: base, resource, ownerHash: process.env.OWNER_PASSPHRASE_HASH });
if (process.env.SPIKE_TEST === "1") app.post("/__test/mint", async (c) => c.json({ token: mint(await c.req.json()) }));
const gate = requireBearerAuth({ verifier: {
  verifyAccessToken: (t) => verify(t).catch(() => { throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token"); }),
}, resourceMetadataUrl: prmUrl, expectedResource: new URL(resource) });
const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "spike-c2", version: "0.0.0" });
  server.registerTool("ping", { description: "Health check" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
});
app.all("/mcp", async (c) => {
  const auth = await gate(c.req.raw);
  return auth instanceof Response ? auth : mcp.fetch(c.req.raw, { authInfo: auth });
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => console.log(`ready ${port}`));
