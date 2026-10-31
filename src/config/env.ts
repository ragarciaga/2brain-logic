import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  VAULT_DIR: z.string().min(1),
  VAULT_REMOTE: z.string().min(1).optional(),
  GIT_AUTHOR_NAME: z.string().min(1),
  GIT_AUTHOR_EMAIL: z.email(),
  INGEST_TOKEN: z.string().min(32),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
});

/**
 * Shape of `OWNER_PASSPHRASE_HASH`: `scrypt$<N>$<r>$<p>$<salt>$<key>` with a 16 byte salt (22
 * base64url characters) and a 32 byte key (43 base64url characters). The regex fixes the shape;
 * `isPassphraseHashFormat` also bounds N, r and p and the memory one call may use.
 */
export const PASSPHRASE_HASH_PATTERN =
  /^scrypt\$([1-9][0-9]*)\$([1-9][0-9]*)\$([1-9][0-9]*)\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

/** Most memory one scrypt call may use; `src/auth/owner.ts` passes it to Node as `maxmem`. */
export const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

/** Bytes OpenSSL's scrypt allocates: `128 * r * (N + 2)` for V plus `128 * r * p` for B. */
export function scryptMemoryBytes(n: number, r: number, p: number): number {
  return 128 * r * (n + 2 + p);
}

/** True when scrypt with these parameters fits in `MAX_SCRYPT_MEMORY` (strict `>` like OpenSSL). */
export function fitsScryptMemory(n: number, r: number, p: number): boolean {
  return !(scryptMemoryBytes(n, r, p) > MAX_SCRYPT_MEMORY);
}

/**
 * N, r and p of a well-formed hash: the exact shape, N a power of two from 2^14 to 2^20 and below
 * 2^(16r) (RFC 7914, which OpenSSL enforces), r from 1 to 32 and p from 1 to 16. `undefined` when
 * the value is anything else. The memory budget is a separate check, `fitsScryptMemory`.
 */
export function parsePassphraseHashParams(
  value: string,
): { n: number; r: number; p: number } | undefined {
  const match = PASSPHRASE_HASH_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const nInRange = n >= 2 ** 14 && n <= 2 ** 20 && Number.isInteger(Math.log2(n));
  if (!nInRange || n >= 2 ** (16 * r) || r < 1 || r > 32 || p < 1 || p > 16) {
    return undefined;
  }
  return { n, r, p };
}

/**
 * True when the value has the exact hash shape, N, r and p are inside the accepted bounds and one
 * scrypt call fits in `MAX_SCRYPT_MEMORY`. Startup uses it, so a hash `verifyPassphrase` would
 * refuse fails there, naming `OWNER_PASSPHRASE_HASH`.
 */
export function isPassphraseHashFormat(value: string): boolean {
  const params = parsePassphraseHashParams(value);
  return params !== undefined && fitsScryptMemory(params.n, params.r, params.p);
}

/**
 * The public base URL is an origin: https, or http only for loopback (`localhost`, `127.0.0.1`).
 * A path, query, fragment or userinfo is rejected, not stripped.
 */
function isAllowedBaseUrl(value: string): boolean {
  if (value.includes("?") || value.includes("#") || value.includes("@")) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return false;
  }
  if (url.pathname !== "/") {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"];

/** Digits only (no sign, decimal point, exponent or hex), at most `max`. Fixed message. */
function wholeNumber(message: string, max: number) {
  return z
    .string({ error: message })
    .regex(/^[0-9]+$/, { error: message })
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value <= max, { error: message });
}

// Every check carries a fixed message. Zod's default messages and the issue input are never
// surfaced, so a value cannot reach an error. Keep it so when adding a check.
const PublicEnvSchema = z.object({
  PUBLIC_BASE_URL: z
    .string({ error: "must be set to an https URL or an http loopback URL" })
    .refine(isAllowedBaseUrl, {
      error: "must be an origin: https, or http for localhost or 127.0.0.1, with no path",
    })
    .transform((value) => new URL(value).origin),
  OWNER_PASSPHRASE_HASH: z
    .string({ error: "is required when PUBLIC_BASE_URL is set" })
    .refine(isPassphraseHashFormat, {
      error: "is not a well-formed scrypt hash (scrypt$N$r$p$salt$key)",
    }),
  MCP_PORT: wholeNumber("must be a port number from 0 to 65535", 65535).default(3001),
  AUTH_STORE_DIR: z.string().min(1, { error: "must not be empty" }).default("/data/auth"),
  TRUST_PROXY_HOPS: wholeNumber(
    "must be a whole number, 0 or more",
    Number.MAX_SAFE_INTEGER,
  ).default(0),
  ALLOWED_REDIRECT_HOSTS: z
    .string({ error: "must be a comma separated list of host names" })
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== ""),
    )
    .refine((hosts) => hosts.length > 0 && hosts.every((host) => HOSTNAME_PATTERN.test(host)), {
      error: "must be a non-empty comma separated list of bare host names (punycode for IDN)",
    })
    .default(() => [...DEFAULT_REDIRECT_HOSTS]),
});

export type PublicEnv = z.output<typeof PublicEnvSchema>;

export type Env = z.infer<typeof EnvSchema> & { publicApp?: PublicEnv };

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read the service environment. Errors name the variables, never their values.
 * INGEST_TOKEN is required and at least 32 characters; it is taken as given, not trimmed.
 * ANTHROPIC_API_KEY is deliberately not read: nothing in the skeleton calls a real model.
 *
 * The public MCP part (`publicApp`) is read only when PUBLIC_BASE_URL is set (non-empty). Without
 * it the result has no `publicApp` key and the other public variables are not looked at. With it,
 * OWNER_PASSPHRASE_HASH is required and well formed, and AUTH_STORE_DIR must not be inside
 * VAULT_DIR. Problems from both parts come back in one error.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  // An empty value in .env (`VAULT_REMOTE=`) means "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  const publicParsed =
    cleaned.PUBLIC_BASE_URL === undefined ? undefined : PublicEnvSchema.safeParse(cleaned);

  const problems: string[] = [];
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  if (publicParsed !== undefined && !publicParsed.success) {
    problems.push(
      ...publicParsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  if (
    parsed.success &&
    publicParsed?.success &&
    isInside(publicParsed.data.AUTH_STORE_DIR, parsed.data.VAULT_DIR)
  ) {
    problems.push("AUTH_STORE_DIR: must not be inside VAULT_DIR");
  }
  if (problems.length > 0 || !parsed.success) {
    throw new Error(`Invalid environment: ${problems.join("; ")}`);
  }
  return publicParsed === undefined
    ? parsed.data
    : { ...parsed.data, publicApp: publicParsed.data };
}
