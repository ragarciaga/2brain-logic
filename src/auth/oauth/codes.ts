import { createHash, randomBytes } from "node:crypto";

/**
 * Authorization codes (RFC 6749 section 4.1.2), in memory only.
 *
 * - A code is 32 random bytes (base64url). Only its SHA-256 is kept, so the map never holds a
 *   usable code.
 * - A code is bound to the client, the effective redirect URI, the PKCE challenge and the
 *   resource it was issued for, expires after `ttlMs` and works once.
 * - A consumed code leaves its hash in a second bounded memory for a while, so that a replay is
 *   told apart from an unknown code (RFC 6749 section 4.1.2: revoke what the code produced). A
 *   replay keeps its entry so repeated replays are still detected.
 * - Memory is bounded. Past `maxCodes` the oldest live code is dropped; a dropped code is simply
 *   refused later and never enters the consumed memory. Past `maxConsumed` the oldest consumed
 *   entry is dropped, which only weakens revocation: that code is still refused.
 */

export const CODE_LIMITS = Object.freeze({
  ttlMs: 60_000,
  maxCodes: 1000,
  /** How long a consumed hash is remembered after the code would have expired. */
  consumedMarginMs: 600_000,
  maxConsumed: 1000,
});

export interface CodeBinding {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
}

export type ConsumeResult =
  | { kind: "ok"; binding: CodeBinding; codeHash: string }
  | { kind: "replayed"; codeHash: string; grantId?: string }
  | { kind: "invalid" };

export interface CodeStore {
  /** Issues a single-use code bound to `binding`. */
  issue(binding: CodeBinding): string;
  /** Uses a code once. Unknown, expired-unused and non-string input are `invalid`. */
  consume(code: unknown): ConsumeResult;
  /**
   * Records the grant a consumed code produced. Returns `{ replayed: true }` when the code was
   * already presented again before this call, so the caller revokes the grant at once. Returns
   * `{ replayed: false }` otherwise, and also when the entry is no longer remembered.
   */
  attachGrant(codeHash: string, grantId: string): { replayed: boolean };
  /** Live (issued, unused) codes held. */
  size(): number;
  /** Consumed hashes remembered. */
  consumedSize(): number;
}

export interface CodeStoreOptions {
  /** Clock in milliseconds. Defaults to the monotonic `performance.now()`. */
  now?: () => number;
  /** Overrides for tests of the bounds. */
  maxCodes?: number;
  maxConsumed?: number;
}

type Live = { binding: CodeBinding; expiresAt: number };
type Consumed = { retainUntil: number; replayed: boolean; grantId?: string };

const hashOf = (code: string): string => createHash("sha256").update(code).digest("base64url");

export function createCodeStore(options: CodeStoreOptions = {}): CodeStore {
  const now = options.now ?? (() => performance.now());
  const maxCodes = options.maxCodes ?? CODE_LIMITS.maxCodes;
  const maxConsumed = options.maxConsumed ?? CODE_LIMITS.maxConsumed;
  const live = new Map<string, Live>();
  const consumed = new Map<string, Consumed>();

  function sweep(at: number): void {
    for (const [hash, entry] of live) {
      if (at >= entry.expiresAt) live.delete(hash);
    }
    for (const [hash, entry] of consumed) {
      if (at >= entry.retainUntil) consumed.delete(hash);
    }
  }

  return {
    issue(binding) {
      const at = now();
      sweep(at);
      while (live.size >= maxCodes) {
        const oldest = live.keys().next();
        if (oldest.done) break;
        live.delete(oldest.value);
      }
      const code = randomBytes(32).toString("base64url");
      live.set(hashOf(code), { binding: { ...binding }, expiresAt: at + CODE_LIMITS.ttlMs });
      return code;
    },

    consume(code) {
      if (typeof code !== "string") return { kind: "invalid" };
      const at = now();
      sweep(at);
      const codeHash = hashOf(code);
      const entry = live.get(codeHash);
      if (entry !== undefined) {
        // `sweep` above already dropped every expired code, so this one is live.
        live.delete(codeHash);
        while (consumed.size >= maxConsumed) {
          const oldest = consumed.keys().next();
          if (oldest.done) break;
          consumed.delete(oldest.value);
        }
        consumed.set(codeHash, {
          retainUntil: entry.expiresAt + CODE_LIMITS.consumedMarginMs,
          replayed: false,
        });
        return { kind: "ok", binding: { ...entry.binding }, codeHash };
      }
      const used = consumed.get(codeHash);
      if (used !== undefined) {
        used.replayed = true;
        return {
          kind: "replayed",
          codeHash,
          ...(used.grantId === undefined ? {} : { grantId: used.grantId }),
        };
      }
      return { kind: "invalid" };
    },

    attachGrant(codeHash, grantId) {
      const used = consumed.get(codeHash);
      if (used === undefined) return { replayed: false };
      used.grantId = grantId;
      return { replayed: used.replayed };
    },

    size() {
      return live.size;
    },

    consumedSize() {
      return consumed.size;
    },
  };
}
