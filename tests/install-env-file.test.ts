import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config/env.js";
import {
  type EnvAnswers,
  generateIngestToken,
  MANAGED_KEYS,
  mergeEnv,
  renderEnv,
} from "../src/install/env-file.js";

// A well-formed hash built at runtime (gitleaks scans every commit).
const salt = Buffer.alloc(16, 7).toString("base64url");
const derived = Buffer.alloc(32, 9).toString("base64url");
const goodHash = `scrypt$32768$8$1$${salt}$${derived}`;
const fixedToken = ["fictional-test-token", "0123456789", "abcdefghij"].join("-");
const tokenRe = /^[A-Za-z0-9_-]{43}$/;

const base: EnvAnswers = {
  vaultRemote: "git@example.com:you/vault.git",
  authorName: "Test Author",
  authorEmail: "author@example.com",
};
const withUrl: EnvAnswers = {
  ...base,
  publicBaseUrl: "https://brain.example.com",
  passphraseHash: goodHash,
};

function render(existing: string, answers: EnvAnswers, make = () => fixedToken): string {
  return renderEnv(existing, mergeEnv(existing, answers, make));
}

describe("env file render", () => {
  it.each([
    ["with a base URL", withUrl],
    ["without a base URL", base],
  ])("passes the startup rules %s", (_name, answers) => {
    const parsed = parseEnv(render("", answers));
    expect(Object.keys(parsed).sort()).toEqual([...MANAGED_KEYS].sort());
    expect(() => loadEnv({ ...parsed, VAULT_DIR: "/data/vault" })).not.toThrow();
  });

  it("defaults hops to 1 with a base URL and 0 without, and the network to n8n", () => {
    expect(mergeEnv("", withUrl, () => fixedToken).TRUST_PROXY_HOPS).toBe("1");
    expect(mergeEnv("", base, () => fixedToken).TRUST_PROXY_HOPS).toBe("0");
    expect(mergeEnv("", { ...withUrl, trustProxyHops: 3 }, () => fixedToken).TRUST_PROXY_HOPS).toBe(
      "3",
    );
    expect(mergeEnv("", base, () => fixedToken).N8N_NETWORK).toBe("n8n");
  });

  it("generates a token when it is missing or empty, and two runs differ", () => {
    for (const text of ["", "INGEST_TOKEN=\n"]) {
      expect(parseEnv(renderEnv(text, mergeEnv(text, base))).INGEST_TOKEN).toMatch(tokenRe);
    }
    expect(generateIngestToken()).toMatch(tokenRe);
    expect(generateIngestToken()).not.toBe(generateIngestToken());
  });

  it("fills an empty INGEST_TOKEN line in place without appending it", () => {
    const out = render("A=1\nINGEST_TOKEN=\nB=2\n", base);
    expect(out.split("\n").slice(0, 3)).toEqual(["A=1", `INGEST_TOKEN=${fixedToken}`, "B=2"]);
    expect(out.match(/^INGEST_TOKEN=/gm)).toHaveLength(1);
  });

  it("keeps an existing token without calling the generator", () => {
    const make = vi.fn(() => "other");
    const text = `INGEST_TOKEN=${fixedToken}\n`;
    expect(parseEnv(render(text, base, make)).INGEST_TOKEN).toBe(fixedToken);
    expect(make).not.toHaveBeenCalled();
  });

  it("keeps existing values for omitted answers and changes only the new key's line", () => {
    const lines = [
      "GIT_AUTHOR_NAME=Old Name",
      "VAULT_REMOTE=git@example.com:a/b.git",
      `OWNER_PASSPHRASE_HASH='${goodHash}'`,
      `INGEST_TOKEN=${fixedToken}`,
      "GIT_AUTHOR_EMAIL=old@example.com",
    ];
    const text = `${lines.join("\n")}\n`;
    const same = render(text, {});
    for (const line of lines) expect(same.split("\n")).toContain(line);
    const next = render(text, { authorEmail: "new@example.com" });
    const out = next.split("\n");
    expect(out.slice(0, 4)).toEqual(lines.slice(0, 4));
    expect(out[4]).toBe("GIT_AUTHOR_EMAIL=new@example.com");
  });

  it("keeps comments, blank lines, unmanaged lines and CRLF byte for byte", () => {
    const head = "# my comment\r\n\r\nFOO=bar\r\nVAULT_REMOTE=x\r\n# tail\r\n";
    const out = render(head, { vaultRemote: "y" });
    expect(out.startsWith("# my comment\r\n\r\nFOO=bar\r\nVAULT_REMOTE=y\r\n# tail\r\n")).toBe(
      true,
    );
  });

  it("appends missing keys once, after the marker, in managed order", () => {
    const out = render("FOO=bar", { ...base, vaultRemote: undefined });
    const lines = out.split("\n");
    const at = lines.indexOf("# Written by 2brain setup");
    expect(lines.slice(0, at)).toEqual(["FOO=bar"]);
    expect(lines.slice(at + 1, -1).map((l) => l.split("=")[0])).toEqual([...MANAGED_KEYS]);
    expect(out.match(/# Written by 2brain setup/g)).toHaveLength(1);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("does not append a marker when every key is present", () => {
    const first = render("", withUrl);
    expect(render(first, {})).toBe(first);
  });

  it("writes the hash in single quotes and it round-trips", () => {
    const out = render("", withUrl);
    expect(out).toContain(`OWNER_PASSPHRASE_HASH='${goodHash}'\n`);
    expect(parseEnv(out).OWNER_PASSPHRASE_HASH).toBe(goodHash);
  });

  it("is deterministic and idempotent", () => {
    const text = "FOO=bar\n";
    const once = render(text, withUrl);
    expect(render(text, withUrl)).toBe(once);
    expect(render(once, withUrl)).toBe(once);
  });

  it("rewrites only the last assignment of a key assigned twice", () => {
    const out = render("GIT_AUTHOR_NAME=First\nX=1\nGIT_AUTHOR_NAME=Second\n", {
      authorName: "Third",
    });
    const lines = out.split("\n");
    expect(lines.slice(0, 3)).toEqual(["GIT_AUTHOR_NAME=First", "X=1", "GIT_AUTHOR_NAME=Third"]);
    expect(parseEnv(out).GIT_AUTHOR_NAME).toBe("Third");
  });

  it("quotes values with spaces in single quotes and apostrophes in double quotes", () => {
    const out = render("", { ...base, authorName: "Ana Maria" });
    expect(out).toContain("GIT_AUTHOR_NAME='Ana Maria'\n");
    const apos = render("", { ...base, authorName: "Ana O'Brien" });
    expect(apos).toContain(`GIT_AUTHOR_NAME="Ana O'Brien"\n`);
    expect(parseEnv(apos).GIT_AUTHOR_NAME).toBe("Ana O'Brien");
  });

  it.each([
    ["apostrophe with dollar", "O'Brien $x"],
    ["apostrophe with double quote", `O'Br"ien`],
    ["apostrophe with backslash", "O'Br\\ien"],
    ["newline", "a\nb"],
    ["carriage return", "a\rb"],
  ])("throws a key-only error for an unwritable value (%s)", (_name, value) => {
    try {
      render("", { ...base, authorName: value });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toBe("GIT_AUTHOR_NAME: value cannot be written to .env");
      expect(message).not.toContain("Brien");
    }
  });
});
