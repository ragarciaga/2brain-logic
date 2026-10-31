import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId, openAuthStore } from "../src/auth/oauth/store.js";
import { createApp } from "../src/server/app.js";
import { startServer } from "../src/server/start.js";
import { createGitFixture, git } from "./helpers/git-fixture.js";

const execFileAsync = promisify(execFile);

const TOKEN = "fictional-start-token-0123456789-abcdefghij";

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

const app = createApp({
  writer: { write: async () => ({ path: "x.md", commit: "abc" }) },
  ingestToken: TOKEN,
});

describe("startServer", () => {
  it("binds to 127.0.0.1 when no host is given", async () => {
    server = await startServer(app, { port: 0 });
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("honors the given HOST", async () => {
    server = await startServer(app, { host: "0.0.0.0", port: 0 });
    expect((server.address() as AddressInfo).address).toBe("0.0.0.0");
  });

  it("serves /health over the socket", async () => {
    server = await startServer(app, { host: "127.0.0.1", port: 0 });
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("checks the token over the socket", async () => {
    server = await startServer(app, { host: "127.0.0.1", port: 0 });
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ path: "a.md", frontmatter: {}, body: "x\n" });
    const url = `http://127.0.0.1:${port}/notes`;
    const headers = { "content-type": "application/json" };
    expect((await fetch(url, { method: "POST", body, headers })).status).toBe(401);
    const authorized = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(201);
  });
});

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "dist", "index.js");

/** Reserve a free port: bind port 0, read the number, release it. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the built entry point until it exits (it must exit on its own). */
function runToExit(env: Record<string, string>): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("the service exited before it listened");
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the service did not answer /health in time");
}

/** Two distinct free ports at once, so neither can be handed out twice. */
async function twoFreePorts(): Promise<[number, number]> {
  const probes = [createServer(), createServer()];
  const ports = await Promise.all(
    probes.map(
      (probe) =>
        new Promise<number>((resolvePort, reject) => {
          probe.once("error", reject);
          probe.listen(0, "127.0.0.1", () => resolvePort((probe.address() as AddressInfo).port));
        }),
    ),
  );
  await Promise.all(probes.map((probe) => new Promise<void>((done) => probe.close(() => done()))));
  return [ports[0] as number, ports[1] as number];
}

