import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../src/cli.js";
import { EnvValueError } from "../src/install/env-file.js";
import type { PromptTerminal } from "../src/install/prompt.js";
import {
  defaultSetupDeps,
  runSetup,
  SETUP_USAGE,
  type SetupDeps,
  type SetupProc,
} from "../src/install/setup.js";
import {
  FIX_AUTH,
  FIX_CONFIG,
  FIX_MISMATCH,
  FIX_OWNERSHIP,
  FIX_UNREACHABLE,
} from "../src/install/vault-bootstrap.js";

// Real hashing unless a test turns the switch on: only the failure paths need a rejection.
const hashSwitch = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/auth/owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/owner.js")>();
  return {
    ...actual,
    hashPassphrase: (passphrase: string) =>
      hashSwitch.fail
        ? Promise.reject(new Error(`scrypt exploded on ${passphrase}`))
        : actual.hashPassphrase(passphrase),
  };
});

const KEYSCAN_GITHUB = readFileSync(
  join(import.meta.dirname, "fixtures/ssh/keyscan-github.txt"),
  "utf8",
);
const KEYSCAN_OTHER = readFileSync(
  join(import.meta.dirname, "fixtures/ssh/keyscan-other.txt"),
  "utf8",
);
const OTHER_FINGERPRINT = "SHA256:bDMUpweNPl+hOqU4AGZf/z5+8DYODm3qVd80rpVtei4";

const GITHUB_REMOTE = "git@github.com:owner/vault.git";
const OTHER_REMOTE = "git@git.example.com:owner/vault.git";
const PASS = ["correct", "horse", "battery", "staple"].join("-");
const PLANTED_TOKEN = ["tok", "Zq8vN2xLp0", "RwY4mKd7Hs"].join("-");
const PLANTED_HASH = ["scrypt", "32768", "8", "1", "c2FsdHNhbHRzYWx0", "ZGVyaXZlZGRlcml2ZWQ"].join(
  "$",
);
const PUB_KEY = ["ssh-ed25519", ["AAAA", "C3Nz", "aC1l", "ZDI1", "NTE5"].join(""), "2brain"].join(
  " ",
);
const DESIGN_CODES = [
  "invalid_answer",
  "remote_not_ssh",
  "missing_answers",
  "project_not_writable",
  "keygen_failed",
  "host_unreachable",
  "host_key_mismatch",
  "host_key_rejected",
  "remote_unreachable",
  "remote_auth_failed",
  "vault_remote_mismatch",
  "config_invalid",
  "push_refused",
  "done",
];

let root: string;
let project: string;
let vault: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "setup-unit-"));
  project = join(root, "project");
  vault = join(root, "vault");
  await mkdir(project);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Proc = { state: { uid: number; gid: number; calls: string[] }; proc: SetupProc };

/** A fake process identity: the real setuid is never called, whoever runs the tests. */
function fakeProc(uid: number): Proc {
  const state = { uid, gid: uid, calls: [] as string[] };
  return {
    state,
    proc: {
      getuid: () => state.uid,
      setgroups: () => {
        state.calls.push("setgroups");
      },
      setgid: (gid) => {
        state.calls.push(`setgid:${gid}`);
        state.gid = gid;
      },
      setuid: (id) => {
        state.calls.push(`setuid:${id}`);
        state.uid = id;
      },
    },
  };
}

type Scripted = PromptTerminal & { writes: string[]; closed: number; release(): void };

/** Replays `chunks`; `held` is a final read that stays pending until `release()` is called. */
function scripted(chunks: string[], held = false): Scripted {
  const queue = [...chunks];
  let pending: ((v: string | null) => void) | undefined;
  let heldLeft = held;
  const term: Scripted = {
    writes: [],
    closed: 0,
    isTTY: true,
    write: (text) => {
      term.writes.push(text);
    },
    read: () => {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (heldLeft) {
        heldLeft = false;
        return new Promise((resolve) => {
          pending = resolve;
        });
      }
      return Promise.resolve(null);
    },
    setRawMode: () => {},
    release: () => pending?.("\n"),
  };
  return term;
}

