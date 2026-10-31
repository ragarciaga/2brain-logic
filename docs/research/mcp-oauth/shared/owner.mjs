// Owner passphrase: stored only as an scrypt hash (env OWNER_PASSPHRASE_HASH), compared in constant time.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1;

export async function hashPassphrase(passphrase) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(passphrase, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassphrase(passphrase, stored) {
  const [kind, n, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = await scryptAsync(String(passphrase ?? ""), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(got, expected);
}
