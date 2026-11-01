import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalChecks, type LocalCheckDeps } from "../src/install/doctor.js";

const posix = process.platform !== "win32";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "doctor-local-"));
  mkdirSync(path.join(dir, "secrets"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, mode: number) {
  const p = path.join(dir, rel);
  writeFileSync(p, "x");
  chmodSync(p, mode);
}

// Built from parts so the secret scanners do not flag the source.
const TOKEN = ["tok", "A".repeat(20), "b".repeat(20)].join("");
const OK_ENV: NodeJS.ProcessEnv = {
  VAULT_DIR: "/vault",
  GIT_AUTHOR_NAME: "Ada Example",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  INGEST_TOKEN: TOKEN,
};

function checks(over: Partial<LocalCheckDeps> = {}) {
  const list = createLocalChecks({ env: OK_ENV, projectDir: dir, ...over });
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  return { list, run: (id: string) => byId[id]?.run() };
}

describe("createLocalChecks", () => {
  it("returns the four checks in order", () => {
    expect(checks().list.map((c) => c.id)).toEqual(["env", "env_file", "secrets", "network"]);
  });

  describe("env", () => {
    it("passes a valid environment", async () => {
      expect(await checks().run("env")).toEqual({ status: "pass" });
    });

    it("names each broken variable and no value", async () => {
      const bad = "http://x.example.com/p";
      const { INGEST_TOKEN: _drop, ...rest } = OK_ENV;
      const out = await checks({ env: { ...rest, PUBLIC_BASE_URL: bad } }).run("env");
      expect(out?.status).toBe("fail");
      const fix = (out as { fix: string }).fix;
      expect(fix).toContain("INGEST_TOKEN");
      expect(fix).toContain("PUBLIC_BASE_URL");
      expect(fix).not.toContain(bad);
      expect(fix).not.toContain("/p");
    });

    it("fails a blank PUBLIC_BASE_URL naming it", async () => {
      const out = await checks({ env: { ...OK_ENV, PUBLIC_BASE_URL: "   " } }).run("env");
      expect((out as { fix: string }).fix).toContain("PUBLIC_BASE_URL");
    });

    it("names a bad email without its value", async () => {
      const bad = "not-an-email-zzz";
      const out = await checks({ env: { ...OK_ENV, GIT_AUTHOR_EMAIL: bad } }).run("env");
      const fix = (out as { fix: string }).fix;
      expect(fix).toContain("GIT_AUTHOR_EMAIL");
      expect(fix).not.toContain(bad);
    });
  });

  describe("env_file", () => {
    it("fails when .env is missing", async () => {
      const out = await checks().run("env_file");
      expect(out).toEqual({
        status: "fail",
        fix: "no .env in the project directory: run docker compose run --rm setup",
      });
    });

    it("fails when .env is a directory", async () => {
      mkdirSync(path.join(dir, ".env"));
      expect(await checks().run("env_file")).toEqual({
        status: "fail",
        fix: "no .env in the project directory: run docker compose run --rm setup",
      });
    });

    it.skipIf(!posix).each([0o640, 0o604])("fails at mode %o", async (mode) => {
      put(".env", mode);
      expect(await checks().run("env_file")).toEqual({ status: "fail", fix: "chmod 600 .env" });
    });

    it.skipIf(!posix)("passes at 0600", async () => {
      put(".env", 0o600);
      expect(await checks().run("env_file")).toEqual({ status: "pass" });
    });

    it("skips the mode bits on win32", async () => {
      put(".env", 0o644);
      expect(await checks({ platform: "win32" }).run("env_file")).toEqual({ status: "pass" });
    });
  });

  describe("secrets", () => {
    const FIX = "chmod 600 secrets/deploy_key secrets/known_hosts";

    it.each(["deploy_key", "known_hosts"])("fails when %s is missing", async (name) => {
      const other = name === "deploy_key" ? "known_hosts" : "deploy_key";
      put(`secrets/${other}`, 0o600);
      expect(await checks().run("secrets")).toEqual({
        status: "fail",
        fix: `secrets/${name} is missing: re-run setup`,
      });
    });

    it.skipIf(!posix).each([
      ["deploy_key", 0o640],
      ["deploy_key", 0o604],
      ["known_hosts", 0o640],
      ["known_hosts", 0o604],
    ])("fails when %s is at mode %o", async (name, mode) => {
      put("secrets/deploy_key", 0o600);
      put("secrets/known_hosts", 0o600);
      put(`secrets/${name}`, mode);
      expect(await checks().run("secrets")).toEqual({ status: "fail", fix: FIX });
    });

    it.skipIf(!posix)("passes at 0600 and ignores deploy_key.pub", async () => {
      put("secrets/deploy_key", 0o600);
      put("secrets/known_hosts", 0o600);
      put("secrets/deploy_key.pub", 0o644);
      expect(await checks().run("secrets")).toEqual({ status: "pass" });
    });
  });

  describe("network", () => {
    const reject = async () => {
      throw new Error("ENOTFOUND");
    };

    it("fails with the configured network name", async () => {
      const out = await checks({
        env: { ...OK_ENV, N8N_NETWORK: "n8n-test" },
        lookup: reject,
      }).run("network");
      const fix = (out as { fix: string }).fix;
      expect(fix).toContain("docker network create n8n-test");
      expect(fix).toContain("docker compose up -d");
    });

    it("defaults to n8n", async () => {
      const out = await checks({ lookup: reject }).run("network");
      expect((out as { fix: string }).fix).toContain("docker network create n8n,");
    });

    it("falls back to n8n for a blank N8N_NETWORK", async () => {
      const out = await checks({ env: { ...OK_ENV, N8N_NETWORK: "  " }, lookup: reject }).run(
        "network",
      );
      expect((out as { fix: string }).fix).toContain("docker network create n8n,");
    });

    it("never echoes an invalid network name", async () => {
      const out = await checks({ env: { ...OK_ENV, N8N_NETWORK: "a b;rm" }, lookup: reject }).run(
        "network",
      );
      const fix = (out as { fix: string }).fix;
      expect(fix).toContain("docker network create <N8N_NETWORK>");
      expect(fix).not.toContain("rm");
    });

    it("passes when the lookup resolves, asking for brain", async () => {
      const hosts: string[] = [];
      const out = await checks({
        lookup: async (h) => {
          hosts.push(h);
          return { address: "10.0.0.2" };
        },
      }).run("network");
      expect(out).toEqual({ status: "pass" });
      expect(hosts).toEqual(["brain"]);
    });
  });
});
