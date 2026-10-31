import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { fitsScryptMemory, MAX_SCRYPT_MEMORY, parsePassphraseHashParams } from "../config/env.js";

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const MIN_PASSPHRASE_LENGTH = 12;
export { MAX_SCRYPT_MEMORY };

const SCRYPT_FAILED = "scrypt failed";
const TOO_SHORT = `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
const TOO_EXPENSIVE =
  "OWNER_PASSPHRASE_HASH needs more scrypt memory than the 64 MiB limit; create a new hash with hash-passphrase";

/**
 * A passphrase in canonical form (NFC, never NFKC), so the same typed text gives the same hash
 * whichever way the keyboard or the terminal composed it.
 */
function canonical(passphrase: string): string {
  return passphrase.normalize("NFC");
}

/** Unicode code points in the NFC form of the passphrase (an emoji counts once). */
export function passphraseLength(value: string): number {
  return [...canonical(value)].length;
}

/** One scrypt at a time for the whole process: the memory budget then holds as a process limit. */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** The key length is fixed here, never read from a stored hash. Errors carry no input. */
function derive(
  passphrase: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return serialize(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        try {
          scrypt(
            passphrase,
            salt,
            KEY_BYTES,
            { N: n, r, p, maxmem: MAX_SCRYPT_MEMORY },
            (error, key) => {
              if (error !== null) reject(new Error(SCRYPT_FAILED));
              else resolve(key);
            },
          );
        } catch {
          reject(new Error(SCRYPT_FAILED));
        }
      }),
  );
}

/**
 * Hash a passphrase of at least 12 characters (after NFC) as `scrypt$<N>$<r>$<p>$<salt>$<key>`
 * with a random 16 byte salt and a 32 byte key, both base64url. Throws a fixed error otherwise.
 */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const value = canonical(passphrase);
  if (passphraseLength(value) < MIN_PASSPHRASE_LENGTH) {
    throw new Error(TOO_SHORT);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(value, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * True when the passphrase matches the stored hash. False for a wrong passphrase and for a value
 * that is not a well-formed hash (no scrypt runs). A well-formed hash that needs more than
 * `MAX_SCRYPT_MEMORY` throws a fixed error before scrypt runs. Neither the passphrase nor the hash
 * appears in an error.
 */
export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const params = parsePassphraseHashParams(stored);
  if (params === undefined) {
    return false;
  }
  if (!fitsScryptMemory(params.n, params.r, params.p)) {
    throw new Error(TOO_EXPENSIVE);
  }
  // The pattern fixes 22 and 43 base64url characters, which decode to exactly 16 and 32 bytes.
  const parts = stored.split("$");
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  const actual = await derive(canonical(passphrase), salt, params.n, params.r, params.p);
  return timingSafeEqual(actual, expected);
}
