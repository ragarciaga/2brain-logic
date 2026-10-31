// Memory probe: RSS of a spike after N raw tools/call requests with a test-minted token.
// Usage: node shared/memprobe.mjs <candidate-dir> <port>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashPassphrase } from "./owner.mjs";

const [dir, port] = process.argv.slice(2), base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(resolve(dir), "server.mjs")], {
  env: { ...process.env, PORT: port, SPIKE_TEST: "1", OWNER_PASSPHRASE_HASH: await hashPassphrase("probe-only") }, stdio: "ignore" });
const rss = () => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"))[1]) / 1024);
for (;;) { try { if ((await fetch(`${base}/.well-known/oauth-authorization-server`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 10)); }
const { token } = await (await fetch(`${base}/__test/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) })).json();
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
const marks = { start: rss() };
let n = 0, fail = 0;
for (const target of [100, 1000, 5000]) {
  for (; n < target; n++) { const t = await (await fetch(`${base}/mcp`, { method: "POST", headers, body })).text(); if (!t.includes("pong")) fail++; }
  marks[target] = rss();
}
child.kill();
console.log(JSON.stringify({ candidate: dir, rssMb: marks, failures: fail }));
