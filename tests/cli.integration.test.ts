import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassphrase } from "../src/auth/owner.js";
import { type CliIo, main, TEMPLATE_DIR } from "../src/cli.js";
import { isPassphraseHashFormat, loadEnv } from "../src/config/env.js";

/** Every regular file under root: POSIX relative path to its bytes (hex). */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join("/")] = readFileSync(full).toString("hex");
    }
  };
  walk(root);
  return out;
}

interface FakeIo {
  io: CliIo;
  out: string[];
  err: string[];
  /** How many times the command asked for standard input. */
  reads: () => number;
}

/** `stdin` is what a read returns (an Error rejects); `tty` makes standard input a terminal. */
function fakeIo(stdin: Uint8Array | Error = new Uint8Array(), tty = false): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  let reads = 0;
  const io: CliIo = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    stdinIsTTY: tty,
    readStdin: async () => {
      reads += 1;
      if (stdin instanceof Error) throw stdin;
      return stdin;
    },
  };
  return { io, out, err, reads: () => reads };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const TEMPLATE_FILES = Object.keys(tree(TEMPLATE_DIR)).sort();
const CONFIG = ".2brain/config.yaml";
const INBOX_README = "inbox/README.md";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "init-vault-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("TEMPLATE_DIR", () => {
  it("is the vault-template folder at the repository root", () => {
    expect(TEMPLATE_DIR).toBe(join(import.meta.dirname, "..", "vault-template"));
    expect(existsSync(join(TEMPLATE_DIR, CONFIG))).toBe(true);
  });
});

describe("init-vault on a new vault", () => {
  it("copies the whole template into a missing directory", async () => {
    const target = join(root, "vault", "nested");
    const { io, out, err, reads } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(reads()).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(TEMPLATE_FILES).toContain(CONFIG);
    expect(out).toStrictEqual([
      ...TEMPLATE_FILES.map((f) => `copied ${f}`),
      `init-vault: ${TEMPLATE_FILES.length} copied, 0 skipped into ${target}`,
    ]);
    expect(err).toStrictEqual([]);
  });

  it("copies the whole template into an empty directory", async () => {
    const target = join(root, "empty");
    mkdirSync(target);
    const { io, out } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(out.at(-1)).toBe(
      `init-vault: ${TEMPLATE_FILES.length} copied, 0 skipped into ${target}`,
    );
  });
});

describe("init-vault listing", () => {
  it("lists a custom template in sorted POSIX order, nested paths included", async () => {
    const template = join(root, "template");
    mkdirSync(join(template, "b"), { recursive: true });
    for (const file of ["z.txt", "b/x.md", "b.txt", "a.txt"])
      writeFileSync(join(template, file), file);
    const target = join(root, "vault");
    const { io, out } = fakeIo();
    expect(await main(["init-vault", target], io, { templateDir: template })).toBe(0);
    expect(out).toStrictEqual([
      "copied a.txt",
      "copied b.txt",
      "copied b/x.md",
      "copied z.txt",
      `init-vault: 4 copied, 0 skipped into ${target}`,
    ]);
    expect(readFileSync(join(target, "b", "x.md"), "utf8")).toBe("b/x.md");
  });
});

describe("init-vault on a partial vault", () => {
  it("copies only the missing files, keeps existing bytes and lists the skipped ones", async () => {
    const target = join(root, "partial");
    mkdirSync(join(target, ".2brain"), { recursive: true });
    mkdirSync(join(target, "inbox"));
    writeFileSync(join(target, CONFIG), "my: config\n");
    writeFileSync(join(target, INBOX_README), "my inbox\n");
    writeFileSync(join(target, "extra.txt"), "not in the template\n");
    const before = tree(target);

    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);

    const after = tree(target);
    for (const [file, bytes] of Object.entries(before)) expect(after[file], file).toBe(bytes);
    const missing = TEMPLATE_FILES.filter((f) => f !== CONFIG && f !== INBOX_README);
    for (const file of missing) expect(after[file], file).toBe(tree(TEMPLATE_DIR)[file]);
    expect(Object.keys(after).sort()).toStrictEqual([...TEMPLATE_FILES, "extra.txt"].sort());

    expect(out).toContain(`skipped ${CONFIG} (exists)`);
    expect(out).toContain(`skipped ${INBOX_README} (exists)`);
    expect(out.filter((l) => l.startsWith("copied "))).toStrictEqual(
      missing.map((f) => `copied ${f}`),
    );
    expect(out.join("\n")).not.toContain("extra.txt");
    expect(out.at(-1)).toBe(`init-vault: ${missing.length} copied, 2 skipped into ${target}`);
    expect(err).toStrictEqual([]);
  });

  it("copies nothing on a second run and leaves every byte unchanged", async () => {
    const target = join(root, "twice");
    expect(await main(["init-vault", target], fakeIo().io)).toBe(0);
    const before = tree(target);

    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(tree(target)).toStrictEqual(before);
    expect(out).toStrictEqual([
      ...TEMPLATE_FILES.map((f) => `skipped ${f} (exists)`),
      `init-vault: 0 copied, ${TEMPLATE_FILES.length} skipped into ${target}`,
    ]);
    expect(err).toStrictEqual([]);
  });
});

