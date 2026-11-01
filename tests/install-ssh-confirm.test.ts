import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptTerminal } from "../src/install/prompt.js";
import {
  type CaptureResult,
  type CaptureRunner,
  pinConfirmedHostKey,
  scanHostKey,
} from "../src/install/ssh.js";

const POSIX = process.platform !== "win32";
// Public host-key fixtures, built from parts so secret scanners do not flag them.
const BLOB_PARTS = [
  "AAAAC3NzaC1lZDI1NTE5",
  "AAAAIPf657c3skhATaBY",
  "1yz3T67YMlz9oZ11",
  "+O+BHRuvh/7",
];
const KEY = `${BLOB_PARTS.join("")}S`;
const KEY2 = `${BLOB_PARTS.join("")}T`;
const FP = "SHA256:bDMUpweNPl+hOqU4AGZf/z5+8DYODm3qVd80rpVtei4";
const HOST = "git.example.com";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-confirm-test-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const knownHosts = () => join(dir, "known_hosts");
const scanText = (...keys: string[]) => keys.map((k) => `${HOST} ssh-ed25519 ${k}\n`).join("");

type Call = { cmd: string; args: string[]; opts: { timeoutMs: number } };
function fakeRunner(
  result: CaptureResult | (() => Promise<CaptureResult>),
): CaptureRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof result === "function" ? result() : result;
  }) as CaptureRunner & { calls: Call[] };
  run.calls = calls;
  return run;
}
const okRunner = (...keys: string[]) => fakeRunner({ code: 0, stdout: scanText(...keys) });

function scriptedTerm(inputs: Array<string | null>): PromptTerminal & { out: string[] } {
  const out: string[] = [];
  const queue = [...inputs];
  return {
    out,
    write: (t: string) => {
      out.push(t);
    },
    read: async () => (queue.length > 0 ? (queue.shift() as string | null) : null),
    setRawMode: () => {},
    isTTY: true,
  };
}

describe("scanHostKey", () => {
  it("runner args", async () => {
    const run = okRunner(KEY);
    await scanHostKey({ host: HOST, port: 2222 }, run);
    expect(run.calls).toEqual([
      {
        cmd: "ssh-keyscan",
        args: ["-t", "ed25519", "-p", "2222", HOST],
        opts: { timeoutMs: 10000 },
      },
    ]);
    const run22 = okRunner(KEY);
    await scanHostKey({ host: HOST, port: 22 }, run22);
    expect(run22.calls[0]?.args).toEqual(["-t", "ed25519", "-p", "22", HOST]);
  });

  it("times out after 10 s with a fix line and no file", async () => {
    vi.useFakeTimers();
    const run = fakeRunner(() => new Promise<CaptureResult>(() => {}));
    let settled = false;
    const p = pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { expected: FP }, run).then(
      (r) => {
        settled = true;
        return r;
      },
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("host_unreachable");
      expect(r.message).toContain("Fix:");
    }
    expect(existsSync(knownHosts())).toBe(false);
  });
});

describe("pinConfirmedHostKey", () => {
  it("typed yes pins one line at 0600", async () => {
    const term = scriptedTerm(["yes\n"]);
    const r = await pinConfirmedHostKey(dir, { host: HOST, port: 2222 }, { term }, okRunner(KEY));
    expect(r).toEqual({
      ok: true,
      line: `[${HOST}]:2222 ssh-ed25519 ${KEY}`,
      fingerprint: FP,
    });
    expect(term.out.join("")).toContain(FP);
    expect(readFileSync(knownHosts(), "utf8")).toBe(`[${HOST}]:2222 ssh-ed25519 ${KEY}\n`);
    if (POSIX) {
      expect(statSync(knownHosts()).mode & 0o777).toBe(0o600);
    }
  });

  it("yes split across chunks and with CRLF pins", async () => {
    const term = scriptedTerm(["ye", "s\r\n"]);
    const r = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { term }, okRunner(KEY));
    expect(r.ok).toBe(true);
  });

  it.each([["y\n"], ["no\n"], ["\n"], ["Yes\n"], [" yes\n"], ["yes \n"], [null]])(
    "answer %j rejects with no known_hosts",
    async (answer) => {
      const term = scriptedTerm([answer]);
      const r = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { term }, okRunner(KEY));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("host_key_rejected");
      }
      expect(existsSync(knownHosts())).toBe(false);
    },
  );

  it("non-interactive: equal fingerprint pins, runner is called", async () => {
    const run = okRunner(KEY);
    const r = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { expected: FP }, run);
    expect(r.ok).toBe(true);
    expect(run.calls).toHaveLength(1);
    expect(readFileSync(knownHosts(), "utf8")).toBe(`${HOST} ssh-ed25519 ${KEY}\n`);
  });

  it("non-interactive: a different or missing fingerprint rejects", async () => {
    for (const expected of [`SHA256:${"A".repeat(43)}`, undefined, "", FP.toLowerCase()]) {
      const r = await pinConfirmedHostKey(
        dir,
        { host: HOST, port: 22 },
        { expected },
        okRunner(KEY),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("host_key_rejected");
      }
      expect(existsSync(knownHosts())).toBe(false);
    }
  });

  it("unreachable cases", async () => {
    const cases: CaptureRunner[] = [
      fakeRunner({ code: 1, stdout: scanText(KEY) }),
      fakeRunner({ code: 0, stdout: "" }),
      fakeRunner({ code: 0, stdout: `${HOST} ssh-rsa ${KEY}\n` }),
      fakeRunner({ code: 0, stdout: `${HOST} ssh-ed25519 not*base64\n` }),
      fakeRunner(() => Promise.reject(new Error("boom"))),
    ];
    for (const run of cases) {
      const term = scriptedTerm(["yes\n"]);
      const r = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { term }, run);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("host_unreachable");
        expect(r.message).toContain("Fix:");
      }
      expect(term.out).toEqual([]);
      expect(existsSync(knownHosts())).toBe(false);
    }
  });

  it("two distinct keys reject without a prompt", async () => {
    const term = scriptedTerm(["yes\n"]);
    const r = await pinConfirmedHostKey(
      dir,
      { host: HOST, port: 22 },
      { term },
      okRunner(KEY, KEY2),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("host_key_rejected");
    }
    expect(term.out).toEqual([]);
    expect(existsSync(knownHosts())).toBe(false);
  });

  it("the same key twice is one key", async () => {
    const r = await pinConfirmedHostKey(
      dir,
      { host: HOST, port: 22 },
      { expected: FP },
      okRunner(KEY, KEY),
    );
    expect(r.ok).toBe(true);
  });

  it("github.com is refused", async () => {
    const run = okRunner(KEY);
    await expect(
      pinConfirmedHostKey(dir, { host: "github.com", port: 22 }, { expected: FP }, run),
    ).rejects.toThrow();
    expect(run.calls).toEqual([]);
  });

  it("messages never echo the typed answer or the expected value", async () => {
    const typed = "typedsecretanswer";
    const term = scriptedTerm([`${typed}\n`]);
    const a = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { term }, okRunner(KEY));
    const expected = `SHA256:${"B".repeat(43)}`;
    const b = await pinConfirmedHostKey(dir, { host: HOST, port: 22 }, { expected }, okRunner(KEY));
    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toContain(typed);
        expect(r.message).not.toContain(expected);
        expect(r.message).not.toContain(FP);
      }
    }
  });
});
