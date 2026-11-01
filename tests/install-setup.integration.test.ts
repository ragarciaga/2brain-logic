import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, main } from "../src/cli.js";
import { defaultSetupDeps, type SetupDeps } from "../src/install/setup.js";
import { bootstrapVault } from "../src/install/vault-bootstrap.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const KEYSCAN_GITHUB = readFileSync(
  join(import.meta.dirname, "fixtures/ssh/keyscan-github.txt"),
  "utf8",
);
const PUB_KEY = `ssh-ed25519 ${["AAAA", "C3Nz", "aC1l", "ZDI1", "NTE5"].join("")} 2brain`;

let fixture: GitFixture;
let project: string;
let bare: string;

beforeEach(() => {
  fixture = createGitFixture();
  bare = join(fixture.root, "empty.git");
  mkdirSync(bare);
  git(fixture.root, ["init", "--bare", "--initial-branch=main", bare]);
  project = mkdtempSync(join(tmpdir(), "setup-int-"));
});
afterEach(() => {
  fixture.cleanup();
  rmSync(project, { recursive: true, force: true });
});

function io(out: string[], err: string[]): CliIo {
  return {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    stdinIsTTY: false,
    readStdin: async () => new Uint8Array(),
  };
}

/** Real files and real git; only the process identity, ssh binaries and the remote URL are fake. */
function deps(): SetupDeps {
  return {
    ...defaultSetupDeps,
    proc: { getuid: () => 1000, setgid: () => {}, setuid: () => {}, setgroups: () => {} },
    lchown: async () => {},
    fchown: async () => {},
    keygenRunner: async (_cmd, args) => {
      const file = args[args.indexOf("-f") + 1] as string;
      await writeFile(file, "fake-private-material\n");
      await writeFile(`${file}.pub`, `${PUB_KEY}\n`);
      return { code: 0 };
    },
    captureRunner: async () => ({ code: 0, stdout: KEYSCAN_GITHUB }),
    bootstrapVault: (opts) => bootstrapVault({ ...opts, remote: bare }),
    env: {},
  };
}

function args(extra: string[] = []): string[] {
  return [
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
    ...extra,
  ];
}

describe("main setup", () => {
  it("exits 0 with setup: done, seeds the bare remote and writes a 0600 .env", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args(), io(out, err), { setupDeps: deps() });
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out.at(-1)).toMatch(/^setup: done: .+$/);
    expect(out).toContain(PUB_KEY);
    expect(git(bare, ["log", "--format=%s", "main"])).toBe("2brain: seed vault template");
    if (process.platform !== "win32") {
      expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(project, "secrets", ".setup.lock"))).toBe(false);
    expect(readFileSync(join(project, "secrets", "known_hosts"), "utf8")).toMatch(/^github\.com /);
  });

  it("a re-run leaves .env byte-identical and exits 0", async () => {
    const first = await main(args(), io([], []), { setupDeps: deps() });
    const before = readFileSync(join(project, ".env"));
    const out: string[] = [];
    const second = await main(args(), io(out, []), { setupDeps: deps() });
    expect([first, second]).toEqual([0, 0]);
    expect(readFileSync(join(project, ".env")).equals(before)).toBe(true);
    expect(out.at(-1)).toMatch(/^setup: done: /);
  });

  it("missing answers exit 2 and leave the project directory empty", async () => {
    const argv = args().filter((x, i, a) => x !== "--remote" && a[i - 1] !== "--remote");
    const err: string[] = [];
    expect(await main(argv, io([], err), { setupDeps: deps() })).toBe(2);
    expect(err[0]).toMatch(/^setup: missing_answers: /);
    expect(readdirSync(project)).toEqual([]);
  });

  it("an invalid email exits 1 and leaves the project directory empty", async () => {
    const argv = args().map((x) => (x === "ana@example.com" ? "nope" : x));
    const err: string[] = [];
    expect(await main(argv, io([], err), { setupDeps: deps() })).toBe(1);
    expect(err[0]).toMatch(/^setup: invalid_answer: author-email: /);
    expect(readdirSync(project)).toEqual([]);
  });
});