type Harness = {
  deps: SetupDeps;
  proc: Proc;
  io: CliIo;
  out: string[];
  err: string[];
  seen: { keygen: number[]; scan: number[]; bootstrap: number[]; lchown: string[] };
  bootstrap: ReturnType<typeof vi.fn>;
  openTerminal: ReturnType<typeof vi.fn>;
  term?: Scripted;
  all(): string;
};

function harness(
  options: {
    uid?: number;
    term?: Scripted;
    tty?: boolean;
    stdin?: () => Promise<Uint8Array>;
    scan?: (host: string) => { code: number; stdout: string };
    keygenCode?: number;
    bootstrap?: () => Promise<unknown>;
    overrides?: Partial<SetupDeps>;
  } = {},
): Harness {
  const proc = fakeProc(options.uid ?? 1000);
  const out: string[] = [];
  const err: string[] = [];
  const seen: Harness["seen"] = { keygen: [], scan: [], bootstrap: [], lchown: [] };
  const bootstrap = vi.fn(async () => {
    seen.bootstrap.push(proc.state.uid);
    return options.bootstrap ? options.bootstrap() : { code: "done", fix: "", seeded: false };
  });
  const openTerminal = vi.fn(() => {
    const term = options.term as Scripted;
    return {
      term,
      close: () => {
        term.closed += 1;
      },
    };
  });
  const deps: SetupDeps = {
    proc: proc.proc,
    lchown: async (path, uid, gid) => {
      seen.lchown.push(`${path}:${uid}:${gid}:as${proc.state.uid}`);
    },
    openTerminal: openTerminal as unknown as SetupDeps["openTerminal"],
    keygenRunner: async (_cmd, args) => {
      seen.keygen.push(proc.state.uid);
      if (options.keygenCode) return { code: options.keygenCode };
      const file = args[args.indexOf("-f") + 1] as string;
      await writeFile(file, "fake-private-material\n");
      await writeFile(`${file}.pub`, `${PUB_KEY}\n`);
      return { code: 0 };
    },
    captureRunner: async (_cmd, args) => {
      seen.scan.push(proc.state.uid);
      const host = args.at(-1) as string;
      if (options.scan) return options.scan(host);
      return { code: 0, stdout: host === "github.com" ? KEYSCAN_GITHUB : KEYSCAN_OTHER };
    },
    bootstrapVault: bootstrap as unknown as SetupDeps["bootstrapVault"],
    ensureDeployKey: defaultSetupDeps.ensureDeployKey,
    writeEnvFile: defaultSetupDeps.writeEnvFile,
    env: {},
    ...options.overrides,
  };
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdinIsTTY: options.tty ?? false,
    readStdin: options.stdin ?? (async () => new TextEncoder().encode(`${PASS}\n`)),
  };
  return {
    deps,
    proc,
    io,
    out,
    err,
    seen,
    bootstrap,
    openTerminal,
    term: options.term,
    all: () => [...out, ...err].join("\n"),
  };
}

function nonInteractiveArgs(extra: string[] = [], remote = GITHUB_REMOTE): string[] {
  return [
    "setup",
    "--non-interactive",
    "--remote",
    remote,
    "--author-name",
    "Ana Perez",
    "--author-email",
    "ana@example.com",
    "--project-dir",
    project,
    "--vault-dir",
    vault,
    ...extra,
  ];
}

async function entries(): Promise<string[]> {
  return (await readdir(project)).sort();
}