describe("init-vault failures", () => {
  it("returns 1 for a file target, names the path and changes nothing", async () => {
    const target = join(root, "afile");
    writeFileSync(target, "plain file\n");
    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(1);
    expect(err.join("\n")).toContain(`target is not a directory: ${target}`);
    expect(out).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual(["afile"]);
    expect(readFileSync(target, "utf8")).toBe("plain file\n");
  });

  it("returns 1 for a missing template without creating the target", async () => {
    const target = join(root, "vault");
    const { io, out, err } = fakeIo();
    const code = await main(["init-vault", target], io, {
      templateDir: join(root, "no-such-template"),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("template not found");
    expect(out).toStrictEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("returns 1 for a template that is a file without creating the target", async () => {
    const template = join(root, "template-file");
    writeFileSync(template, "x");
    const target = join(root, "vault");
    const { io, err } = fakeIo();
    expect(await main(["init-vault", target], io, { templateDir: template })).toBe(1);
    expect(err.join("\n")).toContain("template not found");
    expect(existsSync(target)).toBe(false);
  });

  it("returns 1 with an error code, not a stack, when a template path is blocked by a file", async () => {
    const target = join(root, "blocked");
    mkdirSync(target);
    writeFileSync(join(target, "inbox"), "a file where a folder belongs\n");
    const { io, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^init-vault: [A-Z]+ /);
    expect(err[0]).toContain("inbox");
    expect(readFileSync(join(target, "inbox"), "utf8")).toBe("a file where a folder belongs\n");
  });
});

describe("usage errors", () => {
  const cases: [string, string[]][] = [
    ["no arguments", []],
    ["an unknown command", ["frobnicate", "x"]],
    ["a missing directory argument", ["init-vault"]],
    ["an extra argument", ["init-vault", "a", "b"]],
    ["an empty directory argument", ["init-vault", ""]],
    ["hash-passphrase with an argument", ["hash-passphrase", "x"]],
    ["hash-passphrase in another case", ["Hash-Passphrase"]],
  ];
  for (const [name, argv] of cases) {
    it(`returns 2 with usage and writes nothing for ${name}`, async () => {
      const before = readdirSync(process.cwd()).sort();
      const { io, out, err, reads } = fakeIo(bytes("a passphrase of enough length\n"));
      // A missing template makes a wrongly accepted argv exit 1 before any write, so a
      // regression in the usage check cannot seed a vault into the working directory.
      const options = { templateDir: join(root, "no-such-template") };
      expect(await main(argv, io, options)).toBe(2);
      expect(err.join("\n")).toContain("usage: node dist/cli.js init-vault <dir>");
      expect(err).toStrictEqual([
        "usage: node dist/cli.js init-vault <dir>\n       node dist/cli.js hash-passphrase",
      ]);
      expect(out).toStrictEqual([]);
      expect(reads()).toBe(0);
      expect(readdirSync(process.cwd()).sort()).toStrictEqual(before);
    });
  }
});

const PASSPHRASE = "correct horse battery staple";
const HASH_LINE = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const ENV_BASE = {
  VAULT_DIR: "/data/vault",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  INGEST_TOKEN: "fictional-test-token-0123456789-abcdefghij",
  PUBLIC_BASE_URL: "https://brain.example.com",
};

describe("hash-passphrase", () => {
  it("prints exactly one hash line and nothing else, accepted by loadEnv and verifyPassphrase", async () => {
    const { io, out, err, reads } = fakeIo(bytes("twelve chars"));
    expect(await main(["hash-passphrase"], io)).toBe(0);
    expect(reads()).toBe(1);
    expect(err).toStrictEqual([]);
    expect(out).toHaveLength(1);
    const hash = out[0] ?? "";
    expect(hash).toMatch(HASH_LINE);
    expect(loadEnv({ ...ENV_BASE, OWNER_PASSPHRASE_HASH: hash }).publicApp).toBeDefined();
    expect(await verifyPassphrase("twelve chars", hash)).toBe(true);
    expect(await verifyPassphrase("twelve charz", hash)).toBe(false);
  });

  it.each([
    ["no newline", "twelve chars"],
    ["one trailing LF", "twelve chars\n"],
    ["one trailing CRLF", "twelve chars\r\n"],
    ["a UTF-8 BOM", "﻿twelve chars"],
    ["a UTF-8 BOM and CRLF", "﻿twelve chars\r\n"],
  ])("hashes the same passphrase for input with %s", async (_label, input) => {
    const { io, out, err } = fakeIo(bytes(input));
    expect(await main(["hash-passphrase"], io)).toBe(0);
    expect(err).toStrictEqual([]);
    expect(await verifyPassphrase("twelve chars", out[0] ?? "")).toBe(true);
  });

  it("keeps spaces and strips only one line break", async () => {
    const { io, out } = fakeIo(bytes("  twelve chars  \n"));
    expect(await main(["hash-passphrase"], io)).toBe(0);
    const hash = out[0] ?? "";
    expect(await verifyPassphrase("  twelve chars  ", hash)).toBe(true);
    expect(await verifyPassphrase("twelve chars", hash)).toBe(false);
  });

  it("hashes the NFC form of a decomposed passphrase", async () => {
    const nfc = "café au lait demain";
    const { io, out } = fakeIo(bytes(nfc.normalize("NFD")));
    expect(await main(["hash-passphrase"], io)).toBe(0);
    expect(await verifyPassphrase(nfc, out[0] ?? "")).toBe(true);
  });

  it("gives a different hash on each run for the same passphrase", async () => {
    const first = fakeIo(bytes("twelve chars\n"));
    const second = fakeIo(bytes("twelve chars\n"));
    expect(await main(["hash-passphrase"], first.io)).toBe(0);
    expect(await main(["hash-passphrase"], second.io)).toBe(0);
    expect(first.out[0]).not.toBe(second.out[0]);
  });

  it("accepts a passphrase of exactly 1024 bytes", async () => {
    const { io, out } = fakeIo(bytes("a".repeat(1024)));
    expect(await main(["hash-passphrase"], io)).toBe(0);
    expect(out[0]).toMatch(HASH_LINE);
  });

  const failures: [string, Uint8Array | Error, string][] = [
    ["11 characters", bytes("elevenchars"), "passphrase must be at least 12 characters"],
    [
      "11 characters and a newline",
      bytes("elevenchars\n"),
      "passphrase must be at least 12 characters",
    ],
    ["6 emoji", bytes("\u{1F600}".repeat(6)), "passphrase must be at least 12 characters"],
    ["an empty input", bytes(""), "passphrase must be at least 12 characters"],
    ["only a newline", bytes("\n"), "passphrase must be at least 12 characters"],
    [
      "12 decomposed letters (6 after NFC)",
      bytes("é".repeat(6)),
      "passphrase must be at least 12 characters",
    ],
    ["two trailing newlines", bytes("twelve chars\n\n"), "input must be a single line"],
    ["a newline inside", bytes("twelve\nchars here\n"), "input must be a single line"],
    ["a lone trailing CR", bytes("twelve chars\r"), "input must be a single line"],
    ["invalid UTF-8", new Uint8Array([0x74, 0x77, 0xff, 0xfe, 0x65]), "input is not valid UTF-8"],
    [
      "a UTF-16LE BOM",
      new Uint8Array([0xff, 0xfe, ...[..."twelve chars"].flatMap((c) => [c.charCodeAt(0), 0])]),
      "input is not valid UTF-8",
    ],
    ["1025 bytes", bytes("a".repeat(1025)), "input is longer than 1024 bytes"],
    [
      "1024 characters and a newline",
      bytes(`${"a".repeat(1024)}\n`),
      "input is longer than 1024 bytes",
    ],
    ["a read failure", new Error("EIO twelve chars"), "could not read standard input"],
  ];
  for (const [name, stdin, message] of failures) {
    it(`exits 1 with one fixed line, no stdout and no input in it for ${name}`, async () => {
      const { io, out, err } = fakeIo(stdin);
      expect(await main(["hash-passphrase"], io)).toBe(1);
      expect(out).toStrictEqual([]);
      expect(err).toStrictEqual([`hash-passphrase: ${message}`]);
    });
  }

  it("refuses a terminal on standard input without reading it", async () => {
    const { io, out, err, reads } = fakeIo(bytes("twelve chars\n"), true);
    expect(await main(["hash-passphrase"], io)).toBe(1);
    expect(reads()).toBe(0);
    expect(out).toStrictEqual([]);
    expect(err).toStrictEqual([
      "hash-passphrase: standard input is a terminal; pipe the passphrase in (for example with read -s)",
    ]);
  });
});

describe("entry point", () => {
  // The CLI imports ./auth/owner.js, which Node cannot map to a .ts file, so the entry point is
  // tested the way it ships: compiled. A private build, so no other test sees a half-written dist.
  const repoRoot = join(import.meta.dirname, "..");
  const cacheRoot = join(repoRoot, "node_modules", ".cache");
  let build: string;
  let script: string;

  beforeAll(() => {
    mkdirSync(cacheRoot, { recursive: true });
    build = mkdtempSync(join(cacheRoot, "cli-entry-"));
    writeFileSync(join(build, "package.json"), '{"type":"module"}\n');
    cpSync(TEMPLATE_DIR, join(build, "vault-template"), { recursive: true });
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
    script = join(build, "dist", "cli.js");
    expect(existsSync(script)).toBe(true);
  }, 120000);

  afterAll(() => {
    if (build !== undefined) rmSync(build, { recursive: true, force: true });
  });

  const run = (args: string[], input?: string | Buffer) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input });

  it("runs main with the process arguments and exits 0 on success", () => {
    const target = join(root, "spawned");
    const result = run(["init-vault", target]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(result.stdout).toContain(`${TEMPLATE_FILES.length} copied, 0 skipped`);
  });

  it("sets a non-zero exit code on failure", () => {
    const target = join(root, "afile");
    writeFileSync(target, "x");
    const result = run(["init-vault", target]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(target);
  });

  it("does not run anything when imported", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log("loaded")`,
      ],
      { encoding: "utf8" },
    );
    expect(result.stdout.trim()).toBe("loaded");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("prints usage and exits 2 for hash-passphrase with an argument, without reading stdin", () => {
    const result = run(["hash-passphrase", "x"], PASSPHRASE);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: node dist/cli.js init-vault <dir>");
  });

  it("hash-passphrase prints one hash line on stdout, an empty stderr and exits 0", async () => {
    const result = run(["hash-passphrase"], `${PASSPHRASE}\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    const lines = result.stdout.slice(0, -1).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(HASH_LINE);
    expect(isPassphraseHashFormat(lines[0] ?? "")).toBe(true);
    expect(loadEnv({ ...ENV_BASE, OWNER_PASSPHRASE_HASH: lines[0] }).publicApp).toBeDefined();
    expect(await verifyPassphrase(PASSPHRASE, lines[0] ?? "")).toBe(true);
    const again = run(["hash-passphrase"], PASSPHRASE);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toBe(result.stdout);
  });

  it("hash-passphrase exits 1 for 11 characters, with a fixed message and no hash", () => {
    const result = run(["hash-passphrase"], "elevenchars\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("hash-passphrase: passphrase must be at least 12 characters\n");
  });

  it("hash-passphrase stops reading and refuses input over 1024 bytes", () => {
    const result = run(["hash-passphrase"], "a".repeat(5000));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("hash-passphrase: input is longer than 1024 bytes\n");
  });

  it("hash-passphrase refuses invalid UTF-8", () => {
    const result = run(["hash-passphrase"], Buffer.from([0x74, 0xff, 0xfe, 0x65]));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("hash-passphrase: input is not valid UTF-8\n");
  });

  it("never prints a distinctive passphrase, on success or on failure", () => {
    const secret = "zq-Distinct-Passphrase-7431";
    const cases: [string, number][] = [
      [`${secret}\n`, 0],
      [`${secret}\r\n`, 0],
      [`${secret}\n\n`, 1],
      [`${secret}\n${secret}\n`, 1],
      [`${secret}${"x".repeat(1100)}`, 1],
      ["zq-Dist-731", 1],
    ];
    for (const [input, status] of cases) {
      const result = run(["hash-passphrase"], input);
      expect(result.status, input.slice(0, 40)).toBe(status);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(result.stdout).not.toContain("zq-Dist");
      expect(result.stderr).not.toContain("zq-Dist");
    }
  });
});
