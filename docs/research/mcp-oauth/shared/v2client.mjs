// Compatibility probe: a 2026-07-28-era client (SDK v2 @modelcontextprotocol/client 2.4.0) calls ping
// on a running spike with a test-minted token. Usage: node shared/v2client.mjs <port>
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = `http://127.0.0.1:${process.argv[2]}`;
const { token } = await (await fetch(`${base}/__test/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) })).json();
const client = new Client({ name: "v2probe", version: "0.0.0" });
const seen = new Set();
const fetchSpy = (url, init) => { seen.add(new Headers(init?.headers).get("mcp-protocol-version") ?? "none"); return fetch(url, init); };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchSpy }));
  const r = await client.callTool({ name: "ping", arguments: {} });
  console.log(JSON.stringify({ ok: r.content?.[0]?.text === "pong", protocolVersionsSent: [...seen] }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 200), protocolVersionsSent: [...seen] })); }
await client.close().catch(() => {});
