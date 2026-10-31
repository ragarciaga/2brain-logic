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

/** Sign-in lockout (R4.5): 5 counted attempts inside 15 minutes lock the key for 15 minutes. */
export const SIGNIN_LOCKOUT = Object.freeze({
  maxAttempts: 5,
  windowMs: 900_000,
  lockMs: 900_000,
  maxEntries: 2000,
});

export type LockoutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

export interface SignInLockout {
  /** Whether `key` may try now. Counts nothing. */
  check(key: string): LockoutResult;
  /**
   * Counts one attempt. The 5th inside the window returns ok and starts the lock, so the next
   * request is refused by `check`. Refuses when the table is full of live entries (fail closed).
   */
  record(key: string): LockoutResult;
  /** Clears the key after a right passphrase. */
  reset(key: string): void;
  size(): number;
}

export interface SignInLockoutOptions {
  /** Clock in milliseconds. Defaults to the monotonic `performance.now()`. */
  now?: () => number;
  /** Override for tests of the bound. */
  maxEntries?: number;
}

type LockEntry = { attempts: number[]; lockedUntil?: number };

/**
 * Sliding log of the last counted attempts per key (a /64 or IPv4 key from `rateKey`). Memory
 * only. A live entry is never evicted: at capacity a new key is refused, because evicting would
 * hand an attacker a fresh count.
 */
export function createSignInLockout(options: SignInLockoutOptions = {}): SignInLockout {
  const now = options.now ?? (() => performance.now());
  const maxEntries = options.maxEntries ?? SIGNIN_LOCKOUT.maxEntries;
  const { maxAttempts, windowMs, lockMs } = SIGNIN_LOCKOUT;
  const entries = new Map<string, LockEntry>();

  const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
  const expiry = (entry: LockEntry): number =>
    Math.max((entry.attempts.at(-1) ?? 0) + windowMs, entry.lockedUntil ?? 0);

  function live(key: string, at: number): LockEntry | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (at >= expiry(entry)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    check(key) {
      const at = now();
      const entry = live(key, at);
      if (entry?.lockedUntil !== undefined && at < entry.lockedUntil) {
        return { ok: false, retryAfterSeconds: seconds(entry.lockedUntil - at) };
      }
      return { ok: true };
    },

    record(key) {
      const at = now();
      let entry = live(key, at);
      if (entry?.lockedUntil !== undefined && at < entry.lockedUntil) {
        return { ok: false, retryAfterSeconds: seconds(entry.lockedUntil - at) };
      }
      if (entry === undefined) {
        if (entries.size >= maxEntries) {
          for (const other of entries.keys()) live(other, at);
        }
        if (entries.size >= maxEntries) {
          return { ok: false, retryAfterSeconds: seconds(windowMs) };
        }
        entry = { attempts: [] };
        entries.set(key, entry);
      }
      entry.attempts = entry.attempts.filter((t) => at - t < windowMs);
      entry.attempts.push(at);
      if (entry.attempts.length > maxAttempts) entry.attempts.shift();
      if (entry.attempts.length >= maxAttempts) entry.lockedUntil = at + lockMs;
      return { ok: true };
    },

    reset(key) {
      entries.delete(key);
    },

    size() {
      return entries.size;
    },
  };
}

/**
 * True when the passphrase matches the stored hash. False for a wrong passphrase, for a passphrase
 * that is not a string at runtime (checked before normalizing, so an object with its own
 * `normalize()` never verifies) and for a value that is not a well-formed hash (no scrypt runs). A
 * well-formed hash that needs more than `MAX_SCRYPT_MEMORY` throws a fixed error before scrypt
 * runs. Neither the passphrase nor the hash appears in an error.
 */
export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  if (typeof passphrase !== "string") {
    return false;
  }
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
