import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueue } from "../../plugin/scripts/lib/queue.mjs";
import { type FakeScript, installFakeClaude } from "./helpers/fake-claude.js";

const posix = process.platform !== "win32";
const MARKER = "UNIQUE-TRANSCRIPT-MARKER";
const NOTE = "work/sessions/2026-10-31-example.md";
const RECIPE = "work/recipes/example.md";

const saved = {
  status: "saved",
  session_note: NOTE,
  recipes: [RECIPE],
  people_updated: [],
  already_saved: false,
  detail: "ok",
};
const nothing = { ...saved, status: "nothing_to_save", session_note: null, recipes: [] };

let dir: string;
let clock: number;
let q: ReturnType<typeof createQueue>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-results-"));
  clock = Date.now() - 100000;
  q = createQueue({ dataDir: dir, now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function transcript(n: number, first = "u-1"): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: i === 1 ? first : `u-${i}`,
        timestamp: "2026-10-31T10:00:00Z",
        message: { role: "user", content: `PROMPT-${i} ${MARKER}-${i}` },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: `a-${i}`,
        timestamp: "2026-10-31T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: `ANSWER-${i}` }] },
      }),
    );
  }
  return lines.join("\n");
}

let counter = 0;
function enqueue(id: string, prompts = 3, reason?: string, first = "u-1"): void {
  const file = join(dir, `t-${counter++}.jsonl`);
  writeFileSync(file, transcript(prompts, first));
  clock += 1000;
  q.enqueue(
    { session_id: id, transcript_path: file, cwd: "/proj", ...(reason ? { reason } : {}) },
    { area: "work" },
  );
}

function seed(sessions: Record<string, unknown>): void {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, sessions }));
}

