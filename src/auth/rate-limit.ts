import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/**
 * A fixed-window rule. `limit` requests per `windowMs` for one key (see `rateKey`). When
 * `globalLimit` is set, all keys together also share that many requests per window, so a client
 * that rotates through many keys (for example IPv6 addresses in different /64 blocks) still
 * meets a ceiling.
 */
export type RateRule = {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly globalLimit?: number;
};

function defineRule(rule: RateRule): RateRule {
  return Object.freeze({ ...rule });
}

/**
 * The public endpoint rules (R7.1) with their global ceilings (design.md, Rate limiter). Past a
 * global ceiling every request on that rule gets 429 until the window ends: an attacker can block
 * new sign-ins and registrations for a window, never an existing access token.
 */
export const RATE_RULES = Object.freeze({
  register: defineRule({ name: "register", limit: 10, windowMs: 3_600_000, globalLimit: 30 }),
  token: defineRule({ name: "token", limit: 60, windowMs: 60_000, globalLimit: 600 }),
  signin: defineRule({ name: "signin", limit: 10, windowMs: 60_000, globalLimit: 30 }),
});

const UNKNOWN_SOCKET = "unknown";
const MAX_IP_TEXT_LENGTH = 45;
const FALLBACK_LOG_LINE = "rate-limit: forwarded entry missing or not an IP; keyed on socket";

let fallbackLogged = false;

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.error(FALLBACK_LOG_LINE);
}

function assertWholeNumber(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer of at least ${minimum}`);
  }
}

function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_SOCKET;
  } catch {
    return UNKNOWN_SOCKET;
  }
}

/**
 * The client IP for rate limits and sign-in lockouts: the socket address when `trustProxyHops` is
 * 0, else the entry `trustProxyHops` places from the right of `X-Forwarded-For` (1 is the
 * rightmost, the one the nearest proxy appended). A client can write every entry to the left of
 * the proxies it passes through, so the leftmost value is never used. `trustProxyHops` must be
 * exactly the number of proxies in front of this app: a larger number lets an entry the client
 * wrote become the key. When the header has fewer entries than hops, or the selected entry is not
 * an IP (also longer than 45 characters or with a `%` zone), the socket address is used and one
 * fixed line is logged per process. Without a socket address the result is `unknown`.
 */
export function clientIp(c: Context, trustProxyHops: number): string {
  assertWholeNumber(trustProxyHops, "trustProxyHops", 0);
  const socket = socketAddress(c);
  if (trustProxyHops === 0) return socket;
  const header = c.req.header("x-forwarded-for");
  const entries = header === undefined ? [] : header.split(",").map((entry) => entry.trim());
  const selected = entries.length >= trustProxyHops ? entries[entries.length - trustProxyHops] : "";
  if (
    selected !== undefined &&
    selected.length <= MAX_IP_TEXT_LENGTH &&
    !selected.includes("%") &&
    isIP(selected) !== 0
  ) {
    return selected.toLowerCase();
  }
  logFallbackOnce();
  return socket;
}

function parseIPv6(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return undefined;
    const octets = tail.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const split = (half: string | undefined): string[] =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...rest];
  }
  if (groups.length !== 8) return undefined;
  const numbers: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    numbers.push(Number.parseInt(group, 16));
  }
  return numbers;
}

/**
 * The bucket key for a client IP, shared with the sign-in lockout. An IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d` in any case or compression) becomes its dotted IPv4 form, so one client cannot
 * be counted twice. Any other IPv6 address is reduced to its /64 prefix (the block one subscriber
 * controls), so rotating the low 64 bits does not give a fresh bucket. IPv4 keeps the full
 * address; anything that is not an IP (`unknown`) is returned unchanged.
 */
