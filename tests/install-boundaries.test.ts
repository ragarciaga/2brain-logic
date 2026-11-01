import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ exec: [] as { cmd: string; args: string[] }[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const real = actual.execFile;
  const wrapped = ((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    calls.exec.push({ cmd, args: [...args] });
    return (real as unknown as (...a: unknown[]) => unknown)(cmd, args, ...rest);
  }) as unknown as typeof actual.execFile;
  // runGit uses promisify(execFile); keep Node's custom promisified form.
  (wrapped as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: readonly string[],
    ...rest: unknown[]
  ) => {
    calls.exec.push({ cmd, args: [...args] });
    return (
      (real as unknown as Record<symbol, (...a: unknown[]) => unknown>)[promisify.custom] as (
        ...a: unknown[]
      ) => unknown
    )(cmd, args, ...rest);
  };
  return { ...actual, execFile: wrapped };
});

import { hashPassphrase } from "../src/auth/owner.js";
import { type CliIo, main } from "../src/cli.js";
import { cloneInto } from "../src/git/index.js";
import { defaultSetupDeps, type SetupDeps } from "../src/install/setup.js";
import { bootstrapVault } from "../src/install/vault-bootstrap.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const SRC_INSTALL = join(import.meta.dirname, "..", "src", "install");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("no LLM in the installer", () => {
  it("no file under src/install imports the SDK or the llm module", () => {
    const files = walk(SRC_INSTALL);
    const names = files.map((f) => f.slice(SRC_INSTALL.length + 1));
    expect(names).toContain("doctor.ts");
    expect(names).toContain("setup.ts");
    const forbidden = /(from|import\s*\(?)\s*["'](@anthropic-ai\/sdk|[^"']*\/llm(\/|["']))/;
    for (const file of files) {
      expect({ file, hit: forbidden.test(readFileSync(file, "utf8")) }).toStrictEqual({
        file,
        hit: false,
      });
    }
  });
});

describe("only allowed hosts", () => {
  const BASE = "https://brain.example.com";
  const KEYSCAN = readFileSync(
    join(import.meta.dirname, "fixtures/ssh/keyscan-github.txt"),
    "utf8",
  );
  const PUB_KEY = `ssh-ed25519 ${["AAAA", "C3Nz", "aC1l", "ZDI1", "NTE5"].join("")} 2brain`;
  let fixture: GitFixture;
  let bare: string;
  let project: string;

  beforeEach(() => {
    calls.exec.length = 0;
    fixture = createGitFixture();
    bare = join(fixture.root, "empty.git");
    mkdirSync(bare);
    git(fixture.root, ["init", "--bare", "--initial-branch=main", bare]);
    project = mkdtempSync(join(tmpdir(), "boundary-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fixture.cleanup();
    rmSync(project, { recursive: true, force: true });
  });

  it("setup and doctor reach only git, ssh-keygen, ssh-keyscan and the two HTTP origins", async () => {
    const runners: { cmd: string; args: string[] }[] = [];
    const setupDeps: SetupDeps = {
      ...defaultSetupDeps,
      proc: { getuid: () => 1000, setgid: () => {}, setuid: () => {}, setgroups: () => {} },
      lchown: async () => {},
      fchown: async () => {},
      keygenRunner: async (cmd, args) => {
        runners.push({ cmd, args: [...args] });
        const file = args[args.indexOf("-f") + 1] as string;
        await writeFile(file, "fake-private-material\n");
        await writeFile(`${file}.pub`, `${PUB_KEY}\n`);
        return { code: 0 };
      },
      captureRunner: async (cmd, args) => {
        runners.push({ cmd, args: [...args] });
        return { code: 0, stdout: KEYSCAN };
      },
      bootstrapVault: (opts) => bootstrapVault({ ...opts, remote: bare }),
      env: {},
    };
    const io: CliIo = {
      stdout: () => {},
      stderr: () => {},
      stdinIsTTY: false,
      readStdin: async () => new Uint8Array(),
    };
    const setupCode = await main(
      [
        "setup",
        "--non-interactive",
        "--remote",
        "git@github.com:owner/vault.git",
        "--author-name",
        "Ana Perez",
        "--author-email",
        "ana@example.com",
        "--project-dir",
        project,
        "--vault-dir",
        fixture.vaultDir,
      ],
      io,
      { setupDeps },
    );
    expect(setupCode).toBe(0);

    // The doctor run: its own clone and project files; no fetch is injected.
    const doctorVault = join(fixture.root, "doctor-vault");
    await cloneInto(fixture.remote, doctorVault);
    const doctorProject = join(fixture.root, "doctor-project");
    mkdirSync(join(doctorProject, "secrets"), { recursive: true });
    for (const f of [".env", "secrets/deploy_key", "secrets/known_hosts"]) {
      writeFileSync(join(doctorProject, f), "x\n");
      chmodSync(join(doctorProject, f), 0o600);
    }
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/health")) return Response.json({ ok: true });
      if (url.endsWith("/mcp")) return new Response(null, { status: 401 });
      return Response.json({ issuer: BASE });
    });
    const out: string[] = [];
    const doctorIo: CliIo = { ...io, stdout: (l) => out.push(l) };
    const marker = calls.exec.length;
    const doctorCode = await main(["doctor", "--project-dir", doctorProject], doctorIo, {
      doctorDeps: {
        env: {
          VAULT_DIR: doctorVault,
          VAULT_REMOTE: fixture.remote,
          GIT_AUTHOR_NAME: "Test Author",
          GIT_AUTHOR_EMAIL: "author@example.com",
          INGEST_TOKEN: ["fictional-test-token", "0123456789", "abcdefghij"].join("-"),
          PUBLIC_BASE_URL: BASE,
          OWNER_PASSPHRASE_HASH: await hashPassphrase("correct horse battery staple"),
        },
        lookup: async () => ({ address: "10.0.0.2" }),
      },
    });
    expect({ doctorCode, out }).toStrictEqual({
      doctorCode: 0,
      out: expect.arrayContaining(["doctor: 0 failed, 11 passed, 0 skipped"]),
    });

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(`${BASE}/`) || url.startsWith("http://brain:")).toBe(true);
    }
    expect(runners.map((r) => r.cmd).sort()).toStrictEqual(["ssh-keygen", "ssh-keyscan"]);
    expect(runners.find((r) => r.cmd === "ssh-keyscan")?.args.at(-1)).toBe("github.com");

    expect(calls.exec.length).toBeGreaterThan(marker);
    for (const call of calls.exec) {
      expect(call.cmd).toBe("git");
      for (const arg of call.args) {
        if (arg.includes(fixture.root)) {
          expect([bare, fixture.remote, fixture.vaultDir, doctorVault]).toContain(arg);
        }
      }
    }
    const subcommands = calls.exec.slice(marker).map((c) => c.args.join(" "));
    expect(subcommands.some((a) => a.includes("ls-remote"))).toBe(true);
    expect(subcommands.some((a) => a.includes("push"))).toBe(true);
  });
});
