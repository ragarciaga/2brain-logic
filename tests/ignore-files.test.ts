import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");
const lines = (name: string): string[] =>
  read(name)
    .split(/\r?\n/)
    .map((line) => line.trim());

async function exitCode(args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd: ROOT });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "number") throw error;
    return code;
  }
}

describe("secrets directory ignore rules", () => {
  it("lists secrets/ in .gitignore and .dockerignore", () => {
    expect(lines(".gitignore")).toContain("secrets/");
    expect(lines(".dockerignore")).toContain("secrets/");
  });

  it("makes git ignore secrets/deploy_key", async () => {
    expect(await exitCode(["check-ignore", "-q", "secrets/deploy_key"])).toBe(0);
  });
});

describe("Dockerfile", () => {
  it("installs openssh-client", () => {
    expect(read("Dockerfile")).toContain("openssh-client");
  });

  it("is unchanged against the index", async () => {
    expect(await exitCode(["diff", "--exit-code", "--", "Dockerfile"])).toBe(0);
  });
});

describe(".env.example", () => {
  it("keeps the base variables in order", () => {
    const active = lines(".env.example").filter((line) => line !== "" && !line.startsWith("#"));
    expect(active).toEqual([
      "VAULT_DIR=./vault",
      "VAULT_REMOTE=git@example.com:you/vault.git",
      "GIT_AUTHOR_NAME=2brain",
      "GIT_AUTHOR_EMAIL=2brain@example.com",
      "INGEST_TOKEN=",
      "PORT=3000",
      "HOST=127.0.0.1",
      "PUBLIC_BASE_URL=",
      "MCP_PORT=3001",
      "OWNER_PASSPHRASE_HASH=",
      "ALLOWED_REDIRECT_HOSTS=",
      "AUTH_STORE_DIR=/data/auth",
      "TRUST_PROXY_HOPS=0",
      "ANTHROPIC_API_KEY=",
      "N8N_NETWORK=n8n",
    ]);
  });

  it("documents the setup service and the TRUST_PROXY_HOPS default", () => {
    const comments = lines(".env.example").filter((line) => line.startsWith("#"));
    expect(comments.some((line) => line.includes("docker compose run --rm setup"))).toBe(true);
    expect(
      comments.some(
        (line) => line.includes("PUBLIC_BASE_URL") && /\b0\b/.test(line) && /\b1\b/.test(line),
      ),
    ).toBe(true);
  });
});

describe("no em dash", () => {
  it("is absent from compose.yaml, .env.example and both ignore files", () => {
    const dash = String.fromCodePoint(0x2014);
    for (const name of ["compose.yaml", ".env.example", ".gitignore", ".dockerignore"]) {
      expect(read(name)).not.toContain(dash);
    }
  });
});
