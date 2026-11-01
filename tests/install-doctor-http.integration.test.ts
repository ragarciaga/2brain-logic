import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeStore } from "../src/auth/oauth/codes.js";
import { type AuthStore, openAuthStore } from "../src/auth/oauth/store.js";
import { type CheckId, type DoctorCheck, runDoctor } from "../src/install/doctor.js";
import {
  createHttpChecks,
  FIX_BASE_URL,
  FIX_INGEST,
  FIX_MCP_INTERNAL,
  FIX_MCP_ISSUER,
  FIX_PORT,
  FIX_PROXY_MCP,
  FIX_PROXY_METADATA,
  INTERNAL_TIMEOUT_MS,
  PUBLIC_TIMEOUT_MS,
} from "../src/install/doctor-http.js";
import { createPublicApp } from "../src/mcp/app.js";
import type { McpServerDeps } from "../src/mcp/server.js";

const ORIGIN = "https://brain.example.com";
const LOCAL = "127.0.0.1";
// Built from parts at runtime so no secret-shaped literal sits in the source.
const TOKEN_VALUE = ["tok", "planted", "7f3a9c"].join("-");
const HASH_VALUE = ["scrypt", "16384", "8", "1", "c2FsdA", "a2V5a2V5"].join("$");

const servers: Server[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const c of cleanups.splice(0)) c();
});

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}
const seen: Seen[] = [];
afterEach(() => {
  seen.length = 0;
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  if (!server.listening) await new Promise<void>((r) => server.listen(0, LOCAL, () => r()));
  return (server.address() as AddressInfo).port;
}

/** A stub that records each request and answers with `reply`; `null` never answers. */
function stub(
  reply: { status: number; body?: string; headers?: Record<string, string> } | null,
): Promise<number> {
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    if (reply === null) return;
    res.writeHead(reply.status, reply.headers ?? {});
    res.end(reply.body ?? "");
  });
  return listen(server);
}

const deps: McpServerDeps = {
  writer: {
    write: async () => ({ path: "x.md", commit: "abc" }),
    patch: async () => ({ path: "x.md", commit: "abc" }),
    archive: async () => ({ path: "archive/x.md", commit: "abc" }),
    withPulled: (fn) => fn({ stale: false }),
  },
  config: { vaultDir: "/nonexistent-vault" },
};

/** The real public app, served on a loopback port. */
async function realApp(opts: { baseUrl?: string; withAuth?: boolean } = {}): Promise<number> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-doctor-http-")));
  mkdirSync(join(root, "vault"));
  const store: AuthStore = await openAuthStore({
    dir: join(root, "auth"),
    vaultDir: join(root, "vault"),
    now: () => new Date(),
    log: () => undefined,
  });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const withAuth = opts.withAuth !== false;
  const { app } = createPublicApp({
    baseUrl: opts.baseUrl ?? ORIGIN,
    log: () => undefined,
    mcp: withAuth ? deps : undefined,
    auth: withAuth
      ? {
          store,
          allowedRedirectHosts: ["claude.ai"],
          trustProxyHops: 1,
          ownerPassphraseHash: "stored-hash",
          codes: createCodeStore(),
        }
      : undefined,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: LOCAL });
  return listen(server as unknown as Server);
}

/** Maps the https origin onto a local port; everything else goes through unchanged. */
function mapped(port: number): typeof fetch {
  return (input, init) => {
    const url = String(input).replace(ORIGIN, `http://${LOCAL}:${port}`);
    return fetch(url, init);
  };
}

const find = (checks: DoctorCheck[], id: CheckId) => checks.find((c) => c.id === id) as DoctorCheck;
const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PUBLIC_BASE_URL: ORIGIN,
  ...extra,
});
const OK_JSON = { "content-type": "application/json" };
const metadata = (issuer: string) => ({
  status: 200,
  body: JSON.stringify({ issuer }),
  headers: OK_JSON,
});

