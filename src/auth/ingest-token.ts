import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const MIN_TOKEN_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * True when `header` is `Bearer <credential>` and the credential equals the token whose SHA-256
 * digest is `tokenDigest`. The scheme is matched case-insensitively (RFC 7235); the credential is
 * compared exactly, without trimming. Both sides are hashed first so the comparison runs over two
 * 32-byte values and takes the same time whatever the length of the credential.
 */
export function isAuthorizedHeader(header: string | undefined, tokenDigest: Buffer): boolean {
  if (header === undefined) return false;
  const space = header.indexOf(" ");
  if (space === -1) return false;
  if (header.slice(0, space).toLowerCase() !== "bearer") return false;
  const credential = header.slice(space + 1);
  if (credential === "") return false;
  return timingSafeEqual(digest(credential), tokenDigest);
}

/**
 * Hono middleware: every request except `GET /health` needs `Authorization: Bearer <token>`.
 * It answers 401 without calling the next handler, and never logs or echoes the header.
 */
export function ingestTokenAuth(token: string): MiddlewareHandler {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`ingest token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const tokenDigest = digest(token);
  return async (c, next) => {
    if (c.req.method === "GET" && c.req.path === "/health") {
      await next();
      return;
    }
    if (!isAuthorizedHeader(c.req.header("authorization"), tokenDigest)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  };
}
