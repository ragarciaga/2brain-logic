import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { verifyPassphrase } from "../src/auth/owner.js";
import {
  askSetupAnswers,
  type CurrentValues,
  createStreamTerminal,
  displayValue,
  PromptAbort,
  type PromptTerminal,
  readHidden,
} from "../src/install/prompt.js";

const PASS = "zqxj kkvv wwpp 1234";
const REMOTE = "git@github.com:owner/vault.git";

type Scripted = PromptTerminal & {
  writes: string[];
  raw: boolean[];
  text(): string;
};

/** A terminal that replays chunks, then reports end of input (or throws when `failAt` is hit). */
function scripted(chunks: string[], opts: { isTTY?: boolean; throwAfter?: number } = {}): Scripted {
  const queue = [...chunks];
  let reads = 0;
  const term: Scripted = {
    writes: [],
    raw: [],
    isTTY: opts.isTTY ?? true,
    write(text) {
      term.writes.push(text);
    },
    read() {
      reads++;
      if (opts.throwAfter !== undefined && reads > opts.throwAfter) {
        return Promise.reject(new Error("read failed"));
      }
      const next = queue.shift();
      return Promise.resolve(next === undefined ? null : next);
    },
    setRawMode(on) {
      term.raw.push(on);
    },
    text: () => term.writes.join(""),
  };
  return term;
}

const FRESH: CurrentValues = { hasPassphraseHash: false };

function lines(...answers: string[]): string[] {
  return answers.map((a) => `${a}\n`);
}

const URL_OK = "https://brain.example.com";

describe("prompt order", () => {
  it("asks in order, with the keep prompt only when a hash exists", async () => {
    const withHash = scripted([
      ...lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "2", "n"),
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines("net1"),
    ]);
    const a = await askSetupAnswers(withHash, { hasPassphraseHash: true });
    const prompts = withHash.writes.filter((w) => w.includes(": "));
    expect(prompts.map((p) => p.replace(/ \[.*$/, "").replace(/: $/, ""))).toEqual([
      "vault remote",
      "author name",
      "author email",
      "public base URL",
      "proxy hop count",
      "Keep the current passphrase?",
      "passphrase",
      "passphrase repeat",
      "Docker network name",
    ]);
    expect(a.trustProxyHops).toBe(2);
    expect(a.n8nNetwork).toBe("net1");

    const noHash = scripted([
      ...lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "1"),
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines(""),
    ]);
    await askSetupAnswers(noHash, FRESH);
    expect(noHash.text()).not.toContain("Keep the current passphrase");
  });

  it("an empty base URL skips the hop count and the passphrase", async () => {
    const term = scripted([...lines(REMOTE, "Ana Perez", "ana@example.com", "", "")]);
    const a = await askSetupAnswers(term, { hasPassphraseHash: true });
    expect(a.publicBaseUrl).toBe("");
    expect(a.trustProxyHops).toBeUndefined();
    expect(a.passphraseHash).toBeUndefined();
    expect(term.text()).not.toContain("proxy hop count");
    expect(term.text()).not.toContain("passphrase");
    expect(term.raw).toEqual([]);
  });

  it("shows the current or default value in brackets, and a dash clears the base URL", async () => {
    const term = scripted(lines("", "", "", "-", ""));
    const a = await askSetupAnswers(term, {
      hasPassphraseHash: false,
      remote: REMOTE,
      authorName: "Ana Perez",
      authorEmail: "ana@example.com",
      publicBaseUrl: URL_OK,
    });
    expect(a).toMatchObject({
      remote: REMOTE,
      authorName: "Ana Perez",
      authorEmail: "ana@example.com",
      publicBaseUrl: "",
      n8nNetwork: "n8n",
    });
    expect(term.text()).toContain(`vault remote [${REMOTE}]: `);
    expect(term.text()).toContain(`public base URL [${URL_OK}]: `);
    expect(term.text()).toContain("Docker network name [n8n]: ");
  });

  it("defaults the hop count to 1 and keeps the current passphrase on Enter", async () => {
    const term = scripted(lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "", "", ""));
    const a = await askSetupAnswers(term, { hasPassphraseHash: true });
    expect(term.text()).toContain("proxy hop count [1]: ");
    expect(a.trustProxyHops).toBe(1);
    expect(a.keepPassphrase).toBe(true);
    expect(a.passphraseHash).toBeUndefined();
  });
});