function ingest(port: number, extra: Partial<Parameters<typeof createHttpChecks>[0]> = {}) {
  return find(
    createHttpChecks({
      env: baseEnv({ PORT: String(port) }),
      internalHost: LOCAL,
      ...extra,
    }),
    "ingest_health",
  );
}

function mcpInternal(port: number, extra: Partial<Parameters<typeof createHttpChecks>[0]> = {}) {
  return find(
    createHttpChecks({
      env: baseEnv({ MCP_PORT: String(port) }),
      internalHost: LOCAL,
      ...extra,
    }),
    "mcp_internal",
  );
}

function proxy(id: CheckId, port: number, env: NodeJS.ProcessEnv = baseEnv()) {
  return find(createHttpChecks({ env, fetch: mapped(port) }), id);
}

const hanging: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("R4.9: ingest_health", () => {
  it("passes on 200 {ok:true} and requests /health", async () => {
    const port = await stub({ status: 200, body: '{"ok":true}', headers: OK_JSON });
    expect(await ingest(port).run()).toEqual({ status: "pass" });
    expect(seen.map((s) => s.path)).toEqual(["/health"]);
  });

  it("fails on 500", async () => {
    const port = await stub({ status: 500, body: '{"ok":true}' });
    expect(await ingest(port).run()).toEqual({ status: "fail", fix: FIX_INGEST });
  });

  it("fails on 200 {ok:false}", async () => {
    const port = await stub({ status: 200, body: '{"ok":false}' });
    expect(await ingest(port).run()).toEqual({ status: "fail", fix: FIX_INGEST });
  });

  it("fails on 200 non-JSON", async () => {
    const port = await stub({ status: 200, body: "<html>ok</html>" });
    expect(await ingest(port).run()).toEqual({ status: "fail", fix: FIX_INGEST });
  });

  it("fails on a refused port", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    expect(await ingest(port).run()).toEqual({ status: "fail", fix: FIX_INGEST });
  });

  it("fails when the server never answers", async () => {
    const port = await stub(null);
    const out = await ingest(port, { timeouts: { internalMs: 200 } }).run();
    expect(out).toEqual({ status: "fail", fix: FIX_INGEST });
  });

  it("is still pending at 4999 ms, fails at 5000 and aborts the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    const spy: typeof fetch = (input, init) => {
      signal = init?.signal ?? undefined;
      return hanging(input, init);
    };
    const check = find(
      createHttpChecks({ env: baseEnv(), fetch: spy, internalHost: LOCAL }),
      "ingest_health",
    );
    let outcome: unknown;
    const run = check.run().then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(INTERNAL_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(outcome).toEqual({ status: "fail", fix: FIX_INGEST });
    expect(signal?.aborted).toBe(true);
  });

  it("fails with FIX_PORT on PORT=abc and on a port above 65535", async () => {
    for (const bad of ["abc", "65536", "-1"]) {
      const check = find(
        createHttpChecks({ env: baseEnv({ PORT: bad }), internalHost: LOCAL }),
        "ingest_health",
      );
      expect(await check.run()).toEqual({ status: "fail", fix: FIX_PORT });
    }
  });
});

describe("D1: mcp_internal", () => {
  it("passes against the real app", async () => {
    const port = await realApp();
    expect(await mcpInternal(port).run()).toEqual({ status: "pass" });
  });

  it("fails with FIX_MCP_ISSUER when the app advertises another issuer", async () => {
    const port = await realApp({ baseUrl: "https://other.example.com" });
    expect(await mcpInternal(port).run()).toEqual({ status: "fail", fix: FIX_MCP_ISSUER });
  });

  it("fails on 500", async () => {
    const port = await stub({ status: 500 });
    expect(await mcpInternal(port).run()).toEqual({ status: "fail", fix: FIX_MCP_INTERNAL });
  });

  it("fails when the server never answers", async () => {
    const port = await stub(null);
    const out = await mcpInternal(port, { timeouts: { internalMs: 200 } }).run();
    expect(out).toEqual({ status: "fail", fix: FIX_MCP_INTERNAL });
  });
});

