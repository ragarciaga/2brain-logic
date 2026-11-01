import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

/** The keys the installer owns in `.env`, in the order they are appended. */
export const MANAGED_KEYS = [
  "VAULT_REMOTE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "INGEST_TOKEN",
  "PUBLIC_BASE_URL",
  "OWNER_PASSPHRASE_HASH",
  "TRUST_PROXY_HOPS",
  "N8N_NETWORK",
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

/**
 * New answers for the managed keys. `undefined` means "no new answer, keep the
 * existing value". `publicBaseUrl: ""` is an answer that turns MCP off.
 */
export type EnvAnswers = {
  vaultRemote?: string;
  authorName?: string;
  authorEmail?: string;
  publicBaseUrl?: string;
  passphraseHash?: string;
  trustProxyHops?: number;
  n8nNetwork?: string;
};

export const ENV_MARKER = "# Written by 2brain setup";

export function generateIngestToken(): string {
  return randomBytes(32).toString("base64url");
}

function answerFor(answers: EnvAnswers, key: ManagedKey): string | undefined {
  switch (key) {
    case "VAULT_REMOTE":
      return answers.vaultRemote;
    case "GIT_AUTHOR_NAME":
      return answers.authorName;
    case "GIT_AUTHOR_EMAIL":
      return answers.authorEmail;
    case "PUBLIC_BASE_URL":
      return answers.publicBaseUrl;
    case "OWNER_PASSPHRASE_HASH":
      return answers.passphraseHash;
    case "TRUST_PROXY_HOPS":
      return answers.trustProxyHops === undefined ? undefined : String(answers.trustProxyHops);
    case "N8N_NETWORK":
      return answers.n8nNetwork;
    default:
      return undefined;
  }
}

/** Pure: answer, else existing value, else default, for each managed key. */
export function mergeEnv(
  existingText: string,
  answers: EnvAnswers,
  makeToken: () => string = generateIngestToken,
): Record<ManagedKey, string> {
  const existing = parseEnv(yamlToAssignments(existingText));
  const pick = (key: ManagedKey): string | undefined => answerFor(answers, key) ?? existing[key];

  const publicBaseUrl = pick("PUBLIC_BASE_URL") ?? "";
  const token = pick("INGEST_TOKEN");
  return {
    VAULT_REMOTE: pick("VAULT_REMOTE") ?? "",
    GIT_AUTHOR_NAME: pick("GIT_AUTHOR_NAME") ?? "",
    GIT_AUTHOR_EMAIL: pick("GIT_AUTHOR_EMAIL") ?? "",
    INGEST_TOKEN: token === undefined || token === "" ? makeToken() : token,
    PUBLIC_BASE_URL: publicBaseUrl,
    OWNER_PASSPHRASE_HASH: pick("OWNER_PASSPHRASE_HASH") ?? "",
    TRUST_PROXY_HOPS: pick("TRUST_PROXY_HOPS") ?? (publicBaseUrl === "" ? "0" : "1"),
    N8N_NETWORK: pick("N8N_NETWORK") ?? "n8n",
  };
}

const BARE = /^[A-Za-z0-9_@.:/+=-]*$/;

/** A value the installer refuses to write to `.env`; `key` names the variable, never the value. */
export class EnvValueError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`${key}: value cannot be written to .env`);
    this.name = "EnvValueError";
    this.key = key;
  }
}

function unwritable(key: string): Error {
  return new EnvValueError(key);
}

function formatValue(key: ManagedKey, value: string): string {
  if (value === "") return "";
  if (/[\n\r]/.test(value)) throw unwritable(key);
  // A backslash is an escape in double quotes and in some dotenv readers, so it is refused
  // unless the value is bare (and a bare value cannot contain one).
  if (value.includes("\\")) throw unwritable(key);
  if (key === "OWNER_PASSPHRASE_HASH") {
    if (value.includes("'")) throw unwritable(key);
    return `'${value}'`;
  }
  if (BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  // Double quotes interpolate `$` and process escapes in Compose, so they are
  // used only for a value that has none of those.
  if (/[$"]/.test(value)) throw unwritable(key);
  return `"${value}"`;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/;
const YAML_ASSIGNMENT = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*))\s*:\s*/;

function isManaged(key: string): key is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(key);
}

/**
 * Pure: rewrite `KEY: value` lines of managed keys as `KEY=value`, so `parseEnv` reads the
 * value after the colon the same way it reads one after an equals sign.
 */
function yamlToAssignments(text: string): string {
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const match = YAML_ASSIGNMENT.exec(line);
      if (match === null || !isManaged(match[2] as string)) return line;
      return `${match[1]}=${line.slice(match[0].length)}`;
    })
    .join("");
}

