import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SshRemote } from "./answers.js";

/**
 * SSH helpers for the installer. Binaries (ssh-keygen) run only through an injected runner, so unit
 * tests need none; ssh-keyscan output comes in as text. Host key checking is never relaxed; the only trust anchors are the constant below and
 * the key a human confirms for another host.
 */

// Source: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
export const GITHUB_ED25519_FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** OpenSSH style fingerprint of a base64 key blob: `SHA256:` plus unpadded base64 of the digest. */
export function fingerprintSha256(base64Key: string): string {
  if (typeof base64Key !== "string" || base64Key.length % 4 !== 0 || !BASE64_RE.test(base64Key)) {
    throw new Error("fingerprintSha256: key is not strict base64");
  }
  const blob = Buffer.from(base64Key, "base64");
  if (blob.length === 0) {
    throw new Error("fingerprintSha256: key is empty");
  }
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** The base64 field of every `<host> ssh-ed25519 <b64>` line; comments, blanks and other key types are skipped. */
export function parseKeyscan(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length >= 3 && fields[1] === "ssh-ed25519") {
      keys.push(fields[2] as string);
    }
  }
  return keys;
}

/** One known_hosts line: the bare host for port 22, else `[host]:port`. */
export function knownHostsLine(remote: Pick<SshRemote, "host" | "port">, b64: string): string {
  const name = remote.port === 22 ? remote.host : `[${remote.host}]:${remote.port}`;
  return `${name} ssh-ed25519 ${b64}`;
}

/**
 * Writes exactly one line to `<secretsDir>/known_hosts` at mode 0600, replacing any content. A
 * target that exists and is not a regular file (a symlink included) is refused; the content goes
 * to a temp file in the same directory and is renamed into place.
 */
