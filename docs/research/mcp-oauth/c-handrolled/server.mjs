// Candidate C1: hand-rolled AS (as.mjs) + SDK 1.32.2 web-standard Streamable HTTP transport, all in Hono.
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bearerGate } from "../shared/bearer-hono.mjs";
import { mountAuth } from "./as.mjs";

const port = Number(process.env.PORT), base = `http://127.0.0.1:${port}`, resource = `${base}/mcp`;
const app = new Hono();
const { verify, prmUrl, mint } = mountAuth(app, { issuer: base, resource, ownerHash: process.env.OWNER_PASSPHRASE_HASH });
if (process.env.SPIKE_TEST === "1") app.post("/__test/mint", async (c) => c.json({ token: mint(await c.req.json()) }));
app.all("/mcp", bearerGate({ verify, resource, resourceMetadataUrl: prmUrl }), async (c) => {
  const server = new McpServer({ name: "spike-c1", version: "0.0.0" });
  server.registerTool("ping", { description: "Health check" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c.req.raw, { authInfo: c.get("auth") });
  await server.close();
  return res;
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => console.log(`ready ${port}`));
