import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fitsScryptMemory,
  isInside,
  isPassphraseHashFormat,
  loadEnv,
  MAX_SCRYPT_MEMORY,
  PASSPHRASE_HASH_PATTERN,
  parsePassphraseHashParams,
  scryptMemoryBytes,
} from "../src/config/env.js";

const valid = {
  VAULT_DIR: "/data/vault",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  INGEST_TOKEN: ["fictional-test-token", "0123456789", "abcdefghij"].join("-"),
};

describe("loadEnv", () => {
  it("applies the documented defaults", () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.VAULT_REMOTE).toBeUndefined();
  });

  it("takes the documented variables", () => {
    const env = loadEnv({
      ...valid,
      VAULT_REMOTE: "git@example.com:you/vault.git",
      PORT: "8080",
      HOST: "0.0.0.0",
    });
    expect(env).toEqual({
      ...valid,
      VAULT_REMOTE: "git@example.com:you/vault.git",
      PORT: 8080,
      HOST: "0.0.0.0",
    });
  });

  it("treats an empty VAULT_REMOTE as not set", () => {
    expect(loadEnv({ ...valid, VAULT_REMOTE: "" }).VAULT_REMOTE).toBeUndefined();
  });

  it("throws on a missing VAULT_DIR", () => {
    const { VAULT_DIR: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/VAULT_DIR/);
  });

  it("throws on a missing GIT_AUTHOR_NAME", () => {
    const { GIT_AUTHOR_NAME: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/GIT_AUTHOR_NAME/);
  });

  it("throws on a missing INGEST_TOKEN", () => {
    const { INGEST_TOKEN: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/INGEST_TOKEN/);
  });

  it("throws on an empty INGEST_TOKEN", () => {
    expect(() => loadEnv({ ...valid, INGEST_TOKEN: "" })).toThrow(/INGEST_TOKEN/);
  });

  it("throws on a 31-character INGEST_TOKEN without echoing it", () => {
    const marker = "short-marker-";
    const token = marker + "x".repeat(31 - marker.length);
    expect(token).toHaveLength(31);
    try {
      loadEnv({ ...valid, INGEST_TOKEN: token });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/INGEST_TOKEN/);
      expect(message).not.toContain(marker);
      expect(message).not.toContain(token);
    }
  });

  it("accepts a 32-character INGEST_TOKEN", () => {
    const token = "a".repeat(32);
    expect(loadEnv({ ...valid, INGEST_TOKEN: token }).INGEST_TOKEN).toBe(token);
  });

  it("returns an INGEST_TOKEN with surrounding whitespace exactly as given", () => {
    const token = `  ${"a".repeat(32)}  `;
    expect(loadEnv({ ...valid, INGEST_TOKEN: token }).INGEST_TOKEN).toBe(token);
  });

  it("accepts a whitespace-only 32-character INGEST_TOKEN", () => {
    const token = " ".repeat(32);
    expect(loadEnv({ ...valid, INGEST_TOKEN: token }).INGEST_TOKEN).toBe(token);
  });

  it("throws on a bad GIT_AUTHOR_EMAIL", () => {
    expect(() => loadEnv({ ...valid, GIT_AUTHOR_EMAIL: "not-an-email" })).toThrow(
      /GIT_AUTHOR_EMAIL/,
    );
  });

  it("throws on an out-of-range PORT without echoing the value", () => {
    expect(() => loadEnv({ ...valid, PORT: "70000" })).toThrow(/PORT/);
  });

  it("does not put a bad value in the error message", () => {
    const marker = ["secret", "marker", "value"].join("-");
    try {
      loadEnv({ ...valid, GIT_AUTHOR_EMAIL: marker });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(marker);
    }
  });
});

// A well-formed hash built at runtime: 16 byte salt (22 characters), 32 byte key (43 characters).
const salt = Buffer.alloc(16, 7).toString("base64url");
const key = Buffer.alloc(32, 9).toString("base64url");
const goodHash = `scrypt$32768$8$1$${salt}$${key}`;
const pub = { PUBLIC_BASE_URL: "https://brain.example.com", OWNER_PASSPHRASE_HASH: goodHash };