describe("setup output of a successful run", () => {
  it("prints the public key and the deploy key steps, without waiting, when non-interactive", async () => {
    const h = harness();
    const code = await runSetup(nonInteractiveArgs(), h.io, h.deps);
    expect(code).toBe(0);
    expect(h.out).toContain(PUB_KEY);
    const text = h.out.join("\n");
    expect(text).toContain("Deploy keys");
    expect(text).toContain("write access");
    expect(h.out.at(-1)).toMatch(/^setup: done: .+$/);
    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("on a terminal prints the key and makes no vault call until Enter", async () => {
    const term = scripted(
      ["git@github.com:owner/vault.git\n", "Ana Perez\n", "a@example.com\n", "\n", "\n"],
      true,
    );
    const h = harness({ term, tty: true });
    const running = runSetup(
      ["setup", "--project-dir", project, "--vault-dir", vault],
      h.io,
      h.deps,
    );
    await vi.waitFor(() => expect(term.writes.join("")).toContain("Press Enter"));
    expect(h.out).toContain(PUB_KEY);
    expect(h.bootstrap).not.toHaveBeenCalled();
    expect(term.writes.join("")).toContain("Added the deploy key with write access?");
    term.release();
    expect(await running).toBe(0);
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    expect(term.closed).toBe(1);
  });

  it("removes the lock when it ends and holds it while the vault step runs", async () => {
    let held = false;
    const h = harness({
      bootstrap: async () => {
        held = existsSync(join(project, "secrets", ".setup.lock"));
        return { code: "done", fix: "", seeded: false };
      },
    });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(0);
    expect(held).toBe(true);
    expect(existsSync(join(project, "secrets", ".setup.lock"))).toBe(false);
  });
});

describe("result lines and secrets (R1.6, D1)", () => {
  const bootstrapped = (code: string, extra: Record<string, unknown> = {}) => ({
    bootstrap: async () => ({ code, fix: FIX_UNREACHABLE, seeded: false, ...extra }),
  });

  type Scenario = {
    code: string;
    exit: number;
    args?: (base: string[]) => string[];
    opts?: Parameters<typeof harness>[0];
  };
  const scenarios: Scenario[] = [
    { code: "done", exit: 0 },
    {
      code: "missing_answers",
      exit: 2,
      args: (a) => a.filter((_, i) => a[i - 1] !== "--remote" && a[i] !== "--remote"),
    },
    {
      code: "invalid_answer",
      exit: 1,
      args: (a) => a.map((x) => (x === "ana@example.com" ? "not-an-email" : x)),
    },
    {
      code: "remote_not_ssh",
      exit: 1,
      args: (a) => a.map((x) => (x === GITHUB_REMOTE ? "https://example.com/x.git" : x)),
    },
    { code: "keygen_failed", exit: 1, opts: { keygenCode: 1 } },
    { code: "host_unreachable", exit: 1, opts: { scan: () => ({ code: 1, stdout: "" }) } },
    {
      code: "host_key_mismatch",
      exit: 1,
      opts: { scan: () => ({ code: 0, stdout: KEYSCAN_OTHER }) },
    },
    {
      code: "host_key_rejected",
      exit: 1,
      args: (a) => [
        ...a.map((x) => (x === GITHUB_REMOTE ? OTHER_REMOTE : x)),
        "--host-fingerprint",
        `SHA256:${"A".repeat(43)}`,
      ],
    },
    { code: "remote_unreachable", exit: 1, opts: bootstrapped("remote_unreachable") },
    {
      code: "remote_auth_failed",
      exit: 1,
      opts: bootstrapped("remote_auth_failed", { fix: FIX_AUTH }),
    },
    { code: "push_refused", exit: 1, opts: bootstrapped("push_refused", { fix: FIX_AUTH }) },
    {
      code: "vault_remote_mismatch",
      exit: 1,
      opts: bootstrapped("vault_remote_mismatch", { fix: FIX_MISMATCH }),
    },
    {
      code: "config_invalid",
      exit: 1,
      opts: bootstrapped("config_invalid", {
        fix: FIX_CONFIG,
        file: ".2brain/config.yaml",
        keyPath: "areas.0.name",
      }),
    },
    {
      code: "project_not_writable",
      exit: 1,
      opts: bootstrapped("project_not_writable", { fix: FIX_OWNERSHIP }),
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.code}: one well-formed line, exit ${scenario.exit}, no secret printed`, async () => {
      await writeFile(
        join(project, ".env"),
        `INGEST_TOKEN=${PLANTED_TOKEN}\nOWNER_PASSPHRASE_HASH='${PLANTED_HASH}'\n`,
      );
      const h = harness(scenario.opts);
      const base = nonInteractiveArgs([
        "--public-base-url",
        "https://brain.example.com",
        "--passphrase-stdin",
      ]);
      const argv = scenario.args ? scenario.args(base) : base;
      expect(await runSetup(argv, h.io, h.deps)).toBe(scenario.exit);

      const lines = [...h.out, ...h.err].filter((l) => l.startsWith("setup: "));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^setup: ${scenario.code}: .+$`));
      expect(DESIGN_CODES).toContain(scenario.code);
      expect(scenario.exit === 0 ? h.out : h.err).toContain(lines[0] as string);

      const envText = existsSync(join(project, ".env"))
        ? readFileSync(join(project, ".env"), "utf8")
        : "";
      const generated = /OWNER_PASSPHRASE_HASH='([^']+)'/.exec(envText)?.[1] ?? "";
      const output = h.all();
      for (const secret of [PLANTED_TOKEN, PLANTED_HASH, PASS, generated]) {
        for (let i = 0; i + 8 <= secret.length; i++) {
          expect(output.includes(secret.slice(i, i + 8))).toBe(false);
        }
      }
    });
  }

  it("a usage error is one missing_answers line with the usage text and exit 2", async () => {
    const h = harness();
    expect(await runSetup(["setup", "--non-interactive", "--bogus"], h.io, h.deps)).toBe(2);
    expect(h.err).toEqual([`setup: missing_answers: ${SETUP_USAGE}`]);
    const t = harness({ tty: true, term: scripted([]) });
    expect(await runSetup(["setup", "stray"], t.io, t.deps)).toBe(2);
    expect(t.err[0]).toMatch(/^setup: missing_answers: usage:/);
    expect(await entries()).toEqual([]);
  });

  it("interactive mode without a terminal exits 2 and writes nothing", async () => {
    const h = harness({ tty: false });
    expect(await runSetup(["setup", "--project-dir", project], h.io, h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/^setup: missing_answers: .*--non-interactive/);
    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });

  it("an unreadable standard input is invalid_answer for the passphrase and writes nothing", async () => {
    const h = harness({ stdin: () => Promise.reject(new Error(`boom ${PASS}`)) });
    const argv = nonInteractiveArgs([
      "--public-base-url",
      "https://brain.example.com",
      "--passphrase-stdin",
    ]);
    expect(await runSetup(argv, h.io, h.deps)).toBe(1);
    expect(h.err).toEqual(["setup: invalid_answer: passphrase: could not read standard input"]);
    expect(await entries()).toEqual([]);
  });
});

