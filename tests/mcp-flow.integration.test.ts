import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, OAuthClientInformationFull } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassphrase } from "../src/auth/owner.js";
import { TEMPLATE_DIR } from "../src/cli.js";
import { stringifyNote } from "../src/vault/frontmatter.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";
import {
  authorizePage,
  authorizeUrl,
  connectMcp,
  type Discovered,
  discover,
  exchange,
  flowFetch,
  rawMcp,
  refresh,
  register,
  revoke,
  signIn,
} from "./helpers/oauth-client.js";

// The whole connector journey against the compiled entry point, as a real process over loopback.
// A private build, so no other test sees a half-written dist and CI can run tests before the build.
const repoRoot = join(import.meta.dirname, "..");
const cacheRoot = join(repoRoot, "node_modules", ".cache");
const SEEDED_WORD = "zebrafigure";
const SEEDED_PATH = "personal/resources/flow-seeded.md";
const SAVED_PATH = "inbox/flow-saved.md";
const SAVED_BODY = "Saved through the connector flow.\n";
const CLIENT_NAME = "Flow Test Client";
const EXPECTED_TOOLS = ["search", "read", "recent", "save_note", "save_recipe"];

// Independent of src: a change to how the store hashes must fail the test, not follow it.
const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");
// Built from parts so no source line holds a token-shaped literal.
const INGEST_TOKEN = ["ingest", randomHex(16), "flow"].join("-");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

let build: string;
let script: string;

beforeAll(() => {
  mkdirSync(cacheRoot, { recursive: true });
  build = mkdtempSync(join(cacheRoot, "flow-entry-"));
  writeFileSync(join(build, "package.json"), '{"type":"module"}\n');
  const tsc = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      join(build, "dist"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(tsc.stdout + tsc.stderr).toBe("");
  expect(tsc.status).toBe(0);
  script = join(build, "dist", "index.js");
  expect(existsSync(script)).toBe(true);
}, 120000);

afterAll(() => {
  if (build !== undefined) rmSync(build, { recursive: true, force: true });
});

interface Running {
  child: ChildProcess;
  out: () => string;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

const children: ChildProcess[] = [];
/** Everything every spawned service printed, both streams, in order. */
const allOutput: string[] = [];

function launch(script: string, cwd: string, env: Record<string, string>): Running {
  const child = spawn(process.execPath, [script], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let text = "";
  let outText = "";
  let errText = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    outText += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    errText += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    // "close", not "exit": the streams may still deliver chunks after the process has exited.
    child.once("close", (code) => {
      allOutput.push(text);
      resolve(code);
    });
  });
  return { child, out: () => text, stdout: () => outText, stderr: () => errText, exited };
}

async function stopService(running: Running): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill("SIGTERM");
  const timer = setTimeout(() => running.child.kill("SIGKILL"), 5000);
  await running.exited;
  clearTimeout(timer);
}

