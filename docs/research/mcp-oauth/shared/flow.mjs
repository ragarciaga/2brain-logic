// Scripted client: drives the same OAuth + MCP test set against one spike server.
// Usage: node shared/flow.mjs <candidate-dir> <port>
// Writes results/<candidate>.json. The owner passphrase is random per run and never written.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashPassphrase } from "./owner.mjs";

const [dir, portArg] = process.argv.slice(2);
const name = basename(resolve(dir)), port = Number(portArg), base = `http://127.0.0.1:${port}`, mcpUrl = `${base}/mcp`;
const passphrase = randomBytes(18).toString("base64url");
const results = [];
const redact = (s) => (s === undefined ? s : String(s).replace(/(code|token)=[^&\s"]+/g, "$1=REDACTED"));
const step = (id, ok, d) => { const detail = redact(d); results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail ?? ""}`); };
const b64 = (buf) => buf.toString("base64url");
const pkce = () => { const v = b64(randomBytes(32)); return { verifier: v, challenge: b64(createHash("sha256").update(v).digest()) }; };
const rss = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]);

async function startServer(env) {
  const t0 = performance.now();
  const child = spawn(process.execPath, [join(resolve(dir), "server.mjs")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  for (;;) {
    try { if ((await fetch(`${base}/.well-known/oauth-authorization-server`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 5));
    if (performance.now() - t0 > 15000) throw new Error("server did not start");
  }
  return { child, coldMs: Math.round(performance.now() - t0) };
}

const ownerHash = await hashPassphrase(passphrase);
const env = { PORT: String(port), OWNER_PASSPHRASE_HASH: ownerHash, SPIKE_TEST: "1" };
const colds = [];
for (let i = 0; i < 5; i++) { const s = await startServer(env); colds.push(s.coldMs); s.child.kill(); await new Promise((r) => s.child.on("exit", r)); }
const { child } = await startServer(env);
const rssIdleKb = rss(child.pid);

// Browser simulation: open the authorize URL, read the owner form, post the passphrase.
async function login(authUrl, pass = passphrase) {
  const page = await fetch(authUrl, { redirect: "manual" });
  const html = page.status === 200 ? await page.text() : "";
  const rid = /name="rid" value="([^"]+)"/.exec(html)?.[1];
  if (!rid) return { status: page.status, location: page.headers.get("location"), body: html || (await page.text().catch(() => "")) };
  const res = await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ rid, passphrase: pass }) });
  return { status: res.status, location: res.headers.get("location"), rid, page: html };
}
const form = (path, params, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers, body: new URLSearchParams(params) });
async function token(params, client, auth) {
  const p = { ...params }, h = {};
  if (auth === "basic") h.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
  else { p.client_id = client.client_id; if (auth === "post") p.client_secret = client.client_secret; }
  const res = await form("/token", p, h);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function mcpCall(accessToken) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
  });
  const text = await res.text();
  return { status: res.status, pong: text.includes("pong"), www: res.headers.get("www-authenticate"), text: text.slice(0, 200) };
}
const register = async (meta) => { const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) }); return { status: r.status, body: await r.json().catch(() => null) }; };
function authUrl(client, { redirectUri, resource, method = "S256", challenge, scope, state = "st-1" }) {
  const u = new URL(`${base}/authorize`);
  const q = { client_id: client.client_id, response_type: "code", redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state, resource, scope };
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}
const codeFrom = (loc) => { try { return new URL(loc).searchParams.get("code"); } catch { return null; } };

try {
  // S1-S2 discovery from a 401
  const r401 = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  const www = r401.headers.get("www-authenticate") ?? "";
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  step("S1 401 + WWW-Authenticate resource_metadata", r401.status === 401 && !!prmUrl, `status=${r401.status} header=${www}`);
  const prmRes = prmUrl ? await fetch(prmUrl) : null;
  const prm = prmRes?.ok ? await prmRes.json() : null;
  step("S2a RFC 9728 metadata at the advertised URL", prm?.resource === mcpUrl, `GET ${prmUrl} -> ${prmRes?.status} resource=${prm?.resource}`);
  const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const as = asRes.ok ? await asRes.json() : {};
  step("S2b RFC 8414 metadata", !!as.registration_endpoint && as.code_challenge_methods_supported?.includes("S256"),
    `auth_methods=${JSON.stringify(as.token_endpoint_auth_methods_supported)} revocation=${!!as.revocation_endpoint}`);

  // S3-S7 the SDK client (what Claude Code and other SDK-based CLIs run): 401 -> discover -> DCR -> PKCE -> code -> tools/call
  const cb = "http://127.0.0.1:53682/callback", store = {};
  const authProvider = {
    get redirectUrl() { return cb; },
    get clientMetadata() { return { client_name: "flow-sdk-client", redirect_uris: [cb], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
    clientInformation: () => store.client, saveClientInformation: (c) => { store.client = c; },
    tokens: () => store.tokens, saveTokens: (t) => { store.tokens = t; },
    redirectToAuthorization: (u) => { store.authUrl = u; },
    saveCodeVerifier: (v) => { store.verifier = v; }, codeVerifier: () => store.verifier,
  };
  let t1 = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider });
  let client = new Client({ name: "flow", version: "0.0.0" });
  let first = "";
  try { await client.connect(t1); first = "connected without auth?"; } catch (e) { first = e.constructor.name; }
  step("S3 SDK client discovery + DCR", !!store.client?.client_id && !!store.authUrl, `connect -> ${first}; authorize has resource=${store.authUrl?.searchParams.get("resource")}`);
  const bad = await login(store.authUrl.href, "wrong-passphrase");
  step("S4a wrong owner passphrase refused", bad.status >= 400 && !bad.location, `status=${bad.status}`);
  const good = await login(store.authUrl.href);
  const code = codeFrom(good.location);
  step("S4b owner login returns code to redirect_uri", !!code && good.location.startsWith(cb), `status=${good.status}`);
  await t1.finishAuth(code);
  step("S5a code exchange", !!store.tokens?.access_token && !!store.tokens?.refresh_token, `expires_in=${store.tokens?.expires_in}`);
  const reuse = await token({ grant_type: "authorization_code", code, code_verifier: store.verifier, redirect_uri: cb }, store.client, "none");
  step("S5b code reuse rejected", reuse.status === 400, `status=${reuse.status} ${reuse.body?.error}`);
  client = new Client({ name: "flow", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider }));
  const r = await client.callTool({ name: "ping", arguments: {} });
  step("S6 tools/call ping over Streamable HTTP", r.content?.[0]?.text === "pong", JSON.stringify(r.content));
  const tc = performance.now();
  let okCalls = 0;
  for (let i = 0; i < 100; i++) if ((await client.callTool({ name: "ping", arguments: {} })).content?.[0]?.text === "pong") okCalls++;
  const callsMs = Math.round(performance.now() - tc);
  await new Promise((res) => setTimeout(res, 200));
  const rssAfterKb = rss(child.pid);
  step("S7 100 tool calls", okCalls === 100, `${okCalls}/100 in ${callsMs} ms; server RSS ${rssIdleKb} KB idle -> ${rssAfterKb} KB`);
  await client.close();

  // S8 refresh with rotation and reuse detection
  const rf = await token({ grant_type: "refresh_token", refresh_token: store.tokens.refresh_token }, store.client, "none");
  step("S8a refresh", rf.status === 200 && !!rf.body?.access_token, `status=${rf.status} ${rf.body?.error ?? ""}`);
  const at2 = rf.body?.access_token;
  step("S8b refreshed token works", (await mcpCall(at2)).pong);
  const rf2 = await token({ grant_type: "refresh_token", refresh_token: store.tokens.refresh_token }, store.client, "none");
  step("S8c old refresh token rejected (rotation)", rf2.status === 400, `status=${rf2.status} ${rf2.body?.error}`);
  step("S8d reuse revokes the family", (await mcpCall(at2)).status === 401);

  // Web-client style (claude.ai / ChatGPT): confidential client, https redirect, no resource (H1)
  const webCb = "https://claude.ai/api/mcp/auth_callback";
  for (const auth of ["post", "basic"]) {
    const reg = await register({ client_name: `web-${auth}`, redirect_uris: [webCb], token_endpoint_auth_method: auth === "post" ? "client_secret_post" : "client_secret_basic" });
    const wc = reg.body ?? {};
    step(`W1-${auth} DCR confidential client (client_secret_${auth})`, reg.status === 201 && !!wc.client_secret, `status=${reg.status} ${reg.body?.error ?? ""} ${reg.body?.error_description ?? ""}`);
    if (reg.status !== 201) continue;
    const p = pkce();
    const lg = await login(authUrl(wc, { redirectUri: webCb, challenge: p.challenge }));
    const wcode = codeFrom(lg.location);
    step(`W2-${auth} H1 authorize without resource`, !!wcode && lg.location.startsWith(webCb), `status=${lg.status} location=${(lg.location ?? lg.body ?? "").slice(0, 120)}`);
    if (!wcode) continue;
    const tk = await token({ grant_type: "authorization_code", code: wcode, code_verifier: p.verifier, redirect_uri: webCb }, wc, auth);
    step(`W3-${auth} H1 token without resource`, tk.status === 200, `status=${tk.status} ${tk.body?.error ?? ""} ${tk.body?.error_description ?? ""}`);
    if (tk.status !== 200) continue;
    step(`W4-${auth} H1 token audience defaults to the MCP URL`, (await mcpCall(tk.body.access_token)).pong);
    if (auth === "post") {
      const rv = await form("/revoke", { token: tk.body.access_token, client_id: wc.client_id, client_secret: wc.client_secret });
      const after = await mcpCall(tk.body.access_token);
      step("S9a RFC 7009 revoke (form-encoded)", rv.status === 200, `status=${rv.status} ${(await rv.text()).slice(0, 120)}`);
      step("S9b revoked token rejected", after.status === 401, `status=${after.status}`);
      const rfr = await token({ grant_type: "refresh_token", refresh_token: tk.body.refresh_token }, wc, auth);
      step("S9c refresh after revoke rejected", rfr.status === 400, `status=${rfr.status}`);
    }
  }

  // S10 token rejection
  const mint = async (o) => (await (await fetch(`${base}/__test/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) })).json()).token;
  const exp = await mcpCall(await mint({ expiresIn: -10 }));
  step("S10a expired token rejected", exp.status === 401, `status=${exp.status} ${exp.www ?? ""}`);
  const aud = await mcpCall(await mint({ expiresIn: 600, aud: "http://127.0.0.1:1/other" }));
  step("S10b wrong-audience token rejected", aud.status === 401, `status=${aud.status} ${aud.www ?? ""}`);
  const ok = await mcpCall(await mint({ expiresIn: 600 }));
  step("S10c control: valid minted token accepted", ok.pong, `status=${ok.status}`);
  step("S10d garbage token rejected", (await mcpCall("not-a-token")).status === 401);

  // Hard cases
  const evil = await register({ client_name: "evil", redirect_uris: ["https://evil.example.net/cb"], token_endpoint_auth_method: "none" });
  step("H2a DCR with redirect on a non-allowed host refused", evil.status === 400, `status=${evil.status} ${evil.body?.error ?? ""}`);
  const lb = (await register({ client_name: "cli", redirect_uris: ["http://127.0.0.1:40000/callback"], token_endpoint_auth_method: "none" })).body;
  const p2 = pkce();
  const ev = await fetch(authUrl(lb, { redirectUri: "https://evil.example.net/cb", challenge: p2.challenge }), { redirect: "manual" });
  step("H2b authorize with redirect_uri on another host refused (no redirect)", ev.status === 400 && !ev.headers.get("location"), `status=${ev.status} location=${ev.headers.get("location")}`);
  const port2 = await fetch(authUrl(lb, { redirectUri: "http://127.0.0.1:40001/callback", challenge: p2.challenge }), { redirect: "manual" });
  step("H2c loopback redirect on another port allowed (RFC 8252)", port2.status === 200, `status=${port2.status}`);
  const plain = await fetch(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback", challenge: p2.verifier, method: "plain" }), { redirect: "manual" });
  step("H3a PKCE plain refused", plain.status !== 200, `status=${plain.status} location=${(plain.headers.get("location") ?? "").slice(0, 100)}`);
  const nopkce = await fetch(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback" }).replace(/&code_challenge_method=S256/, ""), { redirect: "manual" });
  step("H3b missing code_challenge refused", nopkce.status !== 200, `status=${nopkce.status}`);
  const lg3 = await login(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback", challenge: p2.challenge }));
  const wrongV = await token({ grant_type: "authorization_code", code: codeFrom(lg3.location), code_verifier: pkce().verifier, redirect_uri: "http://127.0.0.1:40000/callback" }, lb, "none");
  step("H3c wrong code_verifier refused", wrongV.status === 400, `status=${wrongV.status} ${wrongV.body?.error}`);
  const other = await fetch(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback", challenge: p2.challenge, resource: "https://other.example.com/mcp" }), { redirect: "manual" });
  step("H1b authorize for another resource refused", other.status !== 200, `status=${other.status} location=${(other.headers.get("location") ?? "").slice(0, 100)}`);
  const sc = await fetch(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback", challenge: p2.challenge, scope: "mcp" }), { redirect: "manual" });
  step("H4 authorize with a scope the client did not register (informational)", sc.status === 200, `status=${sc.status} location=${(sc.headers.get("location") ?? "").slice(0, 120)}`);
  const lgBrute = await login(authUrl(lb, { redirectUri: "http://127.0.0.1:40000/callback", challenge: p2.challenge }), "x");
  let last;
  for (let i = 0; i < 5; i++) last = await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ rid: lgBrute.rid, passphrase: i === 4 ? passphrase : "x" }) });
  step("H5 sign-in locked after 5 wrong passphrases", !last.headers.get("location"), `6th attempt with the right passphrase -> ${last.status}`);
} catch (e) {
  step("CRASH", false, e?.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  child.kill();
}

const passed = results.filter((s) => s.ok).length;
const sorted = [...colds].sort((a, b) => a - b);
const out = { candidate: name, node: process.version, coldStartMs: { median: sorted[2], runs: colds }, rssIdleKb, passed, total: results.length, results };
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../results/${name}.json`, import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${name}: ${passed}/${results.length} passed; cold start median ${sorted[2]} ms`);