describe("R4.11, R4.12: proxy_metadata", () => {
  it("passes against the real app and requests the metadata path", async () => {
    const port = await realApp();
    expect(await proxy("proxy_metadata", port).run()).toEqual({ status: "pass" });
  });

  it("fails on another issuer", async () => {
    const port = await stub(metadata("https://other.example.com"));
    expect(await proxy("proxy_metadata", port).run()).toEqual({
      status: "fail",
      fix: FIX_PROXY_METADATA,
    });
  });

  it("fails on 500", async () => {
    const port = await stub({ status: 500 });
    expect((await proxy("proxy_metadata", port).run()).status).toBe("fail");
  });

  it.each([500, 203])("fails on %i even when the body holds the right issuer", async (status) => {
    const port = await stub({ ...metadata(ORIGIN), status });
    expect(await proxy("proxy_metadata", port).run()).toEqual({
      status: "fail",
      fix: FIX_PROXY_METADATA,
    });
  });

  it("fails on a redirect to http and does not follow it", async () => {
    const hits = { n: 0 };
    const target = createServer((_req, res) => {
      hits.n += 1;
      res.writeHead(200, OK_JSON);
      res.end(JSON.stringify({ issuer: ORIGIN }));
    });
    const p2 = await listen(target);
    const port = await stub({
      status: 302,
      headers: { location: `http://${LOCAL}:${p2}/.well-known/oauth-authorization-server` },
    });
    expect(await proxy("proxy_metadata", port).run()).toEqual({
      status: "fail",
      fix: FIX_PROXY_METADATA,
    });
    expect(hits.n).toBe(0);
  });

  it("fails on a TLS error without echoing its text", async () => {
    const throwing: typeof fetch = async () => {
      throw new TypeError("fetch failed PLANTED-x", {
        cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "PLANTED-x" },
      });
    };
    const check = find(createHttpChecks({ env: baseEnv(), fetch: throwing }), "proxy_metadata");
    const out = await check.run();
    expect(out).toEqual({ status: "fail", fix: FIX_PROXY_METADATA });
    expect(JSON.stringify(out)).not.toContain("PLANTED");
    expect(FIX_PROXY_METADATA).toContain("docs/INSTALL.md, Proxy section");
  });

  it("fails for a plain http base URL", async () => {
    const port = await stub(metadata(`http://${LOCAL}:1`));
    const env = baseEnv({ PUBLIC_BASE_URL: `http://${LOCAL}:${port}` });
    const check = find(createHttpChecks({ env }), "proxy_metadata");
    expect(await check.run()).toEqual({ status: "fail", fix: FIX_PROXY_METADATA });
    expect(seen).toEqual([]);
  });

  it("fails with FIX_BASE_URL on a base URL with a path", async () => {
    const check = find(
      createHttpChecks({ env: baseEnv({ PUBLIC_BASE_URL: `${ORIGIN}/x` }) }),
      "proxy_metadata",
    );
    expect(await check.run()).toEqual({ status: "fail", fix: FIX_BASE_URL });
  });

  it("fails at 10000 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const check = find(createHttpChecks({ env: baseEnv(), fetch: hanging }), "proxy_metadata");
    let outcome: unknown;
    const run = check.run().then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(PUBLIC_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(outcome).toEqual({ status: "fail", fix: FIX_PROXY_METADATA });
  });
});

describe("R4.13: proxy_mcp", () => {
  it("passes against the real app, which answers 401 without a token", async () => {
    const port = await realApp();
    expect(await proxy("proxy_mcp", port).run()).toEqual({ status: "pass" });
  });

  it("fails against the real app without auth (404) and lists the six paths", async () => {
    const port = await realApp({ withAuth: false });
    const out = await proxy("proxy_mcp", port).run();
    expect(out).toEqual({ status: "fail", fix: FIX_PROXY_MCP });
    for (const p of ["/mcp", "/authorize", "/token", "/register", "/revoke", "/.well-known/"]) {
      expect(FIX_PROXY_MCP).toContain(p);
    }
  });

  it("fails on a stub that answers 200", async () => {
    const port = await stub({ status: 200 });
    expect(await proxy("proxy_mcp", port).run()).toEqual({ status: "fail", fix: FIX_PROXY_MCP });
  });

  it("fails when the request throws", async () => {
    const throwing: typeof fetch = async () => {
      throw new TypeError("boom");
    };
    const check = find(createHttpChecks({ env: baseEnv(), fetch: throwing }), "proxy_mcp");
    expect(await check.run()).toEqual({ status: "fail", fix: FIX_PROXY_MCP });
  });
});

