import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, readState, recordCapture } from "../../plugin/scripts/lib/state.mjs";

const DAY = 86400000;
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const posix = process.platform !== "win32";
const isRoot = process.getuid?.() === 0;
const EMPTY = { version: 1, sessions: {} };

let dir: string;
const statePath = () => join(dir, "state.json");
const readFile = () => JSON.parse(readFileSync(statePath(), "utf8"));
const entry = (over: Record<string, unknown> = {}) => ({
  lineage: null,
  prompts: 5,
  parts: 1,
  capturedAt: new Date(NOW - DAY).toISOString(),
  ...over,
});
const stateWith = (sessions: Record<string, unknown>) => ({ version: 1, sessions });
const put = (value: unknown) => writeFileSync(statePath(), JSON.stringify(value));
const input = (over: Record<string, unknown> = {}) => ({
  sessionId: "aaa",
  lineage: null as string | null,
  userPrompts: 3,
  part: 1,
  ...over,
});
const dec = (state: unknown, over: Record<string, unknown> = {}) =>
  decide(
    state as never,
    {
      sessionId: "aaa",
      lineage: null,
      userPrompts: 3,
      minUserPrompts: 3,
      ...over,
    } as never,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readState", () => {
  it("returns an empty state for a missing file", () => {
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it("returns an empty state for non-JSON", () => {
    writeFileSync(statePath(), "{nope");
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it("returns an empty state for another version", () => {
    put({ version: 2, sessions: { aaa: entry() } });
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it("returns an empty state when sessions is an array", () => {
    put({ version: 1, sessions: [entry()] });
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it("returns an empty state when state.json is a directory", () => {
    mkdirSync(statePath());
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it.skipIf(!posix || isRoot)("returns an empty state for a mode 000 file", () => {
    put(stateWith({ aaa: entry() }));
    chmodSync(statePath(), 0o000);
    expect(readState(dir)).toStrictEqual(EMPTY);
  });

  it("keeps valid entries and drops invalid ones", () => {
    put(
      stateWith({
        good: entry({ lineage: "L" }),
        "bad id": entry(),
        negative: entry({ prompts: -1 }),
        fractional: entry({ parts: 1.5 }),
        badLineage: entry({ lineage: 7 }),
        badDate: entry({ capturedAt: "nope" }),
        notObject: 4,
      }),
    );
    expect(Object.keys(readState(dir).sessions)).toStrictEqual(["good"]);
  });
});

describe("decide", () => {
  it("captures part 1 for an unknown session and lineage", () => {
    expect(dec(EMPTY, { lineage: "L" })).toStrictEqual({
      action: "capture",
      part: 1,
      sourceId: "claude-code:aaa",
      idForName: "aaa",
      fromPrompt: 0,
    });
  });

  it("skips a known id with fewer than minUserPrompts new prompts and captures part 2 otherwise", () => {
    const state = stateWith({ aaa: entry() });
    expect(dec(state, { userPrompts: 7 })).toStrictEqual({ action: "skipped_duplicate" });
    expect(dec(state, { userPrompts: 8 })).toStrictEqual({
      action: "capture",
      part: 2,
      sourceId: "claude-code:aaa:2",
      idForName: "aaa",
      fromPrompt: 5,
    });
  });

  it("applies the same rules to a known lineage under a new id, using the first id", () => {
    const state = stateWith({ aaa: entry({ lineage: "L" }) });
    expect(dec(state, { sessionId: "bbb", lineage: "L", userPrompts: 7 })).toStrictEqual({
      action: "skipped_duplicate",
    });
    expect(dec(state, { sessionId: "bbb", lineage: "L", userPrompts: 8 })).toStrictEqual({
      action: "capture",
      part: 2,
      sourceId: "claude-code:aaa:2",
      idForName: "aaa",
      fromPrompt: 5,
    });
  });

  it("never matches a null or empty lineage", () => {
    const state = stateWith({ aaa: entry({ lineage: null }), ccc: entry({ lineage: "" }) });
    for (const lineage of [null, ""]) {
      expect(dec(state, { sessionId: "bbb", lineage, userPrompts: 99 })).toStrictEqual({
        action: "capture",
        part: 1,
        sourceId: "claude-code:bbb",
        idForName: "bbb",
        fromPrompt: 0,
      });
    }
  });

  it("skips when the prompt count is below the stored one", () => {
    expect(dec(stateWith({ aaa: entry() }), { userPrompts: 2 })).toStrictEqual({
      action: "skipped_duplicate",
    });
  });

  it("numbers part 3 after stored parts 2", () => {
    const d = dec(stateWith({ aaa: entry({ parts: 2 }) }), { userPrompts: 10 });
    expect(d).toMatchObject({ part: 3, sourceId: "claude-code:aaa:3" });
  });

  it("prefers the session id entry over a lineage match", () => {
    const state = stateWith({
      aaa: entry({ lineage: "L", prompts: 1, parts: 1 }),
      bbb: entry({ lineage: "M", prompts: 50, parts: 4 }),
    });
    expect(dec(state, { sessionId: "bbb", lineage: "L", userPrompts: 60 })).toMatchObject({
      part: 5,
      idForName: "bbb",
      fromPrompt: 50,
    });
  });

  it("does not change the state it is given", () => {
    const state = stateWith({ aaa: entry() });
    const copy = structuredClone(state);
    dec(state, { userPrompts: 20 });
    expect(state).toStrictEqual(copy);
  });
});

describe("recordCapture", () => {
  it("writes the exact file for a new entry", () => {
    recordCapture(dir, input({ lineage: "L", userPrompts: 4 }), NOW);
    expect(readFile()).toStrictEqual({
      version: 1,
      sessions: {
        aaa: { lineage: "L", prompts: 4, parts: 1, capturedAt: "2026-10-31T12:00:00.000Z" },
      },
    });
  });

  it("stores an empty lineage as null", () => {
    recordCapture(dir, input({ lineage: "" }), NOW);
    expect(readFile().sessions.aaa.lineage).toBeNull();
  });

  it("updates a known id instead of adding an entry, and decide gives the next part", () => {
    recordCapture(dir, input({ userPrompts: 4 }), NOW - DAY);
    recordCapture(dir, input({ userPrompts: 9, part: 2 }), NOW);
    const file = readFile();
    expect(Object.keys(file.sessions)).toStrictEqual(["aaa"]);
    expect(file.sessions.aaa).toStrictEqual({
      lineage: null,
      prompts: 9,
      parts: 2,
      capturedAt: "2026-10-31T12:00:00.000Z",
    });
    expect(dec(readState(dir), { userPrompts: 12 })).toMatchObject({
      part: 3,
      fromPrompt: 9,
    });
  });

  it("updates the first id's entry for a known lineage under a new id", () => {
    recordCapture(dir, input({ lineage: "L", userPrompts: 4 }), NOW - DAY);
    recordCapture(dir, input({ sessionId: "bbb", lineage: "L", userPrompts: 9, part: 2 }), NOW);
    const file = readFile();
    expect(Object.keys(file.sessions)).toStrictEqual(["aaa"]);
    expect(file.sessions.aaa).toMatchObject({ prompts: 9, parts: 2, lineage: "L" });
    expect(dec(readState(dir), { sessionId: "bbb", lineage: "L", userPrompts: 12 })).toMatchObject({
      part: 3,
      idForName: "aaa",
      fromPrompt: 9,
    });
  });

  it("keeps the old lineage when the new capture has none", () => {
    recordCapture(dir, input({ lineage: "L" }), NOW - DAY);
    recordCapture(dir, input({ lineage: null, userPrompts: 9, part: 2 }), NOW);
    expect(readFile().sessions.aaa.lineage).toBe("L");
  });

  it("prunes entries older than 180 days and keeps newer ones", () => {
    put(
      stateWith({
        old: entry({ capturedAt: new Date(NOW - 181 * DAY).toISOString() }),
        young: entry({ capturedAt: new Date(NOW - 179 * DAY).toISOString() }),
      }),
    );
    recordCapture(dir, input(), NOW);
    expect(Object.keys(readFile().sessions).sort()).toStrictEqual(["aaa", "young"]);
  });

  it("replaces a non-JSON file with one holding only the new entry", () => {
    writeFileSync(statePath(), "garbage");
    recordCapture(dir, input(), NOW);
    expect(Object.keys(readFile().sessions)).toStrictEqual(["aaa"]);
  });

  it("replaces a wrong-version file with one holding only the new entry", () => {
    put({ version: 9, sessions: { old: entry() } });
    recordCapture(dir, input(), NOW);
    expect(readFile()).toMatchObject({ version: 1 });
    expect(Object.keys(readFile().sessions)).toStrictEqual(["aaa"]);
  });

  it.skipIf(!posix || isRoot)(
    "replaces a mode 000 file with one holding only the new entry",
    () => {
      put(stateWith({ old: entry() }));
      chmodSync(statePath(), 0o000);
      recordCapture(dir, input(), NOW);
      expect(Object.keys(readFile().sessions)).toStrictEqual(["aaa"]);
    },
  );

  it("stores no transcript text from extra input fields", () => {
    recordCapture(dir, { ...input(), text: "PLANTED" } as never, NOW);
    expect(readFileSync(statePath(), "utf8")).not.toContain("PLANTED");
  });

  it("throws on an invalid session id and writes nothing", () => {
    for (const sessionId of ["../x", "", "a b", undefined]) {
      expect(() => recordCapture(dir, input({ sessionId }) as never, NOW)).toThrow(TypeError);
    }
    expect(() => readFileSync(statePath())).toThrow();
  });

  it("survives a stale temp file", () => {
    writeFileSync(join(dir, `state.json.${process.pid}.tmp`), "stale");
    recordCapture(dir, input(), NOW);
    expect(Object.keys(readFile().sessions)).toStrictEqual(["aaa"]);
  });

  it("creates the data directory when missing", () => {
    const nested = join(dir, "a", "b");
    recordCapture(nested, input(), NOW);
    expect(JSON.parse(readFileSync(join(nested, "state.json"), "utf8")).version).toBe(1);
  });

  it.skipIf(!posix)("writes mode 0600, also under a restrictive umask", () => {
    recordCapture(dir, input(), NOW);
    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
    rmSync(statePath());
    const old = process.umask(0o277);
    try {
      recordCapture(dir, input(), NOW);
    } finally {
      process.umask(old);
    }
    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
  });
});