describe("hidden passphrase", () => {
  it("never echoes the passphrase, toggles raw mode and returns only the hash", async () => {
    const term = scripted([
      ...lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "1"),
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines("n8n"),
    ]);
    const a = await askSetupAnswers(term, FRESH);
    for (const fragment of ["zqxj", "kkvv", "wwpp", "1234"]) {
      expect(term.text()).not.toContain(fragment);
    }
    expect(term.raw).toEqual([true, false, true, false]);
    expect(a.passphraseHash).toBeDefined();
    expect(await verifyPassphrase(PASS, a.passphraseHash as string)).toBe(true);
    expect(JSON.stringify(a)).not.toContain("zqxj");
  });

  it("handles backspace, escape sequences, control characters and split chunks", async () => {
    const term = scripted(["ab\u007fPASS", "\u001b[A\u0001", "xyz\r", "rest\n"]);
    const out = await readHidden(term, "passphrase: ");
    expect(out).toBe("aPASSxyz");
    expect(term.text()).toBe("passphrase: \n");
  });

  it("restores raw mode on Ctrl-C", async () => {
    const term = scripted(["abc\u0003"]);
    await expect(readHidden(term, "p: ")).rejects.toMatchObject({ code: "interrupted" });
    expect(term.raw).toEqual([true, false]);
  });

  it("restores raw mode on Ctrl-D and on end of input mid-entry", async () => {
    const d = scripted(["abc\u0004"]);
    await expect(readHidden(d, "p: ")).rejects.toMatchObject({ code: "input_closed" });
    expect(d.raw.at(-1)).toBe(false);
    const eof = scripted(["abc"]);
    await expect(readHidden(eof, "p: ")).rejects.toMatchObject({ code: "input_closed" });
    expect(eof.raw).toEqual([true, false]);
  });

  it("restores raw mode when read throws", async () => {
    const term = scripted(["abc"], { throwAfter: 1 });
    await expect(readHidden(term, "p: ")).rejects.toThrow("read failed");
    expect(term.raw).toEqual([true, false]);
  });

  it("refuses a terminal that is not a TTY without touching raw mode", async () => {
    const term = scripted(["abc\r"], { isTTY: false });
    await expect(readHidden(term, "p: ")).rejects.toMatchObject({ code: "not_a_terminal" });
    expect(term.raw).toEqual([]);
    expect(term.writes).toEqual([]);
  });
});

describe("re-asking", () => {
  const head = lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "1");

  it("asks again on a mismatch without echoing either entry", async () => {
    const first = "mismatch-one-zqxj";
    const second = "mismatch-two-kkvv";
    const term = scripted([
      ...head,
      `${first}\r`,
      `${second}\r`,
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines("n8n"),
    ]);
    const a = await askSetupAnswers(term, FRESH);
    expect(term.text()).toContain("passphrase repeat: must match the first entry\n");
    expect(term.text()).not.toContain("zqxj");
    expect(term.text()).not.toContain("kkvv");
    expect(a.passphraseHash).toBeDefined();
  });

  it("asks again on 11 characters and on 6 emoji (12 UTF-16 units)", async () => {
    const term = scripted([
      ...head,
      "elevenchars\r",
      "elevenchars\r",
      "😀😀😀😀😀😀\r",
      "😀😀😀😀😀😀\r",
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines("n8n"),
    ]);
    await askSetupAnswers(term, FRESH);
    const count = term.writes.filter((w) => w === "passphrase: must be 12 characters or more\n");
    expect(count).toHaveLength(2);
    expect(term.text()).not.toContain("eleven");
    expect(term.text()).not.toContain("😀");
  });

  it("asks again on an invalid email naming the field, without the value", async () => {
    const term = scripted([
      ...lines(REMOTE, "Ana Perez", "zqxjkkvv-not-mail", "ana@example.com", "", ""),
    ]);
    await askSetupAnswers(term, FRESH);
    expect(term.text()).toContain("author email: must be an email address\n");
    expect(term.text()).not.toContain("zqxjkkvv");
  });

  it("asks again on a bad base URL, hop count and network", async () => {
    const term = scripted([
      ...lines(
        REMOTE,
        "Ana Perez",
        "ana@example.com",
        "http://zqxj.example.com",
        URL_OK,
        "99",
        "3",
      ),
      `${PASS}\r`,
      `${PASS}\r`,
      ...lines("-bad kkvv", "ok-net"),
    ]);
    const a = await askSetupAnswers(term, FRESH);
    const text = term.text();
    expect(text).toContain("public base URL: ");
    expect(text).toContain("proxy hop count: must be a whole number from 0 to 10\n");
    expect(text).toContain("Docker network name: ");
    expect(text).not.toContain("zqxj");
    expect(text).not.toContain("kkvv");
    expect(a.n8nNetwork).toBe("ok-net");
  });

  it("asks again on an author name that cannot be written to .env", async () => {
    const term = scripted(lines(REMOTE, `O'Brien $zqxj`, "Ana Perez", "ana@example.com", "", ""));
    const a = await askSetupAnswers(term, FRESH);
    expect(term.text()).toContain("author name: cannot be stored in the .env file");
    expect(term.text()).not.toContain("zqxj");
    expect(a.authorName).toBe("Ana Perez");
  });

  it("refuses an https remote with remote_not_ssh, then accepts an SSH one", async () => {
    const term = scripted(
      lines("https://github.com/owner/vault.git", REMOTE, "Ana Perez", "ana@example.com", "", ""),
    );
    const a = await askSetupAnswers(term, FRESH);
    expect(term.text()).toContain(
      "vault remote: remote_not_ssh: use git@host:owner/repo.git or ssh://user@host[:port]/path\n",
    );
    expect(term.text()).not.toContain("https://github.com");
    expect(a.remote).toBe(REMOTE);
  });

  it("refuses a keep answer that is not y or n", async () => {
    const term = scripted([
      ...lines(REMOTE, "Ana Perez", "ana@example.com", URL_OK, "1", "maybe", "y", "n8n"),
    ]);
    const a = await askSetupAnswers(term, { hasPassphraseHash: true });
    expect(term.text()).toContain("passphrase: answer y or n\n");
    expect(a.keepPassphrase).toBe(true);
  });
});

