import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import type { SshRemote } from "./answers.js";

/**
 * Pure SSH host key helpers for the installer. They run no binaries: ssh-keyscan output comes in
 * as text. Host key checking is never relaxed; the only trust anchors are the constant below and
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

/** Writes exactly one line to `<secretsDir>/known_hosts` at mode 0600, replacing any content. */
export function writeKnownHosts(secretsDir: string, line: string): void {
  const file = `${secretsDir}/known_hosts`;
  writeFileSync(file, `${line}\n`, { mode: 0o600 });
  // The mode above applies only on creation (and the umask can narrow it): fix it explicitly.
  chmodSync(file, 0o600);
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
