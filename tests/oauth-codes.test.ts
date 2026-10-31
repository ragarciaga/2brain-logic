import { describe, expect, it } from "vitest";
import { CODE_LIMITS, type CodeBinding, createCodeStore } from "../src/auth/oauth/codes.js";

const BINDING: CodeBinding = {
  clientId: "c1",
  redirectUri: "https://claude.ai/cb",
  codeChallenge: "A".repeat(43),
  resource: "https://brain.example.com/mcp",
};

function setup(extra: { maxCodes?: number; maxConsumed?: number } = {}) {
  const clock = { t: 5 };
  const store = createCodeStore({ now: () => clock.t, ...extra });
  return { clock, store };
}

describe("code store", () => {
  it("issues 43-character random codes and returns the binding once", () => {
    const { store } = setup();
    const a = store.issue(BINDING);
    const b = store.issue(BINDING);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    const first = store.consume(a);
    expect(first).toMatchObject({ kind: "ok", binding: BINDING });
    expect(store.consume(a).kind).toBe("replayed");
  });

  it("expires at exactly ttl", () => {
    const { clock, store } = setup();
    const code = store.issue(BINDING);
    clock.t += CODE_LIMITS.ttlMs - 1;
    expect(store.consume(code).kind).toBe("ok");
    const other = store.issue(BINDING);
    clock.t += CODE_LIMITS.ttlMs;
    expect(store.consume(other).kind).toBe("invalid");
  });

  it("treats non-strings, unknown and expired-unused codes as invalid, never replayed", () => {
    const { clock, store } = setup();
    for (const value of [undefined, null, 5, {}, ["x"], "nope"]) {
      expect(store.consume(value)).toEqual({ kind: "invalid" });
    }
    const code = store.issue(BINDING);
    clock.t += CODE_LIMITS.ttlMs + 1;
    expect(store.consume(code)).toEqual({ kind: "invalid" });
    expect(store.consume(code)).toEqual({ kind: "invalid" });
  });

  it("keeps the live map within maxCodes and drops the oldest", () => {
    const { store } = setup({ maxCodes: 3 });
    const codes = [1, 2, 3, 4, 5].map(() => store.issue(BINDING));
    expect(store.size()).toBe(3);
    expect(store.consume(codes[0]).kind).toBe("invalid");
    expect(store.consume(codes[4]).kind).toBe("ok");
    // A dropped code never enters the consumed memory.
    expect(store.consume(codes[0]).kind).toBe("invalid");
  });

  it("sweeps expired entries on issue", () => {
    const { clock, store } = setup();
    store.issue(BINDING);
    clock.t += CODE_LIMITS.ttlMs;
    store.issue(BINDING);
    expect(store.size()).toBe(1);
  });

  it("detects a replay inside the margin and forgets it after", () => {
    const { clock, store } = setup();
    const code = store.issue(BINDING);
    const used = store.consume(code);
    expect(used.kind).toBe("ok");
    clock.t += CODE_LIMITS.ttlMs + CODE_LIMITS.consumedMarginMs - 1;
    expect(store.consume(code).kind).toBe("replayed");
    expect(store.consume(code).kind).toBe("replayed");
    clock.t += 1;
    expect(store.consume(code)).toEqual({ kind: "invalid" });
    expect(store.consumedSize()).toBe(0);
  });

  it("bounds the consumed memory", () => {
    const { store } = setup({ maxConsumed: 2 });
    const codes = [1, 2, 3].map(() => store.issue(BINDING));
    for (const code of codes) store.consume(code);
    expect(store.consumedSize()).toBe(2);
    expect(store.consume(codes[0]).kind).toBe("invalid");
    expect(store.consume(codes[2]).kind).toBe("replayed");
  });

  it("attaches a grant and reports a replay that came before it", () => {
    const { store } = setup();
    const early = store.issue(BINDING);
    const late = store.issue(BINDING);
    const a = store.consume(early);
    const b = store.consume(late);
    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected ok");
    expect(store.consume(early).kind).toBe("replayed");
    expect(store.attachGrant(a.codeHash, "g1")).toEqual({ replayed: true });
    expect(store.attachGrant(b.codeHash, "g2")).toEqual({ replayed: false });
    expect(store.consume(late)).toMatchObject({ kind: "replayed", grantId: "g2" });
    expect(store.attachGrant("unknown", "g3")).toEqual({ replayed: false });
  });
});
