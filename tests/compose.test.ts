import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { posix, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { startServer } from "../src/server/start.js";
import { parseYamlConfig } from "../src/vault/frontmatter.js";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Healthcheck {
  test: unknown;
  interval: unknown;
  timeout: unknown;
  retries: unknown;
  start_period: unknown;
}

function brainHealthcheck(): Healthcheck {
  const compose = parseYamlConfig(read("compose.yaml"));
  const services = isRecord(compose) ? compose.services : undefined;
  const brain = isRecord(services) ? services.brain : undefined;
  const healthcheck = isRecord(brain) ? brain.healthcheck : undefined;
  if (!isRecord(healthcheck)) throw new Error("compose.yaml: services.brain.healthcheck missing");
  return healthcheck as unknown as Healthcheck;
}

function healthcheckScript(): string {
  const { test } = brainHealthcheck();
  if (!Array.isArray(test)) throw new Error("healthcheck.test is not an array");
  expect(test.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
  expect(test).toHaveLength(4);
  const script = test[3];
  if (typeof script !== "string") throw new Error("healthcheck script is not a string");
  return script;
}

interface CopyStep {
  from: string | undefined;
  source: string;
  destination: string;
  chmod: string | undefined;
}

/** COPY instructions of the last Dockerfile stage, destinations resolved against WORKDIR. */
function lastStageCopies(): CopyStep[] {
  const joined = read("Dockerfile").replace(/\\\r?\n/g, " ");
  const lines = joined.split(/\r?\n/).map((line) => line.trim());
  const stages: string[][] = [];
  for (const line of lines) {
    if (/^FROM\s/i.test(line)) stages.push([]);
    stages.at(-1)?.push(line);
  }
  const last = stages.at(-1);
  if (!last) throw new Error("Dockerfile has no FROM");
  let workdir = "/";
  const copies: CopyStep[] = [];
  for (const line of last) {
    const workdirMatch = /^WORKDIR\s+(\S+)/i.exec(line);
    if (workdirMatch?.[1]) workdir = posix.resolve(workdir, workdirMatch[1]);
    if (!/^COPY\s/i.test(line)) continue;
    const parts = line.split(/\s+/).slice(1);
    let from: string | undefined;
    let chmod: string | undefined;
    const args: string[] = [];
    for (const part of parts) {
      if (part.startsWith("--from=")) from = part.slice("--from=".length);
      else if (part.startsWith("--chmod=")) chmod = part.slice("--chmod=".length);
      else if (!part.startsWith("--")) args.push(part);
    }
    const destination = args.at(-1);
    if (destination === undefined) continue;
    for (const source of args.slice(0, -1)) {
      copies.push({ from, source, destination: posix.resolve(workdir, destination), chmod });
    }
  }
  return copies;
}

/** Instruction lines per Dockerfile stage, continuation lines joined, in order. */
function dockerStages(): string[][] {
  const joined = read("Dockerfile").replace(/\\\r?\n/g, " ");
  const stages: string[][] = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) stages.push([]);
    if (line !== "") stages.at(-1)?.push(line);
  }
  return stages;
}

function lastStageInstructions(): string[] {
  const last = dockerStages().at(-1);
  if (!last) throw new Error("Dockerfile has no FROM");
  return last;
}

function brainService(): Record<string, unknown> {
  const compose = parseYamlConfig(read("compose.yaml"));
  const services = isRecord(compose) ? compose.services : undefined;
  const brain = isRecord(services) ? services.brain : undefined;
  if (!isRecord(brain)) throw new Error("compose.yaml: services.brain missing");
  return brain;
}

function brainMounts(): { source: string; target: string }[] {
  const volumes = brainService().volumes;
  if (!Array.isArray(volumes)) throw new Error("brain.volumes is not a list");
  return volumes.map((entry) => {
    const [source = "", target = ""] = String(entry).split(":");
    return { source, target };
  });
}

