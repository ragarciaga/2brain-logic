import { constants, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassphrase, MIN_PASSPHRASE_LENGTH, passphraseLength } from "./auth/owner.js";

/** The default vault, next to `src/` and next to `dist/` (same relative path from both). */
export const TEMPLATE_DIR = fileURLToPath(new URL("../vault-template", import.meta.url));

/** `hash-passphrase` refuses standard input longer than this many bytes. */
export const MAX_STDIN_BYTES = 1024;

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** True when standard input is a terminal. Only `hash-passphrase` looks at it. */
  stdinIsTTY: boolean;
  /**
   * Standard input as bytes. Only `hash-passphrase` calls it. It may stop reading after more than
   * `MAX_STDIN_BYTES`, which the command then refuses.
   */
  readStdin(): Promise<Uint8Array>;
}

export interface CliOptions {
  /** Defaults to `TEMPLATE_DIR`; tests point it at a missing or odd template. */
  templateDir?: string;
}

const USAGE = "usage: node dist/cli.js init-vault <dir>\n       node dist/cli.js hash-passphrase";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Regular files under `root` as sorted POSIX relative paths. */
async function listTemplateFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listTemplateFiles(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function isDirectory(path: string): Promise<boolean | "missing"> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

async function initVault(targetArg: string, io: CliIo, templateDir: string): Promise<number> {
  const target = resolve(targetArg);
  let files: string[];
  try {
    if ((await isDirectory(templateDir)) !== true) {
      io.stderr(`init-vault: template not found: ${templateDir}`);
      return 1;
    }
    files = await listTemplateFiles(templateDir);
  } catch (error) {
    io.stderr(`init-vault: ${errorCode(error)} ${templateDir}`);
    return 1;
  }

  let current = target;
  try {
    const state = await isDirectory(target);
    if (state === false) {
      io.stderr(`init-vault: target is not a directory: ${target}`);
      return 1;
    }
    if (state === "missing") await mkdir(target, { recursive: true });

    let copied = 0;
    let skipped = 0;
    for (const rel of files) {
      const dest = join(target, ...rel.split("/"));
      current = dest;
      let exists = true;
      try {
        await lstat(dest);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        exists = false;
      }
      if (!exists) {
        await mkdir(dirname(dest), { recursive: true });
        try {
          await copyFile(join(templateDir, ...rel.split("/")), dest, constants.COPYFILE_EXCL);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          exists = true;
        }
      }
      if (exists) {
        skipped += 1;
        io.stdout(`skipped ${rel} (exists)`);
      } else {
        copied += 1;
        io.stdout(`copied ${rel}`);
      }
    }
    io.stdout(`init-vault: ${copied} copied, ${skipped} skipped into ${target}`);
    return 0;
  } catch (error) {
    io.stderr(`init-vault: ${errorCode(error)} ${current}`);
    return 1;
  }
}

/**
 * Read the passphrase from standard input and print its hash, and nothing else on stdout. One
 * trailing `\r\n` or `\n` is dropped; any other line break, input over `MAX_STDIN_BYTES`, bytes
 * that are not UTF-8 and fewer than 12 characters each give one fixed message and exit 1. A UTF-8
 * BOM is dropped by the decoder. No message ever contains the input.
 */
async function hashPassphraseCommand(io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr(`hash-passphrase: ${message}`);
    return 1;
  };
  if (io.stdinIsTTY) {
    return fail("standard input is a terminal; pipe the passphrase in (for example with read -s)");
  }
  let bytes: Uint8Array;
  try {
    bytes = await io.readStdin();
  } catch {
    return fail("could not read standard input");
  }
  if (bytes.length > MAX_STDIN_BYTES) {
    return fail(`input is longer than ${MAX_STDIN_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("input is not valid UTF-8");
  }
  const passphrase = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (passphrase.includes("\n") || passphrase.includes("\r")) {
    return fail("input must be a single line");
  }
  if (passphraseLength(passphrase) < MIN_PASSPHRASE_LENGTH) {
    return fail(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  let hash: string;
  try {
    hash = await hashPassphrase(passphrase);
  } catch {
    return fail("could not hash the passphrase");
  }
  io.stdout(hash);
  return 0;
}

/** Run the CLI and return the exit code: 0 ok, 1 failed, 2 usage error. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  if (argv[0] === "hash-passphrase" && argv.length === 1) {
    return hashPassphraseCommand(io);
  }
  if (argv[0] !== "init-vault" || argv.length !== 2 || argv[1] === undefined || argv[1] === "") {
    io.stderr(USAGE);
    return 2;
  }
  return initVault(argv[1], io, options.templateDir ?? TEMPLATE_DIR);
}

function isEntryPoint(): boolean {
  try {
    const script = process.argv[1];
    if (script === undefined) return false;
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** The part of a readable stream the CLI uses: chunks, and whether it is a terminal. */
export type StdinSource = AsyncIterable<string | Uint8Array> & { isTTY?: boolean };

/**
 * Collect standard input, stopping once it is longer than `MAX_STDIN_BYTES`: the result is then at
 * most `MAX_STDIN_BYTES` plus one chunk, and the source is not read to its end.
 */
export async function readProcessStdin(
  source: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) break;
  }
  return Buffer.concat(chunks);
}

/** The `CliIo` of the real process, built on the given standard input (`process.stdin`). */
export function processIo(stdin: StdinSource): CliIo {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdinIsTTY: stdin.isTTY === true,
    readStdin: () => readProcessStdin(stdin),
  };
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), processIo(process.stdin));
}