describe("file ownership and the privilege drop (D2)", () => {
  it("as root: .env goes to the project owner, secrets to 1000, then every call runs as 1000", async () => {
    const h = harness({ uid: 0 });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(0);
    const owner = await stat(project);
    expect(h.seen.lchown).toContain(`${join(project, ".env")}:${owner.uid}:${owner.gid}:as0`);
    expect(h.seen.lchown).toContain(`${join(project, "secrets")}:1000:1000:as0`);
    expect(h.proc.state.calls).toEqual(["setgroups", "setgid:1000", "setuid:1000"]);
    expect(h.seen.keygen).toEqual([1000]);
    expect(h.seen.scan).toEqual([1000]);
    expect(h.seen.bootstrap).toEqual([1000]);
  });

  it("as root: existing key files and known_hosts are handed to 1000 before the drop", async () => {
    const secrets = join(project, "secrets");
    await mkdir(secrets);
    for (const name of ["deploy_key", "deploy_key.pub", "known_hosts", "other.txt"]) {
      await writeFile(join(secrets, name), "x\n");
    }
    await symlink(join(secrets, "known_hosts"), join(secrets, "deploy_key.link"));
    const h = harness({ uid: 0 });
    await writeFile(join(secrets, "deploy_key.pub"), `${PUB_KEY}\n`);
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(0);
    for (const name of ["deploy_key", "deploy_key.pub", "known_hosts"]) {
      expect(h.seen.lchown).toContain(`${join(secrets, name)}:1000:1000:as0`);
    }
    expect(h.seen.lchown.some((l) => l.includes("other.txt"))).toBe(false);
    expect(h.seen.lchown.some((l) => l.includes("deploy_key.link"))).toBe(false);
    expect(h.seen.keygen).toEqual([]);
  });

  it("not root: no chown and no drop", async () => {
    const h = harness({ uid: 1234 });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(0);
    expect(h.seen.lchown).toEqual([]);
    expect(h.proc.state.calls).toEqual([]);
    expect(h.proc.state.uid).toBe(1234);
  });

  it("a failing drop is project_not_writable and no key work happens", async () => {
    const h = harness({ uid: 0 });
    h.deps.proc.setuid = () => {
      throw new Error("EPERM secret-looking detail");
    };
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^setup: project_not_writable: .+$/);
    expect(h.all()).not.toContain("secret-looking");
    expect(h.seen.keygen).toEqual([]);
    expect(existsSync(join(project, "secrets", ".setup.lock"))).toBe(false);
  });
});

