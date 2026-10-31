import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { type VaultConfig, VaultConfigSchema } from "../src/config/vault-config.js";
import { createMcpServer, type McpServerDeps } from "../src/mcp/server.js";
import { buildVaultInfo, createInfoTools } from "../src/mcp/tools/info.js";
import type { VaultWriter } from "../src/vault/write-note.js";

const RESOURCE = "https://brain.example.com/mcp";
const MARKER = "zz-marker-7431";

let dir: string;
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "info-tool-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const writeConfig = (text: string, root = dir) => {
  mkdirSync(join(root, ".2brain"), { recursive: true });
  writeFileSync(join(root, ".2brain", "config.yaml"), text);
};

interface Reply {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

async function connect(writer: VaultWriter, vaultDir = dir) {
  const deps: McpServerDeps = { writer, config: { vaultDir } };
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init);
    if (incoming.method !== "POST") return new Response(null, { status: 405 });
    const text = await incoming.text();
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const server = createMcpServer(deps, createInfoTools());
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(
        new Request(RESOURCE, { method: "POST", headers, body: text }),
        { parsedBody: JSON.parse(text) },
      );
      return new Response(await res.text(), { status: res.status, headers: res.headers });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
  const client = new Client({ name: "test-client", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch: fetchLike }));
  return {
    client,
    async call(args: Record<string, unknown> = {}): Promise<Reply> {
      const res = (await client.callTool({ name: "vault_info", arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.map((c) => c.text ?? "").join("\n");
      return { isError: res.isError === true, data: res.structuredContent ?? {}, text };
    },
  };
}

const writerOf = (stale = false, before?: () => void): VaultWriter =>
  ({
    withPulled: async (fn: (info: { stale: boolean }) => Promise<unknown>) => {
      before?.();
      return fn({ stale });
    },
  }) as unknown as VaultWriter;

const expectedTypes = (config: VaultConfig) =>
  Object.entries(config.types).map(([key, entry]) => ({
    key,
    value: entry.value,
    folder: entry.folder ?? null,
  }));

describe("vault_info", () => {
  it("D1: with no config the answer is exactly the defaults", async () => {
    const { call } = await connect(writerOf());
    const r = await call();
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      ok: true,
      areas: DEFAULT_VAULT_CONFIG.areas,
      properties: DEFAULT_VAULT_CONFIG.properties,
      types: expectedTypes(DEFAULT_VAULT_CONFIG),
      archive_folder: DEFAULT_VAULT_CONFIG.vault.archive_folder,
    });
    expect(Object.keys(r.data).sort()).toEqual(
      ["archive_folder", "areas", "ok", "properties", "types"].sort(),
    );
    for (const type of r.data.types as Array<Record<string, unknown>>) {
      expect(Object.keys(type).sort()).toEqual(["folder", "key", "value"]);
    }
  });

  it("R10.2: only the allowlisted fields, types in declaration order, folder null when absent", async () => {
    writeConfig(
      [
        "areas: [alpha, beta]",
        "sources: [secret-source-name]",
        "vault:",
        "  archive_folder: old",
        "  inbox_folder: intake",
        "types:",
        "  zeta: { value: zed, folder: '{area}/z', immutable_body: true }",
        "  alpha: { value: first }",
        "",
      ].join("\n"),
    );
    const { call } = await connect(writerOf());
    const r = await call();
    expect(r.data.types).toEqual([
      { key: "zeta", value: "zed", folder: "{area}/z" },
      { key: "alpha", value: "first", folder: null },
    ]);
    expect(r.data.archive_folder).toBe("old");
    for (const leaked of ["sources", "inbox_folder", "intake", "immutable_body", "version"]) {
      expect(r.text).not.toContain(leaked);
    }
    expect(r.text).not.toContain("secret-source-name");
  });

  it("R10.2: no env value, server setting or note content in the answer", async () => {
    vi.stubEnv("INGEST_TOKEN", MARKER);
    const root = mkdtempSync(join(tmpdir(), `info-${MARKER}-`));
    try {
      writeFileSync(join(root, "note.md"), `${MARKER}-body`);
      const { call } = await connect(writerOf(), root);
      const r = await call();
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain(MARKER);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildVaultInfo ignores extra fields of its input", () => {
    const config = {
      ...DEFAULT_VAULT_CONFIG,
      extra: MARKER,
      vault: { ...DEFAULT_VAULT_CONFIG.vault, secret: MARKER },
      properties: { ...DEFAULT_VAULT_CONFIG.properties, extra: MARKER },
      types: { one: { value: "one", extra: MARKER } },
    } as unknown as VaultConfig;
    const info = buildVaultInfo(config);
    expect(JSON.stringify(info)).not.toContain(MARKER);
    expect(Object.keys(info).sort()).toEqual(["archive_folder", "areas", "properties", "types"]);
    expect(info.types).toEqual([{ key: "one", value: "one", folder: null }]);
  });

  it("D2: a failed pull only adds stale: true", async () => {
    const fresh = await (await connect(writerOf(false))).call();
    const stale = await (await connect(writerOf(true))).call();
    expect(fresh.data.stale).toBeUndefined();
    expect(stale.isError).toBe(false);
    expect(stale.data).toEqual({ ...fresh.data, stale: true });
  });

  it("D5: the config is read after the pull", async () => {
    const { call } = await connect(writerOf(false, () => writeConfig("areas: [afterpull]\n")));
    const r = await call();
    expect(r.data.areas).toEqual(["afterpull"]);
  });

  it("D3: an invalid config gives config_invalid without path or key text", async () => {
    writeConfig("version: 2\n");
    const { call } = await connect(writerOf());
    const r = await call();
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ ok: false, error: "config_invalid" });
    expect(r.text).not.toContain("version");
    expect(r.text).not.toContain(dir);
  });

  it("D3: a directory in place of the config gives internal_error", async () => {
    mkdirSync(join(dir, ".2brain", "config.yaml"), { recursive: true });
    const { call } = await connect(writerOf());
    const r = await call();
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ ok: false, error: "internal_error" });
    expect(r.text).not.toContain("config.yaml");
    expect(r.text).not.toContain(dir);
  });

  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canChmod)("D3: an unreadable config (mode 000) gives internal_error", async () => {
    writeConfig("areas: [alpha]\n");
    const file = join(dir, ".2brain", "config.yaml");
    chmodSync(file, 0o000);
    try {
      const { call } = await connect(writerOf());
      const r = await call();
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({ ok: false, error: "internal_error" });
      expect(r.text).not.toContain(dir);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("D4: advertises no input and ignores an unexpected argument", async () => {
    const { client, call } = await connect(writerOf());
    const tool = (await client.listTools()).tools.find((t) => t.name === "vault_info");
    const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toEqual({});
    const r = await call({ unexpected: "x" });
    expect(r.isError).toBe(false);
    expect(r.data.ok).toBe(true);
  });

  it("the defaults parse through the real schema the same way", () => {
    expect(buildVaultInfo(VaultConfigSchema.parse({})).areas).toEqual(DEFAULT_VAULT_CONFIG.areas);
  });
});
