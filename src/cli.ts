import { constants, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The default vault, next to `src/` and next to `dist/` (same relative path from both). */
export const TEMPLATE_DIR = fileURLToPath(new URL("../vault-template", import.meta.url));

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliOptions {
  /** Defaults to `TEMPLATE_DIR`; tests point it at a missing or odd template. */
  templateDir?: string;
}

const USAGE = "usage: node dist/cli.js init-vault <dir>";

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

/** Run the CLI and return the exit code: 0 ok, 1 failed, 2 usage error. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
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

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}