describe("safe display", () => {
  it("does not show a remote with bidi, zero-width or credentials", () => {
    expect(displayValue("remote", "git@github.com:owner/vault.git")).toBe(
      "git@github.com:owner/vault.git",
    );
    expect(displayValue("remote", "git@host:own‮er/x.git")).toBe("");
    expect(displayValue("remote", "git@host:own​er/x.git")).toBe("");
    expect(displayValue("remote", "https://user:tok@host/x.git")).toBe("");
    expect(displayValue("remote", "")).toBe("");
  });

  it("escapes control, bidi and zero-width characters in other values", () => {
    expect(displayValue("other", "Ana‮")).toBe("Ana\\u{202E}");
    expect(displayValue("other", "a​b﻿c\u0001d\u0085e؜f⁦g")).toBe(
      "a\\u{200B}b\\u{FEFF}c\\u{0001}d\\u{0085}e\\u{061C}f\\u{2066}g",
    );
    expect(displayValue("other", "Ana Pérez")).toBe("Ana Pérez");
  });

  it("does not show a hidden current remote and does not take it as a default", async () => {
    const term = scripted(lines("", REMOTE, "Ana Perez", "ana@example.com", "", ""));
    const a = await askSetupAnswers(term, { hasPassphraseHash: false, remote: "git@h:o‮x" });
    expect(term.text()).toContain("vault remote []: ");
    expect(term.text()).not.toContain("‮");
    expect(a.remote).toBe(REMOTE);
  });

  it("shows a name with a bidi character escaped", async () => {
    const term = scripted(lines(REMOTE, "", "ana@example.com", "", ""));
    await askSetupAnswers(term, { hasPassphraseHash: false, authorName: "Ana‮" });
    expect(term.text()).toContain("author name [Ana\\u{202E}]: ");
    expect(term.text()).not.toContain("‮");
  });

  it("refuses a typed remote with a zero-width character", async () => {
    const term = scripted(
      lines("git@github.com:owner/va​ult.git", REMOTE, "Ana Perez", "ana@example.com", "", ""),
    );
    await askSetupAnswers(term, FRESH);
    expect(term.text()).toContain("vault remote: remote_not_ssh");
  });
});

describe("closed input", () => {
  it("rejects input_closed at a line prompt and does not loop", async () => {
    const term = scripted([]);
    const err = await askSetupAnswers(term, FRESH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromptAbort);
    expect((err as PromptAbort).code).toBe("input_closed");
    expect(term.writes).toHaveLength(1);
  });

  it("rejects input_closed when the input ends mid-way", async () => {
    const term = scripted(lines(REMOTE, "Ana"));
    await expect(askSetupAnswers(term, FRESH)).rejects.toMatchObject({ code: "input_closed" });
  });
});

describe("createStreamTerminal", () => {
  it("delivers chunks, then null at the end, and maps setRawMode", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (on: boolean) => void;
    };
    const calls: boolean[] = [];
    input.isTTY = true;
    input.setRawMode = (on) => {
      calls.push(on);
    };
    const out = new PassThrough();
    const term = createStreamTerminal(input, out);
    expect(term.isTTY).toBe(true);
    input.write("one\n");
    const pending = term.read();
    expect(await pending).toBe("one\n");
    const waiting = term.read();
    input.write("two\n");
    expect(await waiting).toBe("two\n");
    term.setRawMode(true);
    term.setRawMode(false);
    expect(calls).toEqual([true, false]);
    term.write("hi");
    expect(out.read()?.toString()).toBe("hi");
    input.end();
    expect(await term.read()).toBeNull();
    expect(await term.read()).toBeNull();
  });

  it("is not a TTY for a plain stream", () => {
    const term = createStreamTerminal(new PassThrough(), new PassThrough());
    expect(term.isTTY).toBe(false);
    expect(() => term.setRawMode(true)).not.toThrow();
  });
});