describe("D2: fix hygiene", () => {
  const secrets = baseEnv({ INGEST_TOKEN: TOKEN_VALUE, OWNER_PASSPHRASE_HASH: HASH_VALUE });
  const echo = {
    status: 500,
    body: JSON.stringify({ leak: TOKEN_VALUE, also: HASH_VALUE }),
    headers: { "x-leak": TOKEN_VALUE, "x-also": HASH_VALUE },
  };

  it("no fix holds an echoed body, header or env value, and no probe sends credentials", async () => {
    const port = await stub(echo);
    const checks = createHttpChecks({
      env: { ...secrets, PORT: String(port), MCP_PORT: String(port) },
      internalHost: LOCAL,
      fetch: mapped(port),
    });
    for (const check of checks) {
      const out = await check.run();
      expect(out.status).toBe("fail");
      const text = JSON.stringify(out);
      expect(text).not.toContain(TOKEN_VALUE);
      expect(text).not.toContain(HASH_VALUE);
    }
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.headers.origin).toBeUndefined();
      expect(s.headers.cookie).toBeUndefined();
    }
  });

  it("every exported fix is non-empty with no git word and no em dash", () => {
    const fixes = [
      FIX_INGEST,
      FIX_MCP_INTERNAL,
      FIX_MCP_ISSUER,
      FIX_PROXY_METADATA,
      FIX_PROXY_MCP,
      FIX_BASE_URL,
      FIX_PORT,
    ];
    const dash = String.fromCharCode(0x2014);
    for (const fix of fixes) {
      expect(fix.trim()).not.toBe("");
      expect(fix).not.toMatch(/git/i);
      expect(fix).not.toContain(dash);
    }
  });
});

describe("runner integration", () => {
  const pass = async () => ({ status: "pass" as const });
  const stubs = (): DoctorCheck[] =>
    (
      [
        "env",
        "env_file",
        "secrets",
        "network",
        "remote_reachable",
        "remote_pushable",
        "vault_config",
      ] as const
    ).map((id) => ({ id, run: pass }));

  it("prints each failing fix verbatim, with no redaction marker", async () => {
    const throwing: typeof fetch = async () => {
      throw new TypeError("boom");
    };
    const env = baseEnv({ VAULT_REMOTE: "ssh://git@host.example.com/x.git" });
    const lines: string[] = [];
    const code = await runDoctor([...stubs(), ...createHttpChecks({ env, fetch: throwing })], {
      env,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    const expected: Record<string, string> = {
      ingest_health: FIX_INGEST,
      mcp_internal: FIX_MCP_INTERNAL,
      proxy_metadata: FIX_PROXY_METADATA,
      proxy_mcp: FIX_PROXY_MCP,
    };
    for (const [id, fix] of Object.entries(expected)) {
      const at = lines.indexOf(`fail  ${id}`);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines[at + 1]).toBe(`      fix: ${fix}`);
    }
    expect(lines.join("\n")).not.toContain("<redacted>");
  });

  it("with a blank PUBLIC_BASE_URL only the ingest URL is requested", async () => {
    const urls: string[] = [];
    const spy: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    };
    const env: NodeJS.ProcessEnv = { PUBLIC_BASE_URL: "  " };
    const code = await runDoctor([...stubs(), ...createHttpChecks({ env, fetch: spy })], {
      env,
      out: () => undefined,
    });
    expect(code).toBe(0);
    expect(urls).toEqual(["http://brain:3000/health"]);
  });
});