function runWorker(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "worker-results-home-"));
  try {
    const r = spawnSync(
      process.execPath,
      [join(process.cwd(), "plugin", "scripts", "capture-worker.mjs"), join(dir, "queue")],
      { encoding: "utf8", env: { ...env, HOME: home } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function go(script: FakeScript, setup?: () => void) {
  const fake = installFakeClaude(script);
  setup?.();
  runWorker(fake.env);
  return fake;
}

const log = () => {
  try {
    return readFileSync(join(dir, "logs", "capture.log"), "utf8");
  } catch {
    return "";
  }
};
const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const queued = () => q.list();
const attempts = () => q.list().map((j) => j.data.attempts);

function noTranscriptInLog(): void {
  const text = log();
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain("PROMPT-");
  expect(text).not.toContain("ANSWER-");
}

describe.skipIf(!posix)("worker results (real worker, fake claude)", () => {
  it("saved: logs the paths, records the session and deletes the job", () => {
    go({ result: saved }, () => enqueue("abcdefgh-ij"));
    expect(log()).toContain(`abcdefgh saved notes=${NOTE} recipes=1`);
    const entry = state().sessions["abcdefgh-ij"];
    expect(entry).toMatchObject({ lineage: "u-1", prompts: 3, parts: 1 });
    expect(Number.isNaN(Date.parse(entry.capturedAt))).toBe(false);
    expect(queued()).toHaveLength(0);
    noTranscriptInLog();
  });

  it("saved on a resumed session: part 2 and the new prompt count", () => {
    seed({
      "abcdefgh-ij": {
        lineage: "u-1",
        prompts: 3,
        parts: 1,
        capturedAt: new Date().toISOString(),
      },
    });
    go({ result: saved }, () => enqueue("abcdefgh-ij", 6));
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 6, parts: 2 });
    expect(queued()).toHaveLength(0);
  });

  it("already_saved: logs already_saved only, records the part and deletes the job", () => {
    go({ result: { ...saved, already_saved: true } }, () => enqueue("abcdefgh-ij"));
    expect(log()).toContain("abcdefgh already_saved");
    expect(log()).not.toContain(" saved");
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 3, parts: 1 });
    expect(queued()).toHaveLength(0);
  });

  it("nothing_to_save on a new session: prompts recorded, no part", () => {
    go({ result: nothing }, () => enqueue("abcdefgh-ij"));
    expect(log()).toContain("abcdefgh nothing_to_save");
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 3, parts: 0 });
    expect(queued()).toHaveLength(0);
  });

  it("nothing_to_save on a resumed session: parts stay, prompts move", () => {
    seed({
      "abcdefgh-ij": {
        lineage: "u-1",
        prompts: 3,
        parts: 1,
        capturedAt: new Date().toISOString(),
      },
    });
    go({ result: nothing }, () => enqueue("abcdefgh-ij", 6));
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 6, parts: 1 });
    expect(queued()).toHaveLength(0);
  });

  it("a session first nothing_to_save then resumed is captured as part 1 with the plain source id", () => {
    seed({
      "abcdefgh-ij": {
        lineage: "u-1",
        prompts: 3,
        parts: 0,
        capturedAt: new Date().toISOString(),
      },
    });
    const fake = go({ result: saved }, () => enqueue("abcdefgh-ij", 6));
    expect(fake.runs()[0]?.stdin).toContain("source_id: claude-code:abcdefgh-ij  part: 1");
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 6, parts: 1 });
  });

  it("failed: logs failed, adds an attempt and writes no state", () => {
    go({ result: { ...saved, status: "failed", session_note: null } }, () =>
      enqueue("abcdefgh-ij"),
    );
    expect(log()).toContain("abcdefgh failed");
    expect(attempts()).toStrictEqual([1]);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    noTranscriptInLog();
  });

  it("claude_not_found: logs it, adds an attempt and writes no state", () => {
    const empty = mkdtempSync(join(tmpdir(), "worker-results-empty-"));
    try {
      enqueue("abcdefgh-ij");
      runWorker({ PATH: empty });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(log()).toContain("abcdefgh claude_not_found");
    expect(log()).not.toContain("headless_failed");
    expect(attempts()).toStrictEqual([1]);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  describe("logout jobs", () => {
    const runs = (f: ReturnType<typeof installFakeClaude>) =>
      f.runs().sort((a, b) => a.start - b.start);
    const ids = (f: ReturnType<typeof installFakeClaude>) =>
      runs(f).map((r) => /source_id: claude-code:([\w-]+)/.exec(r.stdin ?? "")?.[1]);

    it("one logout job alone stays queued without a run or an attempt", () => {
      const fake = go({ result: saved }, () => enqueue("lo-one", 3, "logout"));
      expect(fake.runs()).toHaveLength(0);
      expect(attempts()).toStrictEqual([0]);
      expect(log()).toBe("");
    });

    it("two logout jobs both stay queued", () => {
      const fake = go({ result: saved }, () => {
        enqueue("lo-one", 3, "logout");
        enqueue("lo-two", 3, "logout");
      });
      expect(fake.runs()).toHaveLength(0);
      expect(attempts()).toStrictEqual([0, 0]);
    });

    it("run oldest first once a newer trivial job is queued", () => {
      const fake = go({ result: saved }, () => {
        enqueue("lo-one", 3, "logout", "l1");
        enqueue("lo-two", 3, "logout", "l2");
        enqueue("newer", 1, "clear", "n1");
      });
      expect(ids(fake)).toStrictEqual(["lo-one", "lo-two"]);
      expect(log()).toContain("newer skipped_trivial");
      expect(queued()).toHaveLength(0);
    });

    it("a logout job and a newer capturing job give two runs", () => {
      const fake = go({ result: saved }, () => {
        enqueue("lo-one", 3, "logout", "l1");
        enqueue("newer", 3, "clear", "n1");
      });
      expect(ids(fake)).toStrictEqual(["lo-one", "newer"]);
    });

    it("a newer logout job stays queued behind an older non-logout job", () => {
      const fake = go({ result: saved }, () => {
        enqueue("older", 3, "clear", "o1");
        enqueue("lo-new", 3, "logout", "l1");
      });
      expect(ids(fake)).toStrictEqual(["older"]);
      expect(queued().map((j) => j.data.event.session_id)).toStrictEqual(["lo-new"]);
      expect(attempts()).toStrictEqual([0]);
    });
  });
});
