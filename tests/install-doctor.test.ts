import { describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  type CheckId,
  type CheckOutcome,
  type DoctorCheck,
  PUBLIC_CHECK_IDS,
  redactSecrets,
  runDoctor,
  SKIP_NOTE,
  UNEXPECTED_FIX,
} from "../src/install/doctor.js";

type Behavior = CheckOutcome | Error;

function stub(id: CheckId, behavior: Behavior = { status: "pass" }) {
  const calls = { count: 0 };
  const check: DoctorCheck = {
    id,
    async run() {
      calls.count += 1;
      if (behavior instanceof Error) throw behavior;
      return behavior;
    },
  };
  return { check, calls };
}

function registry(overrides: Partial<Record<CheckId, Behavior>> = {}) {
  const stubs = new Map(CHECK_IDS.map((id) => [id, stub(id, overrides[id])] as const));
  return { stubs, checks: [...stubs.values()].map((s) => s.check) };
}

const BASE = { PUBLIC_BASE_URL: "https://brain.example.com" };

async function run(checks: DoctorCheck[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const code = await runDoctor(checks, { env, out: (l) => out.push(l) });
  return { out, code };
}

// Secret-shaped values built from parts so the scanners do not flag the source.
const TOKEN = ["tok", "A".repeat(20), "b".repeat(20)].join("");
const HASH = ["scrypt", "$", "n=16384", "$", "c2FsdA", "$", "aGFzaA"].join("");
const REMOTE = ["ssh", "://", "user", ":", "pass", "@", "git.example.com/x.git"].join("");
const SECRET_ENV = {
  ...BASE,
  INGEST_TOKEN: TOKEN,
  OWNER_PASSPHRASE_HASH: HASH,
  VAULT_REMOTE: REMOTE,
};

describe("runDoctor", () => {
  it("runs the checks in R4.1 order whatever order they are passed", async () => {
    const { checks } = registry();
    const { out, code } = await run([...checks].reverse(), BASE);
    expect(out).toEqual([
      ...CHECK_IDS.map((id) => `pass  ${id}`),
      "doctor: 0 failed, 11 passed, 0 skipped",
    ]);
    expect(code).toBe(0);
  });

  it("prints the fix for a failure and keeps going", async () => {
    const { checks, stubs } = registry({
      remote_pushable: { status: "fail", fix: "give the deploy key write access" },
    });
    const { out, code } = await run(checks, BASE);
    const i = out.indexOf("fail  remote_pushable");
    expect(i).toBeGreaterThan(-1);
    expect(out[i + 1]).toBe("      fix: give the deploy key write access");
    expect(out[i + 2]).toBe("pass  vault_config");
    expect(stubs.get("vault_config")?.calls.count).toBe(1);
    expect(out.at(-1)).toBe("doctor: 1 failed, 10 passed, 0 skipped");
    expect(code).toBe(1);
  });

  it("collapses a multi-line fix to one line", async () => {
    const { checks } = registry({ env: { status: "fail", fix: "a\nb\r\n  c" } });
    const { out } = await run(checks, BASE);
    expect(out[1]).toBe("      fix: a b c");
  });

  it("treats a throwing check as a failure with a fixed fix line", async () => {
    const { checks, stubs } = registry({ network: new Error("boom detail 12345") });
    const { out, code } = await run(checks, BASE);
    expect(out.join("\n")).not.toContain("boom detail");
    expect(out).toContain("fail  network");
    expect(out).toContain(`      fix: ${UNEXPECTED_FIX}`);
    expect(stubs.get("remote_reachable")?.calls.count).toBe(1);
    expect(code).toBe(1);
  });

  it.each([
    ["undefined", {}],
    ["empty string", { PUBLIC_BASE_URL: "" }],
  ])("skips the public checks without calling them when PUBLIC_BASE_URL is %s", async (_n, env) => {
    const { checks, stubs } = registry();
    const { out, code } = await run(checks, env);
    for (const id of PUBLIC_CHECK_IDS) {
      expect(out).toContain(`skip  ${id} (PUBLIC_BASE_URL is empty: claude.ai cannot connect)`);
      expect(stubs.get(id)?.calls.count).toBe(0);
    }
    expect(SKIP_NOTE).toBe("PUBLIC_BASE_URL is empty: claude.ai cannot connect");
    expect(out.at(-1)).toBe("doctor: 0 failed, 8 passed, 3 skipped");
    expect(code).toBe(0);
  });

  it("runs the public checks when PUBLIC_BASE_URL is set", async () => {
    const { checks, stubs } = registry();
    await run(checks, BASE);
    for (const s of stubs.values()) expect(s.calls.count).toBe(1);
  });

  it("returns 0 for passes and skips only, 1 for any failure", async () => {
    expect((await run(registry().checks, {})).code).toBe(0);
    const failing = registry({ proxy_mcp: { status: "fail", fix: "x" } }).checks;
    expect((await run(failing, BASE)).code).toBe(1);
  });

  it("never prints planted secrets from a fix text", async () => {
    const fix = `token ${TOKEN} hash ${HASH} remote ${REMOTE} pass`;
    const { checks } = registry({ ingest_health: { status: "fail", fix } });
    const { out } = await run(checks, SECRET_ENV);
    const text = out.join("\n");
    for (const s of [TOKEN, HASH, REMOTE, "user:pass"]) expect(text).not.toContain(s);
    expect(text).toContain("fix: token <redacted>");
  });

  it("never prints planted secrets from a thrown message", async () => {
    const err = new Error(`failed ${TOKEN} ${HASH} ${REMOTE}`);
    const { checks } = registry({ remote_reachable: err });
    const { out } = await run(checks, SECRET_ENV);
    const text = out.join("\n");
    for (const s of [TOKEN, HASH, REMOTE, "user:pass"]) expect(text).not.toContain(s);
  });

  it("rejects a registry with a missing or duplicate id", async () => {
    const { checks } = registry();
    await expect(run(checks.slice(1), BASE)).rejects.toThrow(/missing: env/);
    await expect(run([...checks, stub("env").check], BASE)).rejects.toThrow(/duplicate check env/);
  });
});

describe("redactSecrets", () => {
  it("leaves the text unchanged when the env values are empty or unset", () => {
    const text = `plain ${TOKEN}`;
    expect(redactSecrets(text, { INGEST_TOKEN: "", VAULT_REMOTE: "" })).toBe(text);
    expect(redactSecrets(text, {})).toBe(text);
  });

  it("replaces a value that holds a dollar sequence literally", () => {
    const env = { INGEST_TOKEN: "a$&b" };
    expect(redactSecrets("x a$&b y a$&b", env)).toBe("x <redacted> y <redacted>");
  });

  it("redacts the userinfo and its parts of VAULT_REMOTE when they appear alone", () => {
    const env = { VAULT_REMOTE: REMOTE };
    expect(redactSecrets("denied for user:pass", env)).toBe("denied for <redacted>");
    expect(redactSecrets("bad secret pass for user", env)).toBe(
      "bad secret <redacted> for <redacted>",
    );
  });

  it("redacts the userinfo of any URL, even one not in the env", () => {
    expect(redactSecrets("see https://bob:hunter2@host.example.com/p", {})).toBe(
      "see https://<redacted>@host.example.com/p",
    );
  });
});