/** Resolve on any HTTP response, whatever its status. */
async function waitForAnyResponse(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("the service exited before it listened");
    try {
      await fetch(url);
      return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the service did not answer in time");
}

/** Wait until the collected output contains the text. */
async function waitForOutput(read: () => string, text: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (read().includes(text)) return;
    if (child.exitCode !== null) throw new Error(`the service exited before printing ${text}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the output never contained ${text}`);
}

/** A well-formed OWNER_PASSPHRASE_HASH (16 byte salt, 32 byte key), different on every call. */
function goodHash(): string {
  return `scrypt$32768$8$1$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;
}

function countLines(output: string, text: string): number {
  return output.split("\n").filter((line) => line.includes(text)).length;
}

async function stop(child: ChildProcess): Promise<void> {
  child.kill();
  await new Promise<void>((resolveClose) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveClose();
    else child.once("close", () => resolveClose());
  });
}

describe("built entry point", () => {
  beforeAll(async () => {
    await execFileAsync(
      process.execPath,
      [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
      { cwd: ROOT },
    );
    expect(existsSync(ENTRY)).toBe(true);
  }, 120000);

  /** Explicit child env: nothing from the test process leaks in by accident. */
  function childEnv(extra: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {
      HOST: "127.0.0.1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
    };
    for (const key of ["PATH", "SYSTEMROOT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
      const value = process.env[key];
      if (value !== undefined) base[key] = value;
    }
    return { ...base, ...extra };
  }

  it("exits 1 naming INGEST_TOKEN when the token is missing", async () => {
    const fixture = createGitFixture();
    try {
      const run = await runToExit(
        childEnv({ VAULT_DIR: fixture.vaultDir, VAULT_REMOTE: fixture.remote, PORT: "0" }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("INGEST_TOKEN");
    } finally {
      fixture.cleanup();
    }
  });

  it("exits 1 without echoing a 31-character token", async () => {
    const fixture = createGitFixture();
    try {
      const marker = "STARTMARKER".padEnd(31, "x");
      expect(marker).toHaveLength(31);
      const run = await runToExit(
        childEnv({
          VAULT_DIR: fixture.vaultDir,
          VAULT_REMOTE: fixture.remote,
          PORT: "0",
          INGEST_TOKEN: marker,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("INGEST_TOKEN");
      expect(run.stdout + run.stderr).not.toContain("STARTMARKER");
    } finally {
      fixture.cleanup();
    }
  });

  it("R2.3: keeps running with an invalid vault config, logs it and answers writes with 503", async () => {
    const fixture = createGitFixture();
    const seed = fixture.cloneElsewhere("seed-config");
    mkdirSync(join(seed, ".2brain"));
    writeFileSync(join(seed, ".2brain", "config.yaml"), "other: 1\n");
    git(seed, ["add", ".2brain/config.yaml"]);
    git(seed, ["commit", "-m", "bad config"]);
    git(seed, ["push", "origin", "main"]);

    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: childEnv({
        VAULT_DIR: fixture.vaultDir,
        VAULT_REMOTE: fixture.remote,
        PORT: String(port),
        INGEST_TOKEN: TOKEN,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    try {
      const url = `http://127.0.0.1:${port}`;
      await waitForHealth(url, child);
      expect(child.exitCode).toBeNull();

      const response = await fetch(`${url}/notes`, {
        method: "POST",
        body: JSON.stringify({ path: "Inbox/blocked.md", frontmatter: {}, body: "hi\n" }),
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "config_invalid",
        file: ".2brain/config.yaml",
        keyPath: "other",
      });
      expect(output).toContain("config_invalid: .2brain/config.yaml at other");
      expect(output).not.toContain(TOKEN);
    } finally {
      child.kill();
      await new Promise<void>((resolveClose) => {
        if (child.exitCode !== null) resolveClose();
        else child.once("close", () => resolveClose());
      });
      fixture.cleanup();
    }
  });

  it("serves /health, rejects POST /notes without the token and writes with it", async () => {
    const fixture = createGitFixture();
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: childEnv({
        VAULT_DIR: fixture.vaultDir,
        VAULT_REMOTE: fixture.remote,
        PORT: String(port),
        INGEST_TOKEN: TOKEN,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    try {
      const url = `http://127.0.0.1:${port}`;
      await waitForHealth(url, child);

      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const body = JSON.stringify({
        path: "inbox/spawn.md",
        frontmatter: { type: "idea", area: "personal", date: "2026-10-31", source: "manual" },
        body: "hi\n",
      });
      const headers = { "content-type": "application/json" };
      const denied = await fetch(`${url}/notes`, { method: "POST", body, headers });
      expect(denied.status).toBe(401);

      const created = await fetch(`${url}/notes`, {
        method: "POST",
        body,
        headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      });
      expect(created.status).toBe(201);
      expect(git(fixture.remote, ["show", "main:inbox/spawn.md"])).toContain("hi");

      const rejected = await fetch(`${url}/notes`, {
        method: "POST",
        body: JSON.stringify({ path: "inbox/bad.md", frontmatter: {}, body: "hi\n" }),
        headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        ok: false,
        error: "invalid_frontmatter",
        missing: ["type", "area", "date", "source"],
        invalid: [],
      });
      expect(output).not.toContain(TOKEN);
    } finally {
      child.kill();
      await new Promise<void>((resolveClose) => {
        if (child.exitCode !== null) resolveClose();
        else child.once("close", () => resolveClose());
      });
      fixture.cleanup();
    }
  });

  /** Spawn the entry point and collect its output. */
  function spawnService(env: Record<string, string>): { child: ChildProcess; read: () => string } {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    return { child, read: () => output };
  }

  const NOT_FOUND_PATHS: Array<[string, string]> = [
    ["POST", "/notes"],
    ["PATCH", "/notes"],
    ["POST", "/notes/archive"],
    ["GET", "/health"],
    ["GET", "/no-such-path"],
  ];

  it("R1.1, D1: the public port answers 404 for ingest paths, with or without the token, serves AS metadata, and never prints the token or the hash", async () => {
    const fixture = createGitFixture();
    const [port, mcpPort] = await twoFreePorts();
    const hash = goodHash();
    const { child, read } = spawnService(
      childEnv({
        VAULT_DIR: fixture.vaultDir,
        VAULT_REMOTE: fixture.remote,
        PORT: String(port),
        INGEST_TOKEN: TOKEN,
        PUBLIC_BASE_URL: "https://brain.example.com",
        OWNER_PASSPHRASE_HASH: hash,
        MCP_PORT: String(mcpPort),
        AUTH_STORE_DIR: join(fixture.root, "auth"),
      }),
    );
    try {
      const publicUrl = `http://127.0.0.1:${mcpPort}`;
      await waitForAnyResponse(`${publicUrl}/health`, child);
      await waitForOutput(read, "mcp listening", child);
      for (const [method, path] of NOT_FOUND_PATHS) {
        const bare = await fetch(`${publicUrl}${path}`, { method });
        expect(bare.status, `${method} ${path}`).toBe(404);
        const withToken = await fetch(`${publicUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(withToken.status, `${method} ${path} with token`).toBe(404);
      }

      const challenge =
        'Bearer resource_metadata="https://brain.example.com/.well-known/oauth-protected-resource/mcp"';
      const noToken = await fetch(`${publicUrl}/mcp`, { method: "POST", body: "{}" });
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get("www-authenticate")).toBe(challenge);
      const ingestAsBearer = await fetch(`${publicUrl}/mcp`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ingestAsBearer.status).toBe(401);
      expect(ingestAsBearer.headers.get("www-authenticate")).toBe(
        `${challenge}, error="invalid_token"`,
      );

      const ingest = await fetch(`http://127.0.0.1:${port}/health`);
      expect(ingest.status).toBe(200);

      const metadata = await fetch(`${publicUrl}/.well-known/oauth-authorization-server`);
      expect(metadata.status).toBe(200);
      expect(((await metadata.json()) as { issuer: string }).issuer).toBe(
        "https://brain.example.com",
      );

      // Read the output only after the child is gone, so every line it printed is collected.
      await stop(child);
      const output = read();
      expect(output).toContain("mcp listening");
      expect(countLines(output, "mcp disabled")).toBe(0);
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain(hash);
    } finally {
      await stop(child);
      fixture.cleanup();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "R1.1: the public listener binds to HOST, not to every address",
    async () => {
      const fixture = createGitFixture();
      const [port, mcpPort] = await twoFreePorts();
      const { child } = spawnService(
        childEnv({
          HOST: "127.0.0.2",
          VAULT_DIR: fixture.vaultDir,
          VAULT_REMOTE: fixture.remote,
          PORT: String(port),
          INGEST_TOKEN: TOKEN,
          PUBLIC_BASE_URL: "https://brain.example.com",
          OWNER_PASSPHRASE_HASH: goodHash(),
          MCP_PORT: String(mcpPort),
          AUTH_STORE_DIR: join(fixture.root, "auth"),
        }),
      );
      try {
        await waitForAnyResponse(`http://127.0.0.2:${mcpPort}/health`, child);
        expect((await fetch(`http://127.0.0.2:${mcpPort}/health`)).status).toBe(404);
        await expect(fetch(`http://127.0.0.1:${mcpPort}/health`)).rejects.toThrow();
      } finally {
        await stop(child);
        fixture.cleanup();
      }
    },
  );

  it("R1.2: without PUBLIC_BASE_URL no listener opens on the reserved port and one mcp disabled line is printed", async () => {
    const fixture = createGitFixture();
    const [port, mcpPort] = await twoFreePorts();
    const { child, read } = spawnService(
      childEnv({
        VAULT_DIR: fixture.vaultDir,
        VAULT_REMOTE: fixture.remote,
        PORT: String(port),
        INGEST_TOKEN: TOKEN,
        MCP_PORT: String(mcpPort),
      }),
    );
    try {
      await waitForHealth(`http://127.0.0.1:${port}`, child);
      await waitForOutput(read, "mcp disabled", child);
      expect(countLines(read(), "mcp disabled")).toBe(1);
      expect(read()).not.toContain("mcp listening");
      await expect(fetch(`http://127.0.0.1:${mcpPort}/health`)).rejects.toThrow();
    } finally {
      await stop(child);
      fixture.cleanup();
    }
  });

  describe("R5.5, R5.6: the auth store at startup", () => {
    const publicEnv = (
      fixture: { vaultDir: string; remote: string; root: string },
      authDir: string,
    ) =>
      childEnv({
        VAULT_DIR: fixture.vaultDir,
        VAULT_REMOTE: fixture.remote,
        PORT: "0",
        INGEST_TOKEN: TOKEN,
        PUBLIC_BASE_URL: "https://brain.example.com",
        OWNER_PASSPHRASE_HASH: goodHash(),
        MCP_PORT: "0",
        AUTH_STORE_DIR: authDir,
      });

    const BAD_FILES: Array<[string, string]> = [
      ["garbage", "STOREMARKER this is not json"],
      ["a wrong version", '{"version":2,"clients":{},"grants":{},"note":"STOREMARKER"}'],
      ["an unknown key", '{"version":1,"clients":{},"grants":{},"note":"STOREMARKER"}'],
    ];

    it.each(BAD_FILES)(
      "D9: %s in auth.json exits 1 naming auth.json, with no content, no path and nothing listening",
      async (_name, content) => {
        const fixture = createGitFixture();
        try {
          const authDir = join(fixture.root, "auth");
          mkdirSync(authDir, { mode: 0o700 });
          writeFileSync(join(authDir, "auth.json"), content);
          const run = await runToExit(publicEnv(fixture, authDir));
          expect(run.code).toBe(1);
          expect(run.stderr).toContain("auth.json");
          const output = run.stdout + run.stderr;
          expect(output).not.toContain("STOREMARKER");
          expect(output).not.toContain(fixture.root);
          expect(output).not.toContain("listening");
        } finally {
          fixture.cleanup();
        }
      },
    );

    it("D9: the store is opened before either port is bound (a taken PORT does not hide a bad auth.json)", async () => {
      const fixture = createGitFixture();
      const blocker = createServer();
      try {
        await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", () => done()));
        const taken = (blocker.address() as AddressInfo).port;
        const authDir = join(fixture.root, "auth");
        mkdirSync(authDir, { mode: 0o700 });
        writeFileSync(join(authDir, "auth.json"), "STOREMARKER this is not json");
        const run = await runToExit({ ...publicEnv(fixture, authDir), PORT: String(taken) });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("auth.json");
        expect(run.stderr).not.toContain("EADDRINUSE");
      } finally {
        await new Promise<void>((done) => blocker.close(() => done()));
        fixture.cleanup();
      }
    });

    it("keeps clients across a restart: a store written by the library is opened by the built entry", async () => {
      const fixture = createGitFixture();
      const authDir = join(fixture.root, "auth");
      const [port, mcpPort] = await twoFreePorts();
      const otherVault = join(fixture.root, "other-vault");
      mkdirSync(otherVault);
      const seed = await openAuthStore({ dir: authDir, vaultDir: otherVault });
      await seed.update((tx) =>
        tx.putClient(newId(), { authMethod: "none", redirectUris: ["https://claude.ai/cb"] }),
      );
      seed.close();
      const { child, read } = spawnService({
        ...publicEnv(fixture, authDir),
        PORT: String(port),
        MCP_PORT: String(mcpPort),
      });
      try {
        await waitForOutput(read, "mcp listening", child);
        expect(read()).toContain("auth store open: 1 clients");
      } finally {
        await stop(child);
        fixture.cleanup();
      }
    });

    it.skipIf(process.platform !== "linux")(
      "a store directory that is a symlink into the vault exits 1 naming AUTH_STORE_DIR and VAULT_DIR, before anything listens",
      async () => {
        const fixture = createGitFixture();
        try {
          const link = join(fixture.root, "link-to-vault");
          symlinkSync(fixture.vaultDir, link);
          const run = await runToExit(publicEnv(fixture, join(link, "auth")));
          expect(run.code).toBe(1);
          expect(run.stderr).toContain("AUTH_STORE_DIR");
          expect(run.stderr).toContain("VAULT_DIR");
          expect(run.stdout + run.stderr).not.toContain(fixture.root);
          expect(run.stdout).not.toContain("listening");
          expect(existsSync(join(fixture.vaultDir, "auth"))).toBe(false);
        } finally {
          fixture.cleanup();
        }
      },
    );

    it("a missing AUTH_STORE_DIR is created and the service starts", async () => {
      const fixture = createGitFixture();
      const [port, mcpPort] = await twoFreePorts();
      const authDir = join(fixture.root, "fresh", "auth");
      const { child, read } = spawnService({
        ...publicEnv(fixture, authDir),
        PORT: String(port),
        MCP_PORT: String(mcpPort),
      });
      try {
        await waitForOutput(read, "mcp listening", child);
        expect(read()).toContain("auth store open: 0 clients");
        expect(existsSync(authDir)).toBe(true);
      } finally {
        await stop(child);
        fixture.cleanup();
      }
    });
  });

  describe("R1.3: a bad public configuration exits 1 naming the variable, not its value", () => {
    async function runWith(
      extra: Record<string, string>,
    ): Promise<{ run: Run; cleanup: () => void }> {
      const fixture = createGitFixture();
      const run = await runToExit(
        childEnv({
          VAULT_DIR: fixture.vaultDir,
          VAULT_REMOTE: fixture.remote,
          PORT: "0",
          INGEST_TOKEN: TOKEN,
          AUTH_STORE_DIR: join(fixture.root, "auth"),
          ...extra,
        }),
      );
      return { run, cleanup: () => fixture.cleanup() };
    }

    it("rejects an http PUBLIC_BASE_URL that is not loopback", async () => {
      const { run, cleanup } = await runWith({
        PUBLIC_BASE_URL: "http://example.com",
        OWNER_PASSPHRASE_HASH: goodHash(),
      });
      try {
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("PUBLIC_BASE_URL");
        expect(run.stdout + run.stderr).not.toContain("example.com");
      } finally {
        cleanup();
      }
    });

    it("rejects a missing OWNER_PASSPHRASE_HASH", async () => {
      const { run, cleanup } = await runWith({ PUBLIC_BASE_URL: "https://brain.example.com" });
      try {
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("OWNER_PASSPHRASE_HASH");
      } finally {
        cleanup();
      }
    });

    it("rejects a malformed OWNER_PASSPHRASE_HASH without echoing it", async () => {
      const { run, cleanup } = await runWith({
        PUBLIC_BASE_URL: "https://brain.example.com",
        OWNER_PASSPHRASE_HASH: "HASHMARKER-not-a-hash",
      });
      try {
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("OWNER_PASSPHRASE_HASH");
        expect(run.stdout + run.stderr).not.toContain("HASHMARKER");
      } finally {
        cleanup();
      }
    });
  });
});