describe("OAuth connector flow from the built entry point", () => {
  let fixture: GitFixture;
  let authDir: string;
  let scratch: string;
  let env: Record<string, string>;
  let base: string;
  let passphrase: string;
  let service: Running;
  const issued: string[] = [];
  const clients: Client[] = [];

  let discovered: Discovered;
  let client: OAuthClientInformationFull;
  let clientSecret: string;

  const baseEnv = (
    vaultDir: string,
    storeDir: string,
    ports: { port: number; mcpPort: number },
  ): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? scratch,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    VAULT_DIR: vaultDir,
    VAULT_REMOTE: fixture.remote,
    GIT_AUTHOR_NAME: "Flow Test",
    GIT_AUTHOR_EMAIL: "flow@example.com",
    INGEST_TOKEN,
    PORT: String(ports.port),
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: `http://127.0.0.1:${ports.mcpPort}`,
    MCP_PORT: String(ports.mcpPort),
    OWNER_PASSPHRASE_HASH: ownerHash,
    AUTH_STORE_DIR: storeDir,
    TRUST_PROXY_HOPS: "0",
    SPIKE_TEST: "1",
  });
  let ownerHash: string;

  async function startService(environment: Record<string, string>): Promise<Running> {
    const running = launch(script, fixture.root, environment);
    const ready = `2brain mcp listening on 127.0.0.1:${environment.MCP_PORT}`;
    const deadline = Date.now() + 30000;
    while (!running.out().includes(ready)) {
      if (running.child.exitCode !== null || running.child.signalCode !== null) {
        throw new Error(`service exited early:\n${running.out()}`);
      }
      if (Date.now() > deadline) {
        await stopService(running);
        throw new Error(`service did not start:\n${running.out()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return running;
  }

  /** Sign in with the right passphrase, exchange the code, and return what was issued. */
  async function grant(): Promise<{
    code: string;
    verifier: string;
    access: string;
    refresh: string;
  }> {
    const pkce = await authorizeUrl(base, discovered.metadata, client);
    const signed = await signIn(base, pkce.url, passphrase);
    expect(signed.status).toBe(302);
    const location = new URL(signed.headers.get("location") ?? "");
    const code = location.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    expect(location.searchParams.get("state")).toBe(pkce.state);
    issued.push(code);
    const res = await exchange(base, client, code, pkce.verifier);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    issued.push(body.access_token, body.refresh_token);
    return {
      code,
      verifier: pkce.verifier,
      access: body.access_token,
      refresh: body.refresh_token,
    };
  }

  let grantA: Awaited<ReturnType<typeof grant>>;
  let grantB: Awaited<ReturnType<typeof grant>>;
  let refreshedB: { access: string; refresh: string };

  beforeAll(async () => {
    fixture = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "flow-scratch-"));
    authDir = join(scratch, "auth");

    // Seed the remote with the default vault plus one note the search must find.
    const seed = fixture.cloneElsewhere("seeder");
    cpSync(TEMPLATE_DIR, seed, { recursive: true });
    mkdirSync(join(seed, "personal", "resources"), { recursive: true });
    writeFileSync(
      join(seed, SEEDED_PATH),
      stringifyNote(
        {
          type: "resource",
          area: "personal",
          date: "2026-10-31",
          source: "manual",
          title: "Flow seeded",
        },
        `The ${SEEDED_WORD} is a fictional animal.\n`,
      ),
    );
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "seed the flow vault"]);
    git(seed, ["push", "origin", "main"]);

    passphrase = `pp-${randomHex(9)}`;
    ownerHash = await hashPassphrase(passphrase);
    issued.push(passphrase);

    const ports = { port: await freePort(), mcpPort: await freePort() };
    env = baseEnv(fixture.vaultDir, authDir, ports);
    base = env.PUBLIC_BASE_URL ?? "";
    service = await startService(env);
  }, 120000);

  afterAll(async () => {
    for (const open of clients) await open.close().catch(() => undefined);
    await stopService(service).catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    fixture?.cleanup();
  });

  it("D1: /mcp without a token is 401 with the exact challenge, and the metadata names the resource", async () => {
    // The later steps build on the discovery result, so it is stored before anything is asserted.
    discovered = await discover(base);
    const res = await rawMcp(base);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    const doc = (await (
      await flowFetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(`${base}/mcp`);
    expect(doc.authorization_servers).toEqual([base]);
    expect(discovered.resource).toBe(`${base}/mcp`);
    expect(discovered.authorizationServers).toEqual([base]);
  });

  it("D2: the SDK registers a client and the sign-in page shows its self-declared name", async () => {
    client = await register(base, discovered.metadata, CLIENT_NAME);
    clientSecret = client.client_secret ?? "";
    expect(clientSecret).not.toBe("");
    issued.push(clientSecret);
    const pkce = await authorizeUrl(base, discovered.metadata, client);
    const page = await authorizePage(pkce.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`The client calls itself "${CLIENT_NAME}"`);
  });

  it("R4.4: a wrong passphrase answers 200 with the sign-in error and no redirect", async () => {
    const pkce = await authorizeUrl(base, discovered.metadata, client);
    const res = await signIn(base, pkce.url, `${passphrase}-wrong`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("Sign-in failed. Check the passphrase and try again.");
  });

  it("R4.4: a right passphrase redirects with a code and the same state; a second exchange is invalid_grant and revokes the grant", async () => {
    grantA = await grant();
    const replay = await exchange(base, client, grantA.code, grantA.verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    // The replay revoked the grant the code produced.
    expect((await rawMcp(base, grantA.access)).status).toBe(401);
  });

  it("R6.1: a live token lists the tools, search finds the seeded note and save_note reaches the remote", async () => {
    grantB = await grant();
    const mcp = await connectMcp(base, grantB.access);
    clients.push(mcp);
    const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(EXPECTED_TOOLS));

    const found = (await mcp.callTool({ name: "search", arguments: { query: SEEDED_WORD } })) as {
      isError?: boolean;
      structuredContent?: { results?: Array<{ path: string }> };
    };
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent?.results?.map((r) => r.path)).toContain(SEEDED_PATH);

    const saved = (await mcp.callTool({
      name: "save_note",
      arguments: {
        path: SAVED_PATH,
        frontmatter: {
          type: "idea",
          area: "personal",
          date: "2026-10-31",
          source: "flow-test",
          title: "Flow saved",
        },
        body: SAVED_BODY,
      },
    })) as { isError?: boolean; structuredContent?: { ok?: boolean; commit?: string } };
    expect(saved.isError).not.toBe(true);
    const commit = saved.structuredContent?.commit ?? "";
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(commit);
    expect(git(fixture.remote, ["show", `main:${SAVED_PATH}`])).toContain(SAVED_BODY.trim());
  });

  it("D3: refresh rotates both tokens, and a rotated-out refresh token is invalid_grant", async () => {
    const res = await refresh(base, client, grantB.refresh);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    issued.push(body.access_token, body.refresh_token);
    expect(body.access_token).not.toBe(grantB.access);
    expect(body.refresh_token).not.toBe(grantB.refresh);
    refreshedB = { access: body.access_token, refresh: body.refresh_token };

    // A separate grant, so B's rotated tokens stay alive for the restart below.
    const grantC = await grant();
    const rotated = await refresh(base, client, grantC.refresh);
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { access_token: string; refresh_token: string };
    issued.push(rotatedBody.access_token, rotatedBody.refresh_token);
    const reuse = await refresh(base, client, grantC.refresh);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
    // Reuse revokes the whole grant: the tokens issued by the rotation are dead too.
    expect((await rawMcp(base, rotatedBody.access_token)).status).toBe(401);
    const afterReuse = await refresh(base, client, rotatedBody.refresh_token);
    expect(afterReuse.status).toBe(400);
  });

  it("R5.5: after a restart on the same store the refreshed token still lists tools", async () => {
    for (const open of clients.splice(0)) await open.close().catch(() => undefined);
    await stopService(service);
    service = await startService(env);
    expect(service.out()).toContain("auth store open: 1 clients");
    const mcp = await connectMcp(base, refreshedB.access);
    clients.push(mcp);
    const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
  }, 60000);

  it("R5.5: auth.json holds hashes only", () => {
    const text = readFileSync(join(authDir, "auth.json"), "utf8");
    for (const secret of issued) expect(text).not.toContain(secret);
    expect(text).toContain(sha256Hex(clientSecret));
    expect(text).toContain(sha256Hex(refreshedB.access));
  });

  it("D4: revoke answers 200 and the token is then 401 invalid_token", async () => {
    const res = await revoke(base, client, refreshedB.access);
    expect(res.status).toBe(200);
    const after = await rawMcp(base, refreshedB.access);
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("D5: the test mint route does not exist, in the build or in the source", async () => {
    const res = await flowFetch(`${base}/__test/mint`, { method: "POST" });
    expect(res.status).toBe(404);
    const sources = readdirSync(join(repoRoot, "src"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => [name, readFileSync(join(repoRoot, "src", name), "utf8")] as const);
    expect(sources.length).toBeGreaterThan(10);
    for (const [name, text] of sources) {
      expect(text.includes("__test/mint"), name).toBe(false);
      expect(text.includes("SPIKE_TEST"), name).toBe(false);
    }
  });

  it("D6: the server output holds no passphrase, client secret, code or token", async () => {
    await stopService(service);
    const output = allOutput.join("\n");
    expect(output).toContain("auth store open: 1 clients");
    expect(issued.length).toBeGreaterThan(8);
    for (const secret of issued) expect(output).not.toContain(secret);
    expect(output).not.toContain(ownerHash);
    expect(output).not.toContain(INGEST_TOKEN);
  });
});

describe("an unusable auth store stops startup (R5.6)", () => {
  const SENTINEL = ["sentinel", randomHex(8)].join("-");
  let fixture: GitFixture;
  let scratch: string;
  let ownerHash: string;

  beforeAll(async () => {
    fixture = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "flow-bad-"));
    ownerHash = await hashPassphrase(`pp-${randomHex(9)}`);
  }, 120000);

  afterAll(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    fixture?.cleanup();
  });

  async function runBad(prepare: (authDir: string) => void) {
    const authDir = mkdtempSync(join(scratch, "auth-"));
    prepare(authDir);
    const mcpPort = await freePort();
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? scratch,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      VAULT_DIR: join(scratch, `vault-${randomHex(4)}`),
      VAULT_REMOTE: fixture.remote,
      GIT_AUTHOR_NAME: "Flow Test",
      GIT_AUTHOR_EMAIL: "flow@example.com",
      INGEST_TOKEN,
      PORT: String(await freePort()),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${mcpPort}`,
      MCP_PORT: String(mcpPort),
      OWNER_PASSPHRASE_HASH: ownerHash,
      AUTH_STORE_DIR: authDir,
      TRUST_PROXY_HOPS: "0",
    };
    const running = launch(script, fixture.root, environment);
    const timer = setTimeout(() => running.child.kill("SIGKILL"), 30000);
    const code = await running.exited;
    clearTimeout(timer);
    return { code, stdout: running.stdout(), stderr: running.stderr() };
  }

  const cases: Array<[string, (authDir: string) => void]> = [
    ["not JSON", (dir) => writeFileSync(join(dir, "auth.json"), `not json ${SENTINEL}`)],
    [
      "the wrong format",
      (dir) =>
        writeFileSync(
          join(dir, "auth.json"),
          JSON.stringify({ version: 1, clients: {}, grants: {}, [SENTINEL]: SENTINEL }),
        ),
    ],
    ["a directory", (dir) => mkdirSync(join(dir, "auth.json"))],
  ];

  for (const [label, prepare] of cases) {
    it(`exits 1 naming auth.json when auth.json is ${label}, without echoing its content`, async () => {
      const { code, stdout, stderr } = await runBad(prepare);
      expect(code).toBe(1);
      expect(stderr).toContain("auth.json");
      expect(stdout + stderr).not.toContain(SENTINEL);
      expect(stdout).not.toContain("mcp listening");
    });
  }
});
