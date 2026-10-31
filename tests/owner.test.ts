import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashPassphrase,
  KEY_BYTES,
  MAX_SCRYPT_MEMORY,
  MIN_PASSPHRASE_LENGTH,
  passphraseLength,
  SALT_BYTES,
  verifyPassphrase,
} from "../src/auth/owner.js";
import { isPassphraseHashFormat, loadEnv } from "../src/config/env.js";

// The spies call through to the real functions: the hashes below are real scrypt output.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: vi.fn(actual.scrypt),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const scryptSpy = vi.mocked(crypto.scrypt);
const equalSpy = vi.mocked(crypto.timingSafeEqual);

beforeEach(() => {
  scryptSpy.mockClear();
  equalSpy.mockClear();
});

// Fictional passphrases, 12 characters or more.
const PASSPHRASE = "correct horse battery staple";
const OTHER = "wrong horse battery staple";

const salt = Buffer.alloc(16, 7).toString("base64url");
const key = Buffer.alloc(32, 9).toString("base64url");
const fake = (n: number | string, r: number | string, p: number | string = 1) =>
  `scrypt$${n}$${r}$${p}$${salt}$${key}`;

describe("passphraseLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["a b ", 4],
    ["\u{1F600}\u{1F600}", 2],
    ["é", 1],
    ["é", 1],
  ])("counts %j as %i code points after NFC", (value, expected) => {
    expect(passphraseLength(value)).toBe(expected);
  });
});

describe("hashPassphrase", () => {
  it("returns the documented format, accepted by the env loader", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(isPassphraseHashFormat(hash)).toBe(true);
    const env = loadEnv({
      VAULT_DIR: "/data/vault",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      INGEST_TOKEN: "fictional-test-token-0123456789-abcdefghij",
      PUBLIC_BASE_URL: "https://brain.example.com",
      OWNER_PASSPHRASE_HASH: hash,
    });
    expect(env.publicApp?.OWNER_PASSPHRASE_HASH).toBe(hash);
  });

  it("uses a random salt: two hashes of one passphrase differ and both verify", async () => {
    const a = await hashPassphrase(PASSPHRASE);
    const b = await hashPassphrase(PASSPHRASE);
    expect(a).not.toBe(b);
    expect(a.split("$")[4]).not.toBe(b.split("$")[4]);
    expect(await verifyPassphrase(PASSPHRASE, a)).toBe(true);
    expect(await verifyPassphrase(PASSPHRASE, b)).toBe(true);
  });

  it("derives exactly 32 bytes with N 2^15, r 8, p 1 and an explicit maxmem", async () => {
    await hashPassphrase(PASSPHRASE);
    expect(scryptSpy).toHaveBeenCalledTimes(1);
    const [, saltArg, keylen, options] = scryptSpy.mock.calls[0] as unknown as [
      string,
      Buffer,
      number,
      Record<string, number>,
    ];
    expect(keylen).toBe(KEY_BYTES);
    expect(keylen).toBe(32);
    expect(saltArg.length).toBe(SALT_BYTES);
    expect(options).toStrictEqual({ N: 32768, r: 8, p: 1, maxmem: MAX_SCRYPT_MEMORY });
  });

  it("rejects 11 characters with a fixed error and runs no scrypt", async () => {
    const short = "elevenchars";
    expect(short).toHaveLength(MIN_PASSPHRASE_LENGTH - 1);
    const error = await hashPassphrase(short).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("passphrase must be at least 12 characters");
    expect((error as Error).message).not.toContain(short);
    expect(scryptSpy).not.toHaveBeenCalled();
  });

  it("counts code points: 12 emoji pass, 11 do not", async () => {
    const emoji = "\u{1F600}";
    await expect(hashPassphrase(emoji.repeat(11))).rejects.toThrow("at least 12");
    expect(await verifyPassphrase(emoji.repeat(12), await hashPassphrase(emoji.repeat(12)))).toBe(
      true,
    );
  });

  it("counts after NFC: 12 decomposed letters are 6 characters and are rejected", async () => {
    const nfd = "é".repeat(6);
    expect(nfd).toHaveLength(12);
    await expect(hashPassphrase(nfd)).rejects.toThrow("at least 12");
  });
});

