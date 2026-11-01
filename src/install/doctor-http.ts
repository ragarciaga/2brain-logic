import { isAllowedBaseUrl } from "../config/env.js";
import { PUBLIC_PATHS } from "../mcp/app.js";
import type { CheckOutcome, DoctorCheck } from "./doctor.js";

export const INTERNAL_TIMEOUT_MS = 5000;
export const PUBLIC_TIMEOUT_MS = 10000;

// Every fix line below is a fixed string. None holds response text, error text or an
// environment value, and none contains the word "git" (the redactor may replace the userinfo
// of `VAULT_REMOTE`, often "git", wherever it appears).
export const FIX_INGEST =
  "the ingest service did not answer on /health: run docker compose ps and docker compose logs brain";
export const FIX_MCP_INTERNAL =
  "the MCP service is not answering inside the Docker network: run docker compose ps and docker compose logs brain";
export const FIX_MCP_ISSUER =
  "the MCP service advertises a different address: check PUBLIC_BASE_URL in .env, then the logs with docker compose logs brain";
export const FIX_PROXY_METADATA =
  "the public address did not serve the OAuth metadata over https with the expected issuer: check the certificate and the proxy rules, see docs/INSTALL.md, Proxy section";
export const FIX_PROXY_MCP =
  "the public /mcp did not answer 401 without a token: route /mcp, /authorize, /token, /register, /revoke and /.well-known/ to the MCP port, see docs/INSTALL.md, Proxy section";
export const FIX_BASE_URL =
  "PUBLIC_BASE_URL is not a valid origin: fix it in .env, then re-run setup";
export const FIX_PORT = "PORT or MCP_PORT is not a port number from 0 to 65535: fix it in .env";

class TimedOut extends Error {}

interface ProbeResult {
  status: number;
  json?: unknown;
}

const fail = (fix: string): CheckOutcome => ({ status: "fail", fix });
const PASS: CheckOutcome = { status: "pass" };

function parsePort(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 65535 ? n : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * The four HTTP checks: `ingest_health`, `mcp_internal`, `proxy_metadata`, `proxy_mcp`.
 * No probe sends a credential, and every request is bounded by a timeout.
 */
export function createHttpChecks(opts: {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  internalHost?: string;
  timeouts?: { internalMs?: number; publicMs?: number };
}): DoctorCheck[] {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const host = opts.internalHost ?? "brain";
  const internalMs = opts.timeouts?.internalMs ?? INTERNAL_TIMEOUT_MS;
  const publicMs = opts.timeouts?.publicMs ?? PUBLIC_TIMEOUT_MS;

  async function probe(url: string, ms: number, wantJson: boolean): Promise<ProbeResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimedOut("timeout"));
      }, ms);
    });
    const work = (async (): Promise<ProbeResult> => {
      const res = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!wantJson) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status };
      }
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) as unknown };
      } catch {
        return { status: res.status };
      }
    })();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  const ports = () => ({
    ingest: parsePort(opts.env.PORT, 3000),
    mcp: parsePort(opts.env.MCP_PORT, 3001),
  });

  function origin(): string | undefined {
    const v = (opts.env.PUBLIC_BASE_URL ?? "").trim();
    if (!isAllowedBaseUrl(v)) return undefined;
    return new URL(v).origin;
  }

  const issuerOf = (r: ProbeResult): unknown => (isRecord(r.json) ? r.json.issuer : undefined);
  const metadataPath = PUBLIC_PATHS.authorizationServerMetadata;

  const ingestHealth: DoctorCheck = {
    id: "ingest_health",
    async run() {
      const port = ports().ingest;
      if (port === undefined) return fail(FIX_PORT);
      try {
        const r = await probe(`http://${host}:${port}/health`, internalMs, true);
        return r.status === 200 && isRecord(r.json) && r.json.ok === true ? PASS : fail(FIX_INGEST);
      } catch {
        return fail(FIX_INGEST);
      }
    },
  };

  const mcpInternal: DoctorCheck = {
    id: "mcp_internal",
    async run() {
      const port = ports().mcp;
      if (port === undefined) return fail(FIX_PORT);
      const base = origin();
      if (base === undefined) return fail(FIX_BASE_URL);
      try {
        const r = await probe(`http://${host}:${port}${metadataPath}`, internalMs, true);
        if (r.status !== 200) return fail(FIX_MCP_INTERNAL);
        return issuerOf(r) === base ? PASS : fail(FIX_MCP_ISSUER);
      } catch {
        return fail(FIX_MCP_INTERNAL);
      }
    },
  };

  const proxyMetadata: DoctorCheck = {
    id: "proxy_metadata",
    async run() {
      const base = origin();
      if (base === undefined) return fail(FIX_BASE_URL);
      if (new URL(base).protocol !== "https:") return fail(FIX_PROXY_METADATA);
      try {
        const r = await probe(`${base}${metadataPath}`, publicMs, true);
        return r.status === 200 && issuerOf(r) === base ? PASS : fail(FIX_PROXY_METADATA);
      } catch {
        return fail(FIX_PROXY_METADATA);
      }
    },
  };

  const proxyMcp: DoctorCheck = {
    id: "proxy_mcp",
    async run() {
      const base = origin();
      if (base === undefined) return fail(FIX_BASE_URL);
      try {
        const r = await probe(`${base}${PUBLIC_PATHS.mcp}`, publicMs, false);
        return r.status === 401 ? PASS : fail(FIX_PROXY_MCP);
      } catch {
        return fail(FIX_PROXY_MCP);
      }
    },
  };

  return [ingestHealth, mcpInternal, proxyMetadata, proxyMcp];
}
