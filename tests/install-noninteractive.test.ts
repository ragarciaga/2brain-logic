import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Real hashing unless a test turns the switch on.
const hashSwitch = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/auth/owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/owner.js")>();
  return {
    ...actual,
    hashPassphrase: (passphrase: string) =>
      hashSwitch.fail
        ? Promise.reject(new Error(`scrypt exploded on ${passphrase}`))
        : actual.hashPassphrase(passphrase),
  };
});

import { type NonInteractiveResult, readNonInteractive } from "../src/install/prompt.js";

const REMOTE = "git@example.com:you/vault.git";
const PASS = ["correct", "horse", "battery", "staple"].join("-");
const FP = `SHA256:${"A".repeat(43)}`;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const core = [
  "--remote",
  REMOTE,
  "--author-name",
  "Ana Perez",
  "--author-email",
  "ana@example.com",
];

function spy(bytes: Uint8Array = enc(`${PASS}\n`)) {
  return vi.fn(async () => bytes);
}

function fail(r: NonInteractiveResult) {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

/** True when the text holds any 4-character substring of the value. */
function leaks(text: string, value: string): boolean {
  for (let i = 0; i + 4 <= value.length; i++) {
    if (text.includes(value.slice(i, i + 4))) return true;
  }
  return false;
}

describe("readNonInteractive success", () => {
  it("maps full answers with a base URL and stores only the hash", async () => {
    const stdin = spy();
    const r = await readNonInteractive(
      [
        ...core,
        "--public-base-url",
        "https://brain.example.com",
        "--passphrase-stdin",
        "--host-fingerprint",
        FP,
        "--project-dir",
        "p",
        "--vault-dir",
        "v",
        "--non-interactive",
      ],
      stdin,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.passphraseHash).toMatch(/^scrypt\$/);
    expect(r.answers.keepPassphrase).toBe(false);
    expect(r.answers.trustProxyHops).toBe(1);
    expect(r.answers.n8nNetwork).toBe("n8n");
    expect(r.answers.hostFingerprint).toBe(FP);
    expect(r.answers.projectDir).toBe("p");
    expect(r.answers.vaultDir).toBe("v");
    expect(stdin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain(PASS);
  });
  it("defaults hops to 0 without a base URL and ignores passphrase flags", async () => {
    const stdin = spy();
    const r = await readNonInteractive(
      [...core, "--public-base-url", "", "--passphrase-stdin"],
      stdin,
    );
    expect(r.ok && r.answers.trustProxyHops).toBe(0);
    expect(r.ok && r.answers.passphraseHash).toBeUndefined();
    expect(stdin).not.toHaveBeenCalled();
  });
  it("keeps the passphrase without reading stdin", async () => {
    const stdin = spy();
    const r = await readNonInteractive(
      [...core, "--public-base-url", "https://brain.example.com", "--keep-passphrase"],
      stdin,
    );
    expect(r.ok && r.answers.keepPassphrase).toBe(true);
    expect(r.ok && r.answers.passphraseHash).toBeUndefined();
    expect(stdin).not.toHaveBeenCalled();
  });
  it("accepts a CRLF-terminated passphrase", async () => {
    const r = await readNonInteractive(
      [...core, "--public-base-url", "https://brain.example.com", "--passphrase-stdin"],
      spy(enc(`${PASS}\r\n`)),
    );
    expect(r.ok).toBe(true);
  });
});

describe("readNonInteractive missing answers", () => {
  it("names remote and author-email, not author-name", async () => {
    const r = fail(await readNonInteractive(["--author-name", "Ana"], spy()));
    expect(r).toMatchObject({ code: "missing_answers", exitCode: 2 });
    expect(r.fields).toEqual(["remote", "author-email"]);
  });
  it("names the passphrase when a base URL has no passphrase flag", async () => {
    const r = fail(
      await readNonInteractive([...core, "--public-base-url", "https://brain.example.com"], spy()),
    );
    expect(r).toMatchObject({ code: "missing_answers", exitCode: 2, fields: ["passphrase"] });
  });
});

describe("readNonInteractive usage", () => {
  const cases: [string, string[]][] = [
    ["--passphrase x", ["--passphrase", "x"]],
    ["--passphrase=x", ["--passphrase=x"]],
    ["unknown flag", ["--foo"]],
    ["positional", ["stray"]],
    ["repeated --remote", ["--remote", REMOTE, "--remote", REMOTE]],
    ["both passphrase flags", ["--passphrase-stdin", "--keep-passphrase"]],
    ["missing value", ["--remote"]],
  ];
  it.each(cases)("%s is usage, exit 2, no fields, no stdin", async (_n, extra) => {
    const stdin = spy();
    const r = fail(await readNonInteractive(extra, stdin));
    expect(r).toMatchObject({ code: "usage", exitCode: 2, fields: [] });
    expect(stdin).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('x"');
  });
  it("does not echo the passphrase passed as a flag", async () => {
    const r = fail(await readNonInteractive(["--passphrase", PASS], spy()));
    expect(JSON.stringify(r)).not.toContain(PASS);
  });
});

describe("readNonInteractive invalid answers", () => {
  it("bad email: exit 1, field and rule, no value", async () => {
    const stdin = spy();
    const bad = "not-an-email-value";
    const r = fail(
      await readNonInteractive(
        [
          "--remote",
          REMOTE,
          "--author-name",
          "Ana",
          "--author-email",
          bad,
          "--public-base-url",
          "https://brain.example.com",
          "--passphrase-stdin",
        ],
        stdin,
      ),
    );
    expect(r).toMatchObject({
      code: "invalid_answer",
      exitCode: 1,
      fields: ["author-email"],
      rule: "must be an email address",
    });
    expect(JSON.stringify(r)).not.toContain(bad);
    expect(stdin).not.toHaveBeenCalled();
  });
  const withFlag = (flag: string, value: string): string[] => [
    ...core,
    flag,
    value,
    "--public-base-url",
    "https://brain.example.com",
    "--passphrase-stdin",
  ];
  it.each([
    ["trust-proxy-hops", "11"],
    ["n8n-network", "_bad"],
    ["host-fingerprint", "SHA256:short"],
    ["public-base-url", "http://brain.example.com"],
  ])("bad %s is invalid_answer with no stdin read", async (flag, value) => {
    const stdin = spy();
    const argv =
      flag === "public-base-url"
        ? [...core, `--${flag}`, value, "--passphrase-stdin"]
        : withFlag(`--${flag}`, value);
    const r = fail(await readNonInteractive(argv, stdin));
    expect(r).toMatchObject({ code: "invalid_answer", exitCode: 1, fields: [flag] });
    expect(r.rule).toBeTruthy();
    expect(stdin).not.toHaveBeenCalled();
  });
  it("author name with a backslash is invalid", async () => {
    const stdin = spy();
    const r = fail(
      await readNonInteractive(
        ["--remote", REMOTE, "--author-name", "a\\b", "--author-email", "a@example.com"],
        stdin,
      ),
    );
    expect(r).toMatchObject({ code: "invalid_answer", fields: ["author-name"] });
  });
});

describe("readNonInteractive remote", () => {
  it.each([
    "https://example.com/x.git",
    ["ssh://user", "secret@host/x.git"].join(":"),
    "git@example.com:you/va​ult.git",
  ])("refuses %s without leaking it or reading stdin", async (remote) => {
    const stdin = spy();
    const r = fail(
      await readNonInteractive(
        [
          "--remote",
          remote,
          "--author-name",
          "Ana",
          "--author-email",
          "a@example.com",
          "--public-base-url",
          "https://brain.example.com",
          "--passphrase-stdin",
        ],
        stdin,
      ),
    );
    expect(r).toMatchObject({ code: "remote_not_ssh", exitCode: 1, fields: ["remote"] });
    expect(leaks(JSON.stringify(r), remote)).toBe(false);
    expect(stdin).not.toHaveBeenCalled();
  });
});

describe("readNonInteractive stdin", () => {
  const argv = [...core, "--public-base-url", "https://brain.example.com", "--passphrase-stdin"];
  it.each([
    ["short", enc("short\n")],
    ["two lines", enc(`${PASS}\n${PASS}\n`)],
    ["over 1024 bytes", enc("a".repeat(1025))],
    [
      "invalid UTF-8",
      new Uint8Array([
        0xff, 0xfe, 0xfd, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61,
      ]),
    ],
  ])("%s is invalid_answer passphrase", async (_n, bytes) => {
    const r = fail(await readNonInteractive(argv, spy(bytes)));
    expect(r).toMatchObject({ code: "invalid_answer", exitCode: 1, fields: ["passphrase"] });
    expect(JSON.stringify(r)).not.toContain("short");
  });
});

describe("readNonInteractive scope", () => {
  it("prompt.ts imports no file or process API", () => {
    const src = readFileSync(new URL("../src/install/prompt.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "node:fs/);
    expect(src).not.toMatch(/env-file/);
    expect(src).not.toMatch(/node:child_process/);
  });
});

describe("readNonInteractive hash failure", () => {
  const url = ["--public-base-url", "https://brain.example.com", "--passphrase-stdin"];

  it("gives its own rule when scrypt fails on a long enough passphrase", async () => {
    hashSwitch.fail = true;
    try {
      const r = fail(await readNonInteractive([...core, ...url], spy()));
      expect(r).toMatchObject({ code: "invalid_answer", exitCode: 1, fields: ["passphrase"] });
      expect(r.rule).toBe("could not be hashed on this machine");
      expect(JSON.stringify(r)).not.toContain("exploded");
    } finally {
      hashSwitch.fail = false;
    }
  });

  it("keeps the length rule for a short passphrase", async () => {
    hashSwitch.fail = true;
    try {
      const r = fail(await readNonInteractive([...core, ...url], spy(enc("short\n"))));
      expect(r.rule).toBe("must be 12 characters or more");
    } finally {
      hashSwitch.fail = false;
    }
  });
});