describe("answers and directories", () => {
  it("D3: --keep-passphrase with no stored hash is missing_answers naming passphrase, nothing written", async () => {
    const h = harness();
    const argv = nonInteractiveArgs([
      "--public-base-url",
      "https://brain.example.com",
      "--keep-passphrase",
    ]);
    expect(await runSetup(argv, h.io, h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/^setup: missing_answers: passphrase: /);
    expect(await entries()).toEqual([]);
  });

  it("D4: a scrypt failure that is not about length is invalid_answer with its own rule (non-interactive)", async () => {
    hashSwitch.fail = true;
    try {
      const h = harness();
      const argv = nonInteractiveArgs([
        "--public-base-url",
        "https://brain.example.com",
        "--passphrase-stdin",
      ]);
      expect(await runSetup(argv, h.io, h.deps)).toBe(1);
      expect(h.err).toEqual([
        "setup: invalid_answer: passphrase: could not be hashed on this machine",
      ]);
      expect(h.all()).not.toContain("exploded");
      expect(await entries()).toEqual([]);
    } finally {
      hashSwitch.fail = false;
    }
  });

  it("D4: the same failure on a terminal does not loop, writes nothing and closes the terminal", async () => {
    hashSwitch.fail = true;
    try {
      const term = scripted([
        `${GITHUB_REMOTE}\n`,
        "Ana Perez\n",
        "ana@example.com\n",
        "https://brain.example.com\n",
        "\n",
        `${PASS}\r`,
        `${PASS}\r`,
      ]);
      const h = harness({ term, tty: true });
      expect(
        await runSetup(["setup", "--project-dir", project, "--vault-dir", vault], h.io, h.deps),
      ).toBe(1);
      expect(h.err).toEqual([
        "setup: invalid_answer: passphrase: could not be hashed on this machine",
      ]);
      expect(term.writes.filter((w) => w === "passphrase: ")).toHaveLength(1);
      expect(term.closed).toBe(1);
      expect(await entries()).toEqual([]);
    } finally {
      hashSwitch.fail = false;
    }
  });

  it("closes the terminal when the input ends early (exit 2) and when a step fails", async () => {
    const early = scripted([`${GITHUB_REMOTE}\n`]);
    const a = harness({ term: early, tty: true });
    expect(
      await runSetup(["setup", "--project-dir", project, "--vault-dir", vault], a.io, a.deps),
    ).toBe(2);
    expect(a.err[0]).toMatch(/^setup: missing_answers: .+$/);
    expect(early.closed).toBe(1);
    expect(await entries()).toEqual([]);

    const failing = scripted([`${GITHUB_REMOTE}\n`, "Ana\n", "a@example.com\n", "\n", "\n"]);
    const b = harness({ term: failing, tty: true, keygenCode: 1 });
    expect(
      await runSetup(["setup", "--project-dir", project, "--vault-dir", vault], b.io, b.deps),
    ).toBe(1);
    expect(failing.closed).toBe(1);
  });

  it("a missing project directory, an unsafe one and a vault that holds the project are refused", async () => {
    const h = harness();
    const missing = nonInteractiveArgs().map((x) => (x === project ? join(root, "nope") : x));
    expect(await runSetup(missing, h.io, h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/^setup: invalid_answer: project-dir: .+$/);

    const unsafe = join(root, "has space");
    await mkdir(unsafe);
    const spaced = nonInteractiveArgs().map((x) => (x === project ? unsafe : x));
    expect(await runSetup(spaced, h.io, h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/^setup: invalid_answer: project-dir: .+$/);

    const parent = nonInteractiveArgs().map((x) => (x === vault ? root : x));
    expect(await runSetup(parent, h.io, h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/^setup: invalid_answer: vault-dir: .+$/);

    const orphan = nonInteractiveArgs().map((x) => (x === vault ? join(root, "a", "b") : x));
    expect(await runSetup(orphan, h.io, h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/^setup: invalid_answer: vault-dir: .+$/);
    expect(await entries()).toEqual([]);
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it("VAULT_DIR from the environment is used when no flag is given", async () => {
    const h = harness({ overrides: { env: { VAULT_DIR: vault } } });
    const argv = nonInteractiveArgs().filter(
      (x, i, a) => x !== "--vault-dir" && a[i - 1] !== "--vault-dir",
    );
    expect(await runSetup(argv, h.io, h.deps)).toBe(0);
    expect(h.bootstrap.mock.calls[0]?.[0]).toMatchObject({ vaultDir: vault });
  });
});

describe(".env handling (D5)", () => {
  it("a .env symlink is refused before it is read and nothing else is written", async () => {
    const outside = join(root, "outside.env");
    await writeFile(outside, "INGEST_TOKEN=x\n");
    await symlink(outside, join(project, ".env"));
    const h = harness();
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^setup: project_not_writable: .+$/);
    expect(readFileSync(outside, "utf8")).toBe("INGEST_TOKEN=x\n");
    expect(existsSync(join(project, "secrets"))).toBe(false);
  });

  it("a write that fails on a read-only file system is project_not_writable", async () => {
    const h = harness({
      overrides: { writeEnvFile: async () => ({ ok: false, code: "project_not_writable" }) },
    });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toBe(`setup: project_not_writable: ${FIX_OWNERSHIP}`);
    expect(existsSync(join(project, "secrets"))).toBe(false);
  });

  it("an unwritable value is invalid_answer naming the key, not the value", async () => {
    const h = harness({
      overrides: {
        writeEnvFile: async () => {
          throw new EnvValueError("GIT_AUTHOR_NAME");
        },
      },
    });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "setup: invalid_answer: GIT_AUTHOR_NAME: value cannot be written to .env",
    ]);
  });
});

describe("the setup lock (D6)", () => {
  it("an existing lock is project_not_writable with a lock fix, keeps the lock and changes no key file", async () => {
    const secrets = join(project, "secrets");
    await mkdir(secrets);
    await writeFile(join(secrets, ".setup.lock"), "");
    await writeFile(join(secrets, "deploy_key"), "private-bytes\n");
    await writeFile(join(secrets, "deploy_key.pub"), `${PUB_KEY}\n`);
    const h = harness({ uid: 0 });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^setup: project_not_writable: .*\.setup\.lock/);
    expect(existsSync(join(secrets, ".setup.lock"))).toBe(true);
    expect(readFileSync(join(secrets, "deploy_key"), "utf8")).toBe("private-bytes\n");
    expect(h.seen.lchown.filter((l) => l.includes("secrets"))).toEqual([]);
    expect(h.proc.state.calls).toEqual([]);
    expect(h.seen.keygen).toEqual([]);
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it("a secrets entry that is not a directory is keygen_failed", async () => {
    await writeFile(join(project, "secrets"), "file");
    const h = harness();
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^setup: keygen_failed: .+$/);
  });
});

describe("host key pinning", () => {
  it("github.com is scanned and pinned without a question", async () => {
    const h = harness();
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(0);
    expect(h.seen.scan).toHaveLength(1);
    expect(readFileSync(join(project, "secrets", "known_hosts"), "utf8")).toMatch(
      /^github\.com ssh-ed25519 /,
    );
  });

  it("another host is pinned on a matching fingerprint when non-interactive", async () => {
    const h = harness();
    const argv = nonInteractiveArgs(["--host-fingerprint", OTHER_FINGERPRINT], OTHER_REMOTE);
    expect(await runSetup(argv, h.io, h.deps)).toBe(0);
    expect(readFileSync(join(project, "secrets", "known_hosts"), "utf8")).toMatch(
      /^git\.example\.com ssh-ed25519 /,
    );
  });

  it("another host asks the person on a terminal, and a refusal pins nothing", async () => {
    const lines = [`${OTHER_REMOTE}\n`, "Ana Perez\n", "ana@example.com\n", "\n", "\n"];
    const yes = scripted([...lines, "yes\n", "\n"]);
    const a = harness({ term: yes, tty: true });
    expect(
      await runSetup(["setup", "--project-dir", project, "--vault-dir", vault], a.io, a.deps),
    ).toBe(0);
    expect(yes.writes.join("")).toContain("Type yes to pin this host key");
    expect(existsSync(join(project, "secrets", "known_hosts"))).toBe(true);

    await rm(join(project, "secrets"), { recursive: true });
    const no = scripted([...lines, "no\n"]);
    const b = harness({ term: no, tty: true });
    expect(
      await runSetup(["setup", "--project-dir", project, "--vault-dir", vault], b.io, b.deps),
    ).toBe(1);
    expect(b.err[0]).toMatch(/^setup: host_key_rejected: .+$/);
    expect(existsSync(join(project, "secrets", "known_hosts"))).toBe(false);
  });
});

describe("config_invalid key path (D7)", () => {
  it("escapes control, bidi and zero-width characters and caps the path at 120 characters", async () => {
    const keyPath = `‮\u0007​\u0085\u007f${"k".repeat(300)}`;
    const h = harness({
      bootstrap: async () => ({
        code: "config_invalid",
        fix: FIX_CONFIG,
        file: ".2brain/config.yaml",
        keyPath,
        seeded: false,
      }),
    });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    const line = h.err[0] as string;
    expect(line).toMatch(/^setup: config_invalid: .+$/);
    expect(line).toContain("\\u{202E}\\u{0007}\\u{200B}\\u{0085}\\u{007F}");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/.test(line)).toBe(false);
    const shown = /\(\.2brain\/config\.yaml: (.*)\)$/.exec(line)?.[1] as string;
    expect(shown).toHaveLength(120);
  });
});

describe("a throwing vault step", () => {
  it("is project_not_writable with a fixed line and no thrown text", async () => {
    const h = harness({ bootstrap: () => Promise.reject(new Error(`git said ${PASS}`)) });
    expect(await runSetup(nonInteractiveArgs(), h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^setup: project_not_writable: .+$/);
    expect(h.all()).not.toContain(PASS);
    expect(existsSync(join(project, "secrets", ".setup.lock"))).toBe(false);
  });
});