/**
 * Pure: put `values` into `existingText`. Unmanaged lines and managed lines
 * that already hold the right value keep their bytes. A key assigned twice
 * changes only its last assignment. Missing keys are appended under a marker.
 */
export function renderEnv(existingText: string, values: Record<ManagedKey, string>): string {
  const lines = existingText === "" ? [] : existingText.split(/(?<=\n)/);

  const lastIndex = new Map<ManagedKey, number>();
  lines.forEach((line, i) => {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key !== undefined && isManaged(key)) lastIndex.set(key, i);
  });

  for (const [key, i] of lastIndex) {
    const line = lines[i] as string;
    // A `KEY: value` line does not parse here, so it is always rewritten as `KEY=value`.
    if (parseEnv(line)[key] === values[key]) continue;
    const ending = /\r?\n$/.exec(line)?.[0] ?? "";
    lines[i] = `${key}=${formatValue(key, values[key])}${ending}`;
  }

  const missing = MANAGED_KEYS.filter((key) => !lastIndex.has(key));
  let out = lines.join("");
  if (missing.length === 0) return out;
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  out += `${ENV_MARKER}\n`;
  for (const key of missing) out += `${key}=${formatValue(key, values[key])}\n`;
  return out;
}

/** The file operations `writeEnvFile` uses, replaceable in tests. */
export interface EnvFileIo {
  writeTemp(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

async function defaultWriteTemp(file: string, data: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    // The open mode is masked by the umask and ignored for an existing file.
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The rename has happened; a failed directory flush only weakens durability.
  }
}

export type WriteEnvResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "project_not_writable" };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

/** Thrown by `readEnvText` for a `.env` that is not a regular file. */
export class EnvFileError extends Error {
  readonly code = "not_regular";
  constructor() {
    super(".env is not a regular file");
    this.name = "EnvFileError";
  }
}

/**
 * The text of `<projectDir>/.env`, or "" when it does not exist. A symlink, FIFO, device or
 * directory is refused before it is opened, and the open itself does not follow a link or block.
 */
export async function readEnvText(projectDir: string): Promise<string> {
  const target = path.join(projectDir, ".env");
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new EnvFileError();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, flags);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    if (errorCode(error) === "ELOOP") throw new EnvFileError();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new EnvFileError();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Merge `answers` into `<projectDir>/.env`. When the result equals the current bytes nothing is
 * written, except that a file wider than 0600 is narrowed to 0600 (content and times kept).
 * Otherwise the text goes to a 0600 temp file in the same directory and is
 * renamed over `.env`; the temp file never outlives the call. The result carries no value.
 */
export async function writeEnvFile(
  projectDir: string,
  answers: EnvAnswers,
  options: { makeToken?: () => string; io?: Partial<EnvFileIo> } = {},
): Promise<WriteEnvResult> {
  const io: EnvFileIo = { writeTemp: defaultWriteTemp, rename, ...options.io };
  const target = path.join(projectDir, ".env");
  const temp = path.join(projectDir, `.env.tmp-${randomBytes(8).toString("hex")}`);
  let ownsTemp = true;
  try {
    const existing = await readEnvText(projectDir);
    const next = renderEnv(existing, mergeEnv(existing, answers, options.makeToken));
    if (next === existing) {
      if (process.platform !== "win32") {
        try {
          const info = await lstat(target);
          if (info.isFile() && (info.mode & 0o077) !== 0) await chmod(target, 0o600);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      return { ok: true, changed: false };
    }
    ownsTemp = true;
    try {
      await io.writeTemp(temp, next);
    } catch (error) {
      if (errorCode(error) === "EEXIST") ownsTemp = false;
      throw error;
    }
    await io.rename(temp, target);
    ownsTemp = false;
    await syncDirectory(projectDir);
    return { ok: true, changed: true };
  } catch (error) {
    if (error instanceof EnvFileError) return { ok: false, code: "project_not_writable" };
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return { ok: false, code: "project_not_writable" };
    }
    throw error;
  } finally {
    if (ownsTemp) await unlink(temp).catch(() => {});
  }
}
