import {
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import {
  allowedMcpOrigins,
  bearerChallenge,
  checkBearer,
  forbiddenOrigin,
  isAllowedOrigin,
} from "../auth/oauth/bearer.js";
import type { AuthStore } from "../auth/oauth/store.js";
import type { VaultWriter } from "../vault/write-note.js";
import { PUBLIC_PATHS, type PublicAppEnv, type PublicUrls } from "./app.js";
import { READ_TOOLS } from "./tools/read.js";

/**
 * The protected MCP endpoint on the public app (R2.1, R6.1 to R6.3).
 *
 * - Order on `/mcp`: Origin check, Bearer check, body limit, then the SDK. A request that fails an
 *   earlier step never reaches a later one, and its body is never read.
 * - Stateless and JSON only: a fresh server and transport per request, no session id, no SSE.
 * - The SDK never receives the incoming request. The handler reads the body once and builds a
 *   canonical request on the configured resource URL with a small allowlist of headers.
 * - Every answer carries `Cache-Control: no-store`. Bodies of errors built here are fixed strings.
 *   SDK errors are never logged: only the line `mcp: protocol_error`.
 */

export const MCP_SERVER_INFO = Object.freeze({ name: "2brain", version: "0.1.0" });

/** Twice the ingest body cap, to leave room for the JSON-RPC envelope. */
export const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** How long one request may take before the transport and server are closed. */
export const MCP_DEADLINE_MS = 60_000;

export interface McpServerConfig {
  /** Tools re-read the vault config from here on every call. */
  vaultDir: string;
}

export interface McpServerDeps {
  writer: VaultWriter;
  config: McpServerConfig;
}

export interface McpToolDefinition {
  name: string;
  register(server: McpServer, deps: McpServerDeps): void;
}

/** The tool registry. T13 adds its entries here. */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([...READ_TOOLS]);

/** Builds the SDK server with every tool of the registry registered with `deps`. */
export function createMcpServer(deps: McpServerDeps, tools = MCP_TOOLS): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { tools: {} } });
  for (const tool of tools) tool.register(server, deps);
  return server;
}

const rpcError = (code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });

const BODIES = Object.freeze({
  tooLarge: rpcError(-32000, "Request body too large"),
  notAllowed: rpcError(-32000, "Method not allowed."),
  unsupported: rpcError(-32022, "Unsupported protocol version"),
  timeout: rpcError(-32001, "Request timed out"),
});

const FORWARDED_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
] as const;

function fixed(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export interface McpRouteOptions {
  store: AuthStore;
  urls: PublicUrls;
  allowedRedirectHosts: readonly string[];
  deps: McpServerDeps;
  log: (line: string) => void;
  /** Test seam for the tool registry. Production never sets it. */
  tools?: readonly McpToolDefinition[];
  /** Test seam for the per-request deadline. Production never sets it. */
  deadlineMs?: number;
}

export function registerMcpRoute(app: Hono<PublicAppEnv>, options: McpRouteOptions): void {
  const { store, urls, allowedRedirectHosts, deps, log } = options;
  const deadlineMs = options.deadlineMs ?? MCP_DEADLINE_MS;
  const origins = allowedMcpOrigins(urls.issuer, allowedRedirectHosts);

  const originCheck = createMiddleware<PublicAppEnv>(async (c, next) => {
    if (!isAllowedOrigin(c.req.header("origin"), origins)) return forbiddenOrigin();
    await next();
  });

  const bearerCheck = createMiddleware<PublicAppEnv>(async (c, next) => {
    const checked = checkBearer(c.req.header("authorization"), store, c.var.urls);
    if (!checked.ok) return bearerChallenge(c.var.urls, checked.invalidToken);
    c.set("mcpAuth", checked.authInfo);
    await next();
  });

  app.all(
    PUBLIC_PATHS.mcp,
    originCheck,
    bearerCheck,
    bodyLimit({
      maxSize: MCP_MAX_BODY_BYTES,
      onError: () => fixed(413, BODIES.tooLarge),
    }),
    async (c) => {
      if (c.req.method !== "POST") return fixed(405, BODIES.notAllowed, { allow: "POST" });
      const authInfo = c.get("mcpAuth");
      const text = await c.req.text();
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(c.var.urls.resource, { method: "POST", headers, body: text });
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = undefined;
      }
      if (
        !(await isLegacyRequest(request, parsedBody, { maxRequestBodySize: MCP_MAX_BODY_BYTES }))
      ) {
        return fixed(400, BODIES.unsupported);
      }

      const server = createMcpServer(deps, options.tools);
      server.server.onerror = () => log("mcp: protocol_error");
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MCP_MAX_BODY_BYTES,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await server.connect(transport);
        const timedOut = Symbol("timeout");
        const result = await Promise.race([
          transport.handleRequest(request, { authInfo, parsedBody }),
          new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(() => resolve(timedOut), deadlineMs);
          }),
        ]);
        if (result === timedOut) return fixed(503, BODIES.timeout);
        const out = new Headers(result.headers);
        out.set("cache-control", "no-store");
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers: out,
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  );
}