export function rateKey(ip: string): string {
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return ip;
  const groups = parseIPv6(ip);
  if (groups === undefined) return ip.toLowerCase();
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(":")}::/64`;
}

export type HitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

export type Limiter = {
  /** Counts one request for `key`; refused hits are not counted. */
  hit(key: string): HitResult;
  /** Number of keys currently held. */
  size(): number;
};

export type LimiterOptions = {
  /** Clock in milliseconds. Defaults to a monotonic clock. */
  readonly now?: () => number;
  /** Most keys held at once; the oldest is dropped past it. Default 10,000. */
  readonly maxBuckets?: number;
};

const originWallClock = Date.now();
const originMonotonic = performance.now();

/** Wall-clock milliseconds read once at load, advanced by the monotonic timer (immune to clock steps). */
function monotonicNow(): number {
  return originWallClock + (performance.now() - originMonotonic);
}

const DEFAULT_MAX_BUCKETS = 10_000;

type Counter = { start: number; count: number };

/**
 * Fixed-window counters. A window opens at the first counted hit of a key and ends exactly at
 * `start + windowMs`. Memory is bounded: expired keys are dropped on later hits and at most
 * `maxBuckets` keys are held. When the rule has a `globalLimit`, one more counter sums all keys.
 */
export function createLimiter(rule: RateRule, options: LimiterOptions = {}): Limiter {
  assertWholeNumber(rule.limit, "limit", 1);
  assertWholeNumber(rule.windowMs, "windowMs", 1);
  if (rule.globalLimit !== undefined) assertWholeNumber(rule.globalLimit, "globalLimit", 1);
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  assertWholeNumber(maxBuckets, "maxBuckets", 1);
  const now = options.now ?? monotonicNow;
  const { limit, windowMs, globalLimit } = rule;
  const maxRetry = Math.ceil(windowMs / 1000);
  // Insertion order is window-start order: an expired key is swept before it is set again.
  const buckets = new Map<string, Counter>();
  let global: Counter | undefined;

  const retryAfter = (counter: Counter, at: number): number =>
    Math.min(maxRetry, Math.max(1, Math.ceil((counter.start + windowMs - at) / 1000)));

  return {
    hit(key) {
      const at = now();
      for (const [oldKey, counter] of buckets) {
        if (at < counter.start + windowMs) break;
        buckets.delete(oldKey);
      }
      if (global !== undefined && at >= global.start + windowMs) global = undefined;

      let bucket = buckets.get(key);
      if (bucket !== undefined && at >= bucket.start + windowMs) {
        // Reached only if the clock stepped back: the front sweep stops at the first live entry.
        buckets.delete(key);
        bucket = undefined;
      }
      if (bucket !== undefined && bucket.count >= limit) {
        return { ok: false, retryAfterSeconds: retryAfter(bucket, at) };
      }
      if (globalLimit !== undefined && global !== undefined && global.count >= globalLimit) {
        return { ok: false, retryAfterSeconds: retryAfter(global, at) };
      }

      if (bucket === undefined) {
        if (buckets.size >= maxBuckets) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
        }
        buckets.set(key, { start: at, count: 1 });
      } else {
        bucket.count += 1;
      }
      if (globalLimit !== undefined) {
        if (global === undefined) global = { start: at, count: 1 };
        else global.count += 1;
      }
      return { ok: true };
    },
    size() {
      return buckets.size;
    },
  };
}

export type RateLimitDeps = {
  /** Number of trusted proxies in front of the app (`TRUST_PROXY_HOPS`). */
  readonly trustProxyHops: number;
  readonly now?: () => number;
  readonly maxBuckets?: number;
};

/**
 * Hono middleware: answers 429 with `Retry-After` once a client (by `rateKey(clientIp(...))`) or
 * the whole rule is past its limit. The body is fixed and never carries the client IP or any
 * header value. The only output is the one fixed, value-free fallback line from `clientIp`
 * (once per process), written when `trustProxyHops` is 1 or more and the forwarded entry is
 * missing or not an IP. Each call owns its own counters: mount one instance per rule, never one
 * instance on two rules.
 */
export function rateLimit(rule: RateRule, deps: RateLimitDeps): MiddlewareHandler {
  assertWholeNumber(deps.trustProxyHops, "trustProxyHops", 0);
  const { trustProxyHops } = deps;
  const limiter = createLimiter(rule, { now: deps.now, maxBuckets: deps.maxBuckets });
  return async (c, next) => {
    const result = limiter.hit(rateKey(clientIp(c, trustProxyHops)));
    if (result.ok) {
      await next();
      return;
    }
    c.header("Retry-After", String(result.retryAfterSeconds));
    c.header("Cache-Control", "no-store");
    return c.json(
      { error: "too_many_requests", error_description: "Too many requests, retry later" },
      429,
    );
  };
}
