import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

      const body = JSON.stringify({ path: "Inbox/spawn.md", frontmatter: {}, body: "hi\n" });
      const headers = { "content-type": "application/json" };
      const denied = await fetch(`${url}/notes`, { method: "POST", body, headers });
      expect(denied.status).toBe(401);

      const created = await fetch(`${url}/notes`, {
        method: "POST",
        body,
        headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      });
      expect(created.status).toBe(201);
      expect(git(fixture.remote, ["show", "main:Inbox/spawn.md"])).toContain("hi");
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
});
