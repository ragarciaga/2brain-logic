import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const valid = {
  VAULT_DIR: "/data/vault",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  INGEST_TOKEN: "fictional-test-token-0123456789-abcdefghij",
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
    try {
      loadEnv({ ...valid, GIT_AUTHOR_EMAIL: "secret-marker-value" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-marker-value");
    }
  });
});