describe("verifyPassphrase", () => {
  it("is true for the right passphrase and false for a wrong one", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    expect(await verifyPassphrase(PASSPHRASE, hash)).toBe(true);
    expect(await verifyPassphrase(OTHER, hash)).toBe(false);
    expect(await verifyPassphrase("", hash)).toBe(false);
  });

  it("does not trim: a trailing newline or space makes it a different passphrase", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    expect(await verifyPassphrase(`${PASSPHRASE}\n`, hash)).toBe(false);
    expect(await verifyPassphrase(`${PASSPHRASE} `, hash)).toBe(false);
  });

  it("derives 32 bytes with explicit maxmem and compares once with timingSafeEqual", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    scryptSpy.mockClear();
    equalSpy.mockClear();
    expect(await verifyPassphrase(PASSPHRASE, hash)).toBe(true);
    expect(scryptSpy).toHaveBeenCalledTimes(1);
    const [, , keylen, options] = scryptSpy.mock.calls[0] as unknown as [
      string,
      Buffer,
      number,
      Record<string, number>,
    ];
    expect(keylen).toBe(32);
    expect(options).toStrictEqual({ N: 32768, r: 8, p: 1, maxmem: MAX_SCRYPT_MEMORY });
    expect(equalSpy).toHaveBeenCalledTimes(1);
    const [left, right] = equalSpy.mock.calls[0] as unknown as [Buffer, Buffer];
    expect(left.length).toBe(32);
    expect(right.length).toBe(32);
    expect(right.toString("base64url")).toBe(hash.split("$")[5]);
  });

  it("verifies a hash made by a plain scryptSync with N 16384", async () => {
    const saltBytes = crypto.randomBytes(16);
    const derived = crypto.scryptSync(PASSPHRASE, saltBytes, 32, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${saltBytes.toString("base64url")}$${derived.toString("base64url")}`;
    expect(await verifyPassphrase(PASSPHRASE, stored)).toBe(true);
    expect(await verifyPassphrase(OTHER, stored)).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["garbage", "garbage"],
    ["another algorithm", `bcrypt$32768$8$1$${salt}$${key}`],
    ["bcrypt$", "bcrypt$"],
    ["N not a power of two", fake(32767, 8)],
    ["N below 2^14", fake(8192, 8)],
    ["r zero", fake(32768, 0)],
    ["p zero", fake(32768, 8, 0)],
    ["N not below 2^(16r)", fake(65536, 1)],
    ["a short salt", `scrypt$32768$8$1$${salt.slice(0, 21)}$${key}`],
    ["a long key", `scrypt$32768$8$1$${salt}$${key}A`],
    ["a trailing newline", `${fake(32768, 8)}\n`],
  ])("is false for a malformed hash (%s) without calling scrypt", async (_label, stored) => {
    expect(await verifyPassphrase(PASSPHRASE, stored)).toBe(false);
    expect(scryptSpy).not.toHaveBeenCalled();
    expect(equalSpy).not.toHaveBeenCalled();
  });
});

/** Whether real Node accepts these parameters under the budget (it throws synchronously if not). */
function nodeAccepts(n: number, r: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      crypto.scrypt("x", Buffer.alloc(16), 32, { N: n, r, p: 1, maxmem: MAX_SCRYPT_MEMORY }, (e) =>
        resolve(e === null),
      );
    } catch {
      resolve(false);
    }
  });
}

describe("memory budget", () => {
  it("accepts a hash right under 64 MiB and refuses the next r without calling scrypt", async () => {
    // Real Node agrees with the formula: r 15 runs under maxmem, r 16 does not.
    expect(await nodeAccepts(32768, 15)).toBe(true);
    expect(await nodeAccepts(32768, 16)).toBe(false);
    scryptSpy.mockClear();

    expect(await verifyPassphrase(PASSPHRASE, fake(32768, 15))).toBe(false);
    expect(scryptSpy).toHaveBeenCalledTimes(1);
    scryptSpy.mockClear();

    await expect(verifyPassphrase(PASSPHRASE, fake(32768, 16))).rejects.toThrow(
      "OWNER_PASSPHRASE_HASH needs more scrypt memory than the 64 MiB limit; create a new hash with hash-passphrase",
    );
    expect(scryptSpy).not.toHaveBeenCalled();
  });

  it("refuses N 2^20 with r 8 with a fixed error and no scrypt", async () => {
    const stored = fake(1048576, 8);
    const error = await verifyPassphrase(PASSPHRASE, stored).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("64 MiB");
    expect((error as Error).message).not.toContain(PASSPHRASE);
    expect((error as Error).message).not.toContain(stored);
    expect((error as Error).message).not.toContain(salt);
    expect(scryptSpy).not.toHaveBeenCalled();
  });

  it("never returns true for a hash that real scrypt refuses (unmocked)", async () => {
    // Over budget for real Node: the pre-check throws, and even a direct call is refused.
    await expect(verifyPassphrase(PASSPHRASE, fake(32768, 16))).rejects.toThrow();
    await expect(verifyPassphrase(PASSPHRASE, fake(2 ** 18, 2))).rejects.toThrow();
    const direct = await nodeAccepts(2 ** 18, 2);
    expect(direct).toBe(false);
  });
});

describe("errors", () => {
  it("rejects with the fixed scrypt failed error when scrypt reports an error", async () => {
    scryptSpy.mockImplementationOnce(((...args: unknown[]) => {
      (args[4] as (e: Error | null, k?: Buffer) => void)(new Error(`boom ${PASSPHRASE}`));
    }) as unknown as typeof crypto.scrypt);
    const error = await hashPassphrase(PASSPHRASE).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe("scrypt failed");
  });

  it("rejects with the fixed scrypt failed error when scrypt throws synchronously", async () => {
    scryptSpy.mockImplementationOnce((() => {
      throw new Error(`sync boom ${PASSPHRASE}`);
    }) as unknown as typeof crypto.scrypt);
    const error = await hashPassphrase(PASSPHRASE).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe("scrypt failed");
    // The failure does not poison the queue: the next call works.
    expect(await verifyPassphrase(PASSPHRASE, await hashPassphrase(PASSPHRASE))).toBe(true);
  });

  it("carries neither the passphrase nor the hash in any error", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    const messages: string[] = [];
    for (const attempt of [
      () => hashPassphrase("short"),
      () => verifyPassphrase(PASSPHRASE, fake(1048576, 8)),
    ]) {
      messages.push(((await attempt().catch((e: unknown) => e)) as Error).message);
    }
    for (const message of messages) {
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain(hash);
      expect(message).not.toContain(salt);
    }
  });
});

describe("normalization", () => {
  const nfc = "café au lait demain";
  const nfd = nfc.normalize("NFD");

  it("verifies an NFC passphrase against a hash made from the NFD form, and the reverse", async () => {
    expect(nfd).not.toBe(nfc);
    const fromNfd = await hashPassphrase(nfd);
    const fromNfc = await hashPassphrase(nfc);
    expect(await verifyPassphrase(nfc, fromNfd)).toBe(true);
    expect(await verifyPassphrase(nfd, fromNfc)).toBe(true);
  });

  it("does not apply compatibility folding (NFKC)", async () => {
    const hash = await hashPassphrase("ﬁnal answer here");
    expect(await verifyPassphrase("final answer here", hash)).toBe(false);
    expect(await verifyPassphrase("ﬁnal answer here", hash)).toBe(true);
  });

  it("hands scrypt the NFC form", async () => {
    await hashPassphrase(nfd);
    expect(scryptSpy.mock.calls[0]?.[0]).toBe(nfc);
  });
});

describe("one scrypt at a time", () => {
  it("never has two scrypt calls in flight, even when many verifications start together", async () => {
    const hash = await hashPassphrase(PASSPHRASE);
    let inFlight = 0;
    let maxInFlight = 0;
    scryptSpy.mockClear();
    const real = (await vi.importActual<typeof import("node:crypto")>("node:crypto")).scrypt;
    scryptSpy.mockImplementation(((...args: unknown[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = args[4] as (e: Error | null, k: Buffer) => void;
      (real as unknown as (...a: unknown[]) => void)(
        args[0],
        args[1],
        args[2],
        args[3],
        (e: Error | null, k: Buffer) => {
          inFlight -= 1;
          done(e, k);
        },
      );
    }) as unknown as typeof crypto.scrypt);
    try {
      const results = await Promise.all([
        verifyPassphrase(PASSPHRASE, hash),
        verifyPassphrase(OTHER, hash),
        verifyPassphrase(PASSPHRASE, hash),
        verifyPassphrase(OTHER, hash),
      ]);
      expect(results).toStrictEqual([true, false, true, false]);
      expect(scryptSpy).toHaveBeenCalledTimes(4);
      expect(maxInFlight).toBe(1);
    } finally {
      scryptSpy.mockImplementation(real as unknown as typeof crypto.scrypt);
    }
  });
});