export function writeKnownHosts(secretsDir: string, line: string): void {
  const file = join(secretsDir, "known_hosts");
  const existing = lstatOrNull(file);
  if (existing !== null && !existing.isFile()) {
    throw new Error("writeKnownHosts: known_hosts exists and is not a regular file");
  }
  const tmp = join(secretsDir, `.known_hosts.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, `${line}\n`, { mode: 0o600, flag: "wx" });
    // The mode above is narrowed by the umask: fix it explicitly.
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type PinResult =
  | { ok: true; line: string }
  | { ok: false; code: "host_key_mismatch"; message: string };

/**
 * Pins github.com only when a scanned ed25519 key matches the published fingerprint. Other hosts
 * need a human confirmation and are not handled here.
 */
export function pinGithubHostKey(
  secretsDir: string,
  remote: Pick<SshRemote, "host" | "port">,
  keyscanText: string,
): PinResult {
  if (remote.host !== "github.com") {
    throw new Error("pinGithubHostKey: only github.com can be pinned automatically");
  }
  const keys = parseKeyscan(keyscanText);
  const match = keys.find((k) => {
    try {
      return fingerprintSha256(k) === GITHUB_ED25519_FINGERPRINT;
    } catch {
      return false;
    }
  });
  if (match === undefined) {
    const seen: string[] = [];
    for (const k of keys) {
      try {
        seen.push(fingerprintSha256(k));
      } catch {
        // A malformed blob is never printed.
      }
    }
    const seenText = seen.length > 0 ? seen.join(", ") : "none";
    return {
      ok: false,
      code: "host_key_mismatch",
      message: `host_key_mismatch: seen ${seenText}, expected ${GITHUB_ED25519_FINGERPRINT}`,
    };
  }
  const line = knownHostsLine(remote, match);
  writeKnownHosts(secretsDir, line);
  return { ok: true, line };
}

const SAFE_DIR_RE = /^\/[A-Za-z0-9/._-]+$/;

/** The strict `GIT_SSH_COMMAND` for the deploy key in `dir` (a container path; git runs it through a shell). */
export function gitSshCommand(dir: string): string {
  if (typeof dir !== "string" || !SAFE_DIR_RE.test(dir)) {
    throw new Error("gitSshCommand: directory must be an absolute path of safe characters");
  }
  return [
    "ssh",
    `-i ${dir}/deploy_key`,
    "-o IdentitiesOnly=yes",
    `-o UserKnownHostsFile=${dir}/known_hosts`,
    "-o StrictHostKeyChecking=yes",
    "-o BatchMode=yes",
    "-o ConnectTimeout=10",
    "-o ServerAliveInterval=5",
    "-o ServerAliveCountMax=2",
  ].join(" ");
}

export type RunResult = { code: number };
export type Runner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<RunResult>;
export type KeygenResult =
  | { ok: true; created: boolean }
  | { ok: false; code: "keygen_failed"; message: string };

/** Runs a binary with no shell and a timeout; resolves the exit code. Output is never returned or logged. */
export const execFileRunner: Runner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, windowsHide: true }, (error) => {
      if (error === null) {
        resolvePromise({ code: 0 });
        return;
      }
      const code = (error as { code?: unknown }).code;
      resolvePromise({ code: typeof code === "number" && code !== 0 ? code : 1 });
    });
  });

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function keygenFailed(reason: string): KeygenResult {
  return { ok: false, code: "keygen_failed", message: `keygen_failed: ${reason}` };
}

/**
 * Makes sure `<projectDir>/secrets/deploy_key` exists. An existing regular file is kept untouched
 * and the runner is not called. Otherwise ssh-keygen writes into a temp dir inside `secrets/` and
 * the files are renamed into place. Failures return `keygen_failed` with a fixed reason: runner
 * output and key bytes are never included, and an existing key is never deleted.
 */
export async function ensureDeployKey(
  projectDir: string,
  run: Runner = execFileRunner,
): Promise<KeygenResult> {
  const secretsDir = join(projectDir, "secrets");
  const finalKey = join(secretsDir, "deploy_key");
  const finalPub = join(secretsDir, "deploy_key.pub");
  let tmpDir: string | null = null;
  let pubMoved = false;
  try {
    const dirStat = lstatOrNull(secretsDir);
    if (dirStat === null) {
      mkdirSync(secretsDir, { mode: 0o700 });
    } else if (!dirStat.isDirectory()) {
      return keygenFailed("secrets is not a directory");
    }
    chmodSync(secretsDir, 0o700);

    const keyStat = lstatOrNull(finalKey);
    if (keyStat !== null) {
      return keyStat.isFile()
        ? { ok: true, created: false }
        : keygenFailed("deploy_key is not a regular file");
    }

    tmpDir = mkdtempSync(join(secretsDir, ".keygen-"));
    chmodSync(tmpDir, 0o700);
    const tmpKey = join(tmpDir, "deploy_key");
    const tmpPub = join(tmpDir, "deploy_key.pub");
    let result: RunResult;
    try {
      result = await run(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "2brain deploy key", "-f", tmpKey],
        { timeoutMs: 30000 },
      );
    } catch {
      return keygenFailed("ssh-keygen could not run");
    }
    if (result.code !== 0) {
      return keygenFailed("ssh-keygen exited with an error");
    }
    if (!lstatOrNull(tmpKey)?.isFile() || !lstatOrNull(tmpPub)?.isFile()) {
      return keygenFailed("ssh-keygen did not produce the key files");
    }
    chmodSync(tmpKey, 0o600);
    chmodSync(tmpPub, 0o644);
    renameSync(tmpPub, finalPub);
    pubMoved = true;
    renameSync(tmpKey, finalKey);
    pubMoved = false;
    return { ok: true, created: true };
  } catch {
    return keygenFailed("could not store the deploy key");
  } finally {
    if (pubMoved) {
      try {
        unlinkSync(finalPub);
      } catch {
        // Nothing more to clean.
      }
    }
    if (tmpDir !== null) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