/** The load must throw; the message names `name` and contains none of the markers. */
function expectNamedWithout(
  env: Record<string, string | undefined>,
  name: string,
  ...markers: string[]
): void {
  try {
    loadEnv(env);
    expect.unreachable();
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toMatch(/^Invalid environment: /);
    expect(message).toContain(name);
    for (const marker of markers) {
      expect(message).not.toContain(marker);
    }
  }
}

describe("loadEnv without PUBLIC_BASE_URL", () => {
  it("returns no publicApp key when PUBLIC_BASE_URL is unset", () => {
    expect("publicApp" in loadEnv(valid)).toBe(false);
  });

  it("returns no publicApp key when PUBLIC_BASE_URL is empty", () => {
    expect("publicApp" in loadEnv({ ...valid, PUBLIC_BASE_URL: "" })).toBe(false);
  });

  it("does not check the other public variables", () => {
    const env = loadEnv({
      ...valid,
      OWNER_PASSPHRASE_HASH: "garbage",
      MCP_PORT: "abc",
      TRUST_PROXY_HOPS: "-1",
      ALLOWED_REDIRECT_HOSTS: "https://nope",
      AUTH_STORE_DIR: "/data/vault/auth",
    });
    expect("publicApp" in env).toBe(false);
  });
});

describe("loadEnv with PUBLIC_BASE_URL", () => {
  it("applies the documented defaults", () => {
    expect(loadEnv({ ...valid, ...pub }).publicApp).toEqual({
      PUBLIC_BASE_URL: "https://brain.example.com",
      OWNER_PASSPHRASE_HASH: goodHash,
      MCP_PORT: 3001,
      AUTH_STORE_DIR: "/data/auth",
      TRUST_PROXY_HOPS: 0,
      ALLOWED_REDIRECT_HOSTS: ["claude.ai", "claude.com", "chatgpt.com"],
    });
  });

  it("keeps the base variables unchanged next to publicApp", () => {
    const { publicApp: _omit, ...base } = loadEnv({ ...valid, ...pub });
    expect(base).toEqual({ ...valid, PORT: 3000, HOST: "127.0.0.1" });
  });

  it("takes custom values, trimming and lowercasing the redirect hosts", () => {
    const env = loadEnv({
      ...valid,
      ...pub,
      MCP_PORT: "8081",
      AUTH_STORE_DIR: "/srv/auth",
      TRUST_PROXY_HOPS: "1",
      ALLOWED_REDIRECT_HOSTS: " a.example.com , B.example.com ,, ",
    });
    expect(env.publicApp).toMatchObject({
      MCP_PORT: 8081,
      AUTH_STORE_DIR: "/srv/auth",
      TRUST_PROXY_HOPS: 1,
      ALLOWED_REDIRECT_HOSTS: ["a.example.com", "b.example.com"],
    });
  });

  it("treats an empty ALLOWED_REDIRECT_HOSTS as the default list", () => {
    const env = loadEnv({ ...valid, ...pub, ALLOWED_REDIRECT_HOSTS: "" });
    expect(env.publicApp?.ALLOWED_REDIRECT_HOSTS).toEqual([
      "claude.ai",
      "claude.com",
      "chatgpt.com",
    ]);
  });

  it.each([
    ["http://127.0.0.1:3001", "http://127.0.0.1:3001"],
    ["http://localhost:3001", "http://localhost:3001"],
    ["https://brain.example.com", "https://brain.example.com"],
    ["https://brain.example.com/", "https://brain.example.com"],
    ["https://Brain.Example.com:8443", "https://brain.example.com:8443"],
  ])("accepts PUBLIC_BASE_URL %s", (value, origin) => {
    expect(loadEnv({ ...valid, ...pub, PUBLIC_BASE_URL: value }).publicApp?.PUBLIC_BASE_URL).toBe(
      origin,
    );
  });

  it.each([
    ["http://marker-host.example.com", "marker-host"],
    ["ftp://marker-ftp.example.com", "marker-ftp"],
    ["not-a-url-marker", "not-a-url-marker"],
    ["https://brain.example.com/marker-path", "marker-path"],
    ["https://brain.example.com/?marker-query=1", "marker-query"],
    ["https://brain.example.com/#marker-frag", "marker-frag"],
    ["https://brain.example.com/?", "brain.example.com/?"],
    ["https://brain.example.com/#", "brain.example.com/#"],
    ["https://marker-user:marker-pass@brain.example.com", "marker-user"],
    ["https://@marker-at.example.com", "marker-at"],
    ["http://localhost.marker.example.com", "marker.example"],
    ["http://localhost.:3001", "localhost."],
    ["http://[::1]:3001", "::1"],
  ])("rejects PUBLIC_BASE_URL %s without echoing it", (value, marker) => {
    expectNamedWithout(
      { ...valid, ...pub, PUBLIC_BASE_URL: value },
      "PUBLIC_BASE_URL",
      marker,
      value,
    );
  });

  it("throws on a missing OWNER_PASSPHRASE_HASH", () => {
    expectNamedWithout({ ...valid, PUBLIC_BASE_URL: pub.PUBLIC_BASE_URL }, "OWNER_PASSPHRASE_HASH");
  });

  it("throws on an empty OWNER_PASSPHRASE_HASH", () => {
    expectNamedWithout({ ...valid, ...pub, OWNER_PASSPHRASE_HASH: "" }, "OWNER_PASSPHRASE_HASH");
  });

  const bad = (parts: {
    n?: string;
    r?: string;
    p?: string;
    s?: string;
    k?: string;
    algo?: string;
  }) =>
    `${parts.algo ?? "scrypt"}$${parts.n ?? "32768"}$${parts.r ?? "8"}$${parts.p ?? "1"}$${parts.s ?? salt}$${parts.k ?? key}`;

  it.each([
    ["N zero", bad({ n: "0" })],
    ["N not a power of two", bad({ n: "30000" })],
    ["N below 2^14", bad({ n: "8192" })],
    ["N above 2^20", bad({ n: "2097152" })],
    ["N with a leading zero", bad({ n: "032768" })],
    ["r zero", bad({ r: "0" })],
    ["r above 32", bad({ r: "33" })],
    ["p zero", bad({ p: "0" })],
    ["p above 16", bad({ p: "17" })],
    ["another algorithm", bad({ algo: "bcrypt" })],
    ["a short salt", bad({ s: salt.slice(0, 21) })],
    ["a long salt", bad({ s: `${salt}A` })],
    ["a short key", bad({ k: key.slice(0, 42) })],
    ["a long key", bad({ k: `${key}A` })],
    ["a non base64url salt", bad({ s: `${salt.slice(0, 21)}+` })],
    ["a missing key", `scrypt$32768$8$1$${salt}`],
    ["a trailing newline", `${goodHash}\n`],
    ["more than 64 MiB of scrypt memory (r 16)", bad({ r: "16" })],
    ["more than 64 MiB of scrypt memory (N 2^20)", bad({ n: "1048576" })],
    ["N not below 2^(16r) (N 2^16, r 1)", bad({ n: "65536", r: "1" })],
  ])("rejects an OWNER_PASSPHRASE_HASH with %s, without echoing it", (_label, hash) => {
    expectNamedWithout(
      { ...valid, ...pub, OWNER_PASSPHRASE_HASH: hash },
      "OWNER_PASSPHRASE_HASH",
      salt,
      key,
      "32768",
    );
  });

  it("exports the pattern and a checker that agree on the good hash", () => {
    expect(PASSPHRASE_HASH_PATTERN.test(goodHash)).toBe(true);
    expect(isPassphraseHashFormat(goodHash)).toBe(true);
    expect(isPassphraseHashFormat(`scrypt$16384$16$16$${salt}$${key}`)).toBe(true);
    expect(isPassphraseHashFormat(`scrypt$32768$1$1$${salt}$${key}`)).toBe(true);
  });

  it("accepts a hash right at the 64 MiB memory budget and refuses the next step", () => {
    // 128 * r * (N + 2 + p): r 15 at N 2^15 is 62,920,320 bytes, r 16 is 67,115,008 (> 64 MiB).
    expect(isPassphraseHashFormat(`scrypt$32768$15$1$${salt}$${key}`)).toBe(true);
    expect(isPassphraseHashFormat(`scrypt$32768$16$1$${salt}$${key}`)).toBe(false);
    expect(scryptMemoryBytes(2 ** 15, 15, 1)).toBe(62_920_320);
    expect(scryptMemoryBytes(2 ** 15, 16, 1)).toBe(67_115_008);
    expect(MAX_SCRYPT_MEMORY).toBe(67_108_864);
  });

  it("applies the OpenSSL rule N < 2^(16r) as a format rule, apart from memory", () => {
    expect(parsePassphraseHashParams(`scrypt$65536$1$1$${salt}$${key}`)).toBeUndefined();
    expect(parsePassphraseHashParams(`scrypt$32768$1$1$${salt}$${key}`)).toEqual({
      n: 32768,
      r: 1,
      p: 1,
    });
    // Well formed but over budget: parsed here, refused by the memory check.
    expect(parsePassphraseHashParams(`scrypt$32768$16$1$${salt}$${key}`)).toEqual({
      n: 32768,
      r: 16,
      p: 1,
    });
    expect(fitsScryptMemory(32768, 16, 1)).toBe(false);
    expect(fitsScryptMemory(32768, 15, 1)).toBe(true);
  });

  it("throws on a non-numeric MCP_PORT without echoing it", () => {
    expectNamedWithout({ ...valid, ...pub, MCP_PORT: "port-marker" }, "MCP_PORT", "port-marker");
  });

  it.each(["70000", "-1", "8e3", "0x10", "80.5"])("throws on MCP_PORT %s", (value) => {
    expectNamedWithout({ ...valid, ...pub, MCP_PORT: value }, "MCP_PORT", value);
  });

  it.each([
    ["2.5", "2.5"],
    ["-3", "-3"],
    ["hops-marker", "hops-marker"],
    ["1e1", "1e1"],
    ["0x2", "0x2"],
  ])("throws on TRUST_PROXY_HOPS %s without echoing it", (value, marker) => {
    expectNamedWithout({ ...valid, ...pub, TRUST_PROXY_HOPS: value }, "TRUST_PROXY_HOPS", marker);
  });

  it("accepts TRUST_PROXY_HOPS 1 and 0", () => {
    expect(loadEnv({ ...valid, ...pub, TRUST_PROXY_HOPS: "1" }).publicApp?.TRUST_PROXY_HOPS).toBe(
      1,
    );
    expect(loadEnv({ ...valid, ...pub, TRUST_PROXY_HOPS: "0" }).publicApp?.TRUST_PROXY_HOPS).toBe(
      0,
    );
  });

  it.each([
    "https://marker.example.com",
    "marker.example.com/path",
    "marker_host.example.com",
    "-marker.example.com",
    "marker-.example.com",
    "marker..example.com",
    ".marker.example.com",
    "marker.example.com.",
    "m\u00fcnchen-marker.example.com",
  ])("throws on ALLOWED_REDIRECT_HOSTS entry %j without echoing it", (value) => {
    expectNamedWithout(
      { ...valid, ...pub, ALLOWED_REDIRECT_HOSTS: `claude.ai,${value}` },
      "ALLOWED_REDIRECT_HOSTS",
      "marker",
      "nchen",
    );
  });

  it("throws on a whitespace-only ALLOWED_REDIRECT_HOSTS", () => {
    expectNamedWithout(
      { ...valid, ...pub, ALLOWED_REDIRECT_HOSTS: " , " },
      "ALLOWED_REDIRECT_HOSTS",
    );
  });

  it("throws on an AUTH_STORE_DIR inside VAULT_DIR, naming both variables only", () => {
    // `..auth` and `...` are folder names, not a step up: they are inside.
    const inside = [
      "/data/vault/auth",
      "/data/vault",
      "/data/vault/../vault/x",
      "/data/vault/..auth",
      "/data/vault/...",
      "/data/vault/..auth/x",
    ];
    for (const dir of inside) {
      expectNamedWithout(
        { ...valid, ...pub, AUTH_STORE_DIR: dir },
        "AUTH_STORE_DIR",
        "/data/vault",
        "/data",
      );
      expect(() => loadEnv({ ...valid, ...pub, AUTH_STORE_DIR: dir })).toThrow(/VAULT_DIR/);
    }
  });

  it("isInside treats only a leading '..' segment as leaving the parent", () => {
    expect(isInside("/data/vault", "/data/vault")).toBe(true);
    expect(isInside("/data/vault/..auth", "/data/vault")).toBe(true);
    expect(isInside("/data/vault/...", "/data/vault")).toBe(true);
    expect(isInside("/data/vault/a/b", "/data/vault")).toBe(true);
    expect(isInside("/data/vault/../x", "/data/vault")).toBe(false);
    expect(isInside("/data", "/data/vault")).toBe(false);
    expect(isInside("/data/vault-auth", "/data/vault")).toBe(false);
    expect(isInside("/other/vault", "/data/vault")).toBe(false);
  });

  it("accepts an AUTH_STORE_DIR beside VAULT_DIR, including a shared name prefix", () => {
    for (const dir of ["/data/auth", "/data/vault-auth", "/data", "/data/..vault"]) {
      expect(loadEnv({ ...valid, ...pub, AUTH_STORE_DIR: dir }).publicApp?.AUTH_STORE_DIR).toBe(
        dir,
      );
    }
  });

  it("resolves relative paths before comparing AUTH_STORE_DIR with VAULT_DIR", () => {
    expectNamedWithout(
      { ...valid, ...pub, VAULT_DIR: "./vault", AUTH_STORE_DIR: "vault/auth" },
      "AUTH_STORE_DIR",
    );
  });

  it("reports base and public problems in one message", () => {
    try {
      loadEnv({
        ...valid,
        ...pub,
        GIT_AUTHOR_EMAIL: "no",
        OWNER_PASSPHRASE_HASH: "x",
        MCP_PORT: "y",
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message.match(/Invalid environment/g)).toHaveLength(1);
      for (const name of ["GIT_AUTHOR_EMAIL", "OWNER_PASSPHRASE_HASH", "MCP_PORT"]) {
        expect(message).toContain(name);
      }
    }
  });
});

describe(".env.example", () => {
  const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  it.each([
    "PUBLIC_BASE_URL",
    "MCP_PORT",
    "OWNER_PASSPHRASE_HASH",
    "ALLOWED_REDIRECT_HOSTS",
    "AUTH_STORE_DIR",
    "TRUST_PROXY_HOPS",
  ])("has a %s= line", (name) => {
    expect(new RegExp(`^${name}=`, "m").test(text)).toBe(true);
  });

  it("leaves PUBLIC_BASE_URL and OWNER_PASSPHRASE_HASH empty, so MCP is off by default", () => {
    expect(text).toMatch(/^PUBLIC_BASE_URL=$/m);
    expect(text).toMatch(/^OWNER_PASSPHRASE_HASH=$/m);
  });

  it("lists every NAME= key exactly once", () => {
    const keys = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    const repeated = keys.filter((key, i) => keys.indexOf(key) !== i);
    expect(repeated).toEqual([]);
  });
});

describe("README.md", () => {
  const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("has exactly one Configuration heading", () => {
    expect(text.match(/^## Configuration$/gm)).toHaveLength(1);
  });
});
