import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import type { VaultConfig } from "../src/config/vault-config.js";
import { parseNote } from "../src/vault/frontmatter.js";
import {
  appendBody,
  appendedBytes,
  ImmutableBodyError,
  isImmutableBody,
  readStoredNote,
} from "../src/vault/operations.js";

describe("ImmutableBodyError", () => {
  it("has a fixed message and name", () => {
    const error = new ImmutableBodyError();
    expect(error.message).toBe("Note body is immutable");
    expect(error.name).toBe("ImmutableBodyError");
  });
});

describe("appendBody", () => {
  const cases: Array<[string, string, string, string]> = [
    ["empty text", "Body\n", "", "Body\n"],
    ["empty body", "", "new", "new"],
    ["body ending in a blank line (LF)", "Body\n\n", "new", "Body\n\nnew"],
    ["body ending in a blank line (CRLF)", "Body\r\n\r\n", "new", "Body\r\n\r\nnew"],
    ["body ending in CRLF", "Body\r\n", "new", "Body\r\n\r\nnew"],
    ["body ending in LF", "Body\n", "new", "Body\n\nnew"],
    ["body without a final newline", "Body", "new", "Body\n\nnew"],
  ];
  it.each(cases)("%s", (_name, body, text, expected) => {
    const result = appendBody(body, text);
    expect(result).toBe(expected);
    expect(result.startsWith(body)).toBe(true);
  });
});

describe("appendedBytes", () => {
  it("keeps the original bytes of a hand-formatted note as a prefix", () => {
    const original = Buffer.from("---\n# keep me\ntype:   idea\n---\nBody\n");
    const stored = readStoredNote(original);
    if (stored === undefined) throw new Error("fixture must parse");
    const result = appendedBytes(original, stored, appendBody(stored.body, "new"));
    expect(result.subarray(0, original.length).equals(original)).toBe(true);
    expect(result.toString("utf8")).toBe("---\n# keep me\ntype:   idea\n---\nBody\n\nnew");
  });

  it("falls back to a re-assembled note when the fence has no newline after it", () => {
    const original = Buffer.from("---\ntype: idea\n---");
    const stored = readStoredNote(original);
    if (stored === undefined) throw new Error("fixture must parse");
    const result = appendedBytes(original, stored, "new");
    expect(readStoredNote(result)?.body).toBe("new");
    expect(result.toString("utf8")).toContain("\n---\n");
  });

  it("falls back for an unclosed fence", () => {
    const original = Buffer.from("---\ntype: idea\n");
    const stored = readStoredNote(original);
    if (stored === undefined) throw new Error("fixture must parse");
    const result = appendedBytes(original, stored, "new");
    expect(readStoredNote(result)?.body).toBe("new");
    expect(parseNote(result.toString("utf8")).data).toEqual({ type: "idea" });
  });

  it("returns the same buffer when the body is unchanged", () => {
    const original = Buffer.from("---\ntype: idea\n---\nBody\n");
    const stored = readStoredNote(original);
    if (stored === undefined) throw new Error("fixture must parse");
    expect(appendedBytes(original, stored, stored.body)).toBe(original);
  });
});

describe("isImmutableBody", () => {
  const owner: VaultConfig = {
    ...DEFAULT_VAULT_CONFIG,
    properties: { ...DEFAULT_VAULT_CONFIG.properties, type: "kind" },
    types: {
      meeting: { value: "call", folder: "{area}/calls", immutable_body: true },
      note: { value: "meeting", folder: "inbox" },
      plain: { value: "plain", folder: "inbox" },
    },
  };

  it("reads the owner's property name and value", () => {
    expect(isImmutableBody({ kind: "call" }, owner)).toBe(true);
  });

  it("is false for the type key name used as a value, and for a mutable entry", () => {
    expect(isImmutableBody({ kind: "meeting" }, owner)).toBe(false);
    expect(isImmutableBody({ type: "call" }, owner)).toBe(false);
  });

  it("is false for a missing type, a non-string type and a prototype name", () => {
    expect(isImmutableBody({}, owner)).toBe(false);
    expect(isImmutableBody({ kind: 5 }, owner)).toBe(false);
    expect(isImmutableBody({ kind: "constructor" }, owner)).toBe(false);
  });

  it("is false for an entry without immutable_body", () => {
    expect(isImmutableBody({ kind: "plain" }, owner)).toBe(false);
  });

  it("is true for the default meeting type", () => {
    expect(isImmutableBody({ type: "meeting" }, DEFAULT_VAULT_CONFIG)).toBe(true);
  });
});