function lineIndex(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

async function runHealthcheck(
  port: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", healthcheckScript()], {
      env: { ...process.env, PORT: String(port) },
      timeout: 10000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((done) => current.close(() => done()));
});

describe("compose healthcheck definition", () => {
  it("is an exec form node -e fetch of /health on 127.0.0.1 with PORT defaulting to 3000", () => {
    const script = healthcheckScript();
    expect(script).toContain("fetch(");
    expect(script).toContain("127.0.0.1");
    expect(script).toContain("/health");
    expect(script).toMatch(/process\.env\.PORT \|\| 3000/);
    expect(script).not.toContain("??");
    expect(script).not.toContain("localhost");
  });

  it("sets interval, timeout, retries and start_period", () => {
    const healthcheck = brainHealthcheck();
    expect(healthcheck.interval).toBe("30s");
    expect(healthcheck.timeout).toBe("5s");
    expect(healthcheck.retries).toBe(3);
    expect(healthcheck.start_period).toBe("15s");
  });

  it("has no interpolation, token or authorization in the script", () => {
    const script = healthcheckScript();
    expect(script).not.toContain("$");
    expect(script).not.toContain("INGEST_TOKEN");
    expect(script.toLowerCase()).not.toContain("authorization");
  });
});

describe("healthcheck script behavior", () => {
  it("exits 0 against the real app listening on 0.0.0.0", async () => {
    const app = createApp({
      writer: {
        write: async () => ({ path: "x.md", commit: "abc" }),
        patch: async () => ({ path: "x.md", commit: "abc" }),
        archive: async () => ({ path: "archive/x.md", commit: "abc" }),
      },
      ingestToken: "fictional-compose-token-0123456789-abcdefghij",
    });
    server = await startServer(app, { host: "0.0.0.0", port: 0 });
    const { port } = server.address() as AddressInfo;
    const result = await runHealthcheck(port);
    expect(result.code).toBe(0);
  });

  it("sends GET /health without an authorization header", async () => {
    const seen: { method?: string; url?: string; authorization?: string | undefined }[] = [];
    server = createHttpServer((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      res.statusCode = 200;
      res.end("{}");
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const result = await runHealthcheck(port);
    expect(result.code).toBe(0);
    expect(seen).toEqual([{ method: "GET", url: "/health", authorization: undefined }]);
  });

  it("exits exactly 1 when /health answers non-2xx", async () => {
    server = createHttpServer((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const result = await runHealthcheck(port);
    expect(result.code).toBe(1);
  });

  it("exits exactly 1 when nothing listens", async () => {
    const result = await runHealthcheck(await freePort());
    expect(result.code).toBe(1);
  });
});

describe("image heap cap", () => {
  it("sets NODE_OPTIONS to exactly --max-old-space-size=192 in the last stage", () => {
    const values = lastStageInstructions()
      .map((line) => /^ENV\s+NODE_OPTIONS(?:=|\s+)(.*)$/i.exec(line)?.[1])
      .filter((value) => value !== undefined);
    expect(values).toEqual(["--max-old-space-size=192"]);
  });

  it("leaves the build stage without NODE_OPTIONS", () => {
    const first = dockerStages()[0] ?? [];
    expect(first.length).toBeGreaterThan(0);
    expect(first.join("\n")).not.toContain("NODE_OPTIONS");
  });
});

describe("image auth directory", () => {
  const runs = (): string[] => lastStageInstructions().filter((line) => /^RUN\s/i.test(line));
  const userIndex = (): number => lineIndex(lastStageInstructions(), /^USER\s+node\s*$/i);

  it("switches to the node user", () => {
    expect(userIndex()).toBeGreaterThan(-1);
  });

  it("creates /data/auth with mkdir before USER node", () => {
    const index = lineIndex(lastStageInstructions(), /^RUN\s.*mkdir\s.*\/data\/auth/i);
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(userIndex());
  });

  it("chowns /data/auth to node:node before USER node", () => {
    const index = lineIndex(
      lastStageInstructions(),
      /^RUN\s.*chown\s+node:node\s[^&]*\/data\/auth/i,
    );
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(userIndex());
  });

  it("sets /data/auth to mode 700 before USER node", () => {
    const index = lineIndex(lastStageInstructions(), /^RUN\s.*chmod\s+0?700\s+\/data\/auth/i);
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(userIndex());
  });

  it("never makes /data/auth group or others writable", () => {
    for (const run of runs()) {
      for (const part of run.split("&&")) {
        if (!part.includes("/data/auth") || !/chmod/.test(part)) continue;
        expect(part).not.toMatch(
          /chmod\s+(-\S+\s+)*(\d*[2367][0-7]|\d*[0-7][2367]|[a-z]*[go]\+\w*w)\b/i,
        );
      }
    }
  });
});

describe("compose auth store volume", () => {
  it("mounts the named volume auth at /data/auth", () => {
    expect(brainService().volumes).toContain("auth:/data/auth");
  });

  it("declares auth as a top-level volume", () => {
    const compose = parseYamlConfig(read("compose.yaml"));
    const volumes = isRecord(compose) ? compose.volumes : undefined;
    expect(isRecord(volumes) && Object.hasOwn(volumes, "auth")).toBe(true);
  });

  it("sets AUTH_STORE_DIR to the auth mount target", () => {
    const environment = brainService().environment;
    expect(isRecord(environment) ? environment.AUTH_STORE_DIR : undefined).toBe("/data/auth");
    const mount = brainMounts().find((entry) => entry.source === "auth");
    expect(mount?.target).toBe("/data/auth");
  });

  it("keeps the auth volume apart from the vault volume and path", () => {
    const mounts = brainMounts();
    const auth = mounts.find((entry) => entry.target === "/data/auth");
    const vault = mounts.find((entry) => entry.target === "/data/vault");
    expect(auth).toBeDefined();
    expect(vault).toBeDefined();
    expect(auth?.source).not.toBe(vault?.source);
    expect(posix.relative("/data/vault", "/data/auth").startsWith("..")).toBe(true);
  });
});

describe("compose isolation and memory", () => {
  it("limits memory to 512m", () => {
    expect(brainService().mem_limit).toBe("512m");
  });

  it("publishes no ports", () => {
    expect(Object.hasOwn(brainService(), "ports")).toBe(false);
  });

  it("joins only the n8n network", () => {
    expect(brainService().networks).toEqual(["n8n"]);
  });
});

describe("image carries the vault template", () => {
  it("copies vault-template from the build context to /app/vault-template in the last stage", () => {
    const copy = lastStageCopies().find((step) => step.source === "vault-template");
    expect(copy).toBeDefined();
    expect(copy?.from).toBeUndefined();
    expect(copy?.destination).toBe("/app/vault-template");
  });

  it("lets the node user read the copied template", () => {
    const copy = lastStageCopies().find((step) => step.source === "vault-template");
    expect(copy?.chmod).toMatch(/^a\+rX$/);
  });

  it("puts dist where ../vault-template from dist/cli.js lands on the template", () => {
    const dist = lastStageCopies().find(
      (step) => step.from === "build" && step.source === "/app/dist",
    );
    const template = lastStageCopies().find((step) => step.source === "vault-template");
    expect(dist?.destination).toBe("/app/dist");
    expect(posix.resolve(dist?.destination ?? "", "../vault-template")).toBe(template?.destination);
  });

  it("does not exclude vault-template from the build context", () => {
    const patterns = read(".dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    for (const pattern of patterns) {
      expect(pattern.replace(/^\/|\/$/g, "")).not.toMatch(/^vault-template(\/.*)?$/);
      expect(pattern).not.toBe("*");
    }
  });
});
