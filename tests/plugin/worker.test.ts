import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../../plugin/scripts/capture-worker.mjs";
import { createQueue } from "../../plugin/scripts/lib/queue.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";
import { installFakeClaude } from "./helpers/fake-claude.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const DAY = 86400000;
const TRANSCRIPT = "/t/session.jsonl";
const MARKER = "PLANTED-TRANSCRIPT-MARKER";

let dir: string;
let clock: number;
let q: ReturnType<typeof createQueue>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-test-"));
  clock = NOW;
  q = createQueue({ dataDir: dir, now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A transcript with `n` user prompts; the first entry uuid is `first`. */
function transcript(n: number, first = "u-1", extra = MARKER): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const uuid = i === 1 ? first : `u-${i}`;
    lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: "2026-10-31T10:00:00Z",
        message: { role: "user", content: `PROMPT-${i} ${extra}` },
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

interface FsOpts {
  sizes?: (elapsed: number) => number;
  dir?: boolean;
  missing?: boolean;
  readThrows?: boolean;
}

function setup(content: string, opts: FsOpts = {}) {
  const readAt: number[] = [];
  const stat = vi.fn(() => {
    if (opts.missing) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return {
      size: opts.sizes ? opts.sizes(clock - NOW) : content.length,
      isFile: () => !opts.dir,
    };
  });
  const readFile = vi.fn(() => {
    readAt.push(clock - NOW);
    if (opts.readThrows) throw new Error("denied");
    return content;
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return { stat, readFile, sleep, readAt };
}

type Result = {
  status: string;
  session_note: string | null;
  recipes: string[];
  people_updated: string[];
  already_saved: boolean;
  detail: string;
};
type Outcome = { ok: true; result: Result } | { ok: false; code: string; exit?: number | null };

const result = (over: Partial<Result> = {}): Result => ({
  status: "saved",
  session_note: "work/sessions/n.md",
  recipes: [],
  people_updated: [],
  already_saved: false,
  detail: "ok",
  ...over,
});

function run(
  s: ReturnType<typeof setup>,
  runner: (a: { input: string }) => Promise<Outcome>,
  env: Record<string, string | undefined> = {},
  settingsEnv: Record<string, string | undefined> = {},
) {
  return runWorker({
    dataDir: dir,
    pluginRoot: "/plugin",
    settings: readSettings(settingsEnv),
    env,
    now: () => clock,
    sleep: s.sleep,
    fs: { stat: s.stat, readFile: s.readFile },
    runner: runner as never,
  });
}

const ok = () =>
  vi.fn(
    async (_a: { input: string }): Promise<Outcome> => ({
      ok: true,
      result: result({ status: "nothing_to_save", session_note: null }),
    }),
  );
const logText = () => {
  try {
    return readFileSync(join(dir, "logs", "capture.log"), "utf8");
  } catch {
    return "";
  }
};
const queued = () => readdirSync(join(dir, "queue")).filter((n) => n.endsWith(".json"));
const attempts = () => q.list().map((j) => j.data.attempts);
const enqueue = (
  id = "sess-1",
  area = "work",
  path: unknown = TRANSCRIPT,
  cwd: unknown = "/proj",
) => q.enqueue({ session_id: id, transcript_path: path as string, cwd: cwd as string }, { area });
const writeState = (sessions: Record<string, unknown>) =>
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, sessions }));

describe("sweep and order", () => {
  it("gives up exhausted and old jobs and runs the rest oldest first", async () => {
    clock = NOW - 8 * DAY;
    enqueue("old-one");
    clock = NOW - 1000;
    const exhausted = enqueue("tired-1");
    q.recordAttempt(q.recordAttempt(q.recordAttempt(exhausted)));
    clock = NOW - 500;
    enqueue("second-1");
    clock = NOW - 900;
    enqueue("first-1");
    clock = NOW;
    const s = setup(transcript(3));
    // a failed result records no state, so the shared lineage does not make the second job a duplicate
    const runner = vi.fn(
      async (_a: { input: string }): Promise<Outcome> => ({
        ok: true,
        result: result({ status: "failed", session_note: null }),
      }),
    );
    await run(s, runner);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(logText()).toMatch(/old-one gave_up/);
    expect(logText()).toMatch(/tired-1 gave_up/);
    const order = [...logText().matchAll(/ (first-1|second-1) failed/g)].map((m) => m[1]);
    expect(order).toStrictEqual(["first-1", "second-1"]);
    expect(readdirSync(join(dir, "failed")).length).toBe(2);
  });
});

describe("area", () => {
  it("logs not_configured before any transcript access and keeps the job", async () => {
    enqueue("sess-1", "");
    const s = setup(transcript(3));
    const runner = ok();
    await run(s, runner);
    expect(s.stat).not.toHaveBeenCalled();
    expect(s.readFile).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 not_configured");
    expect(attempts()).toStrictEqual([0]);
  });

  it("uses the area of the job, not the worker env", async () => {
    enqueue("sess-1", "work");
    const s = setup(transcript(3));
    const runner = ok();
    await run(s, runner, { TWOBRAIN_AREA: "personal" }, { CLAUDE_PLUGIN_OPTION_AREA: "other" });
    expect(runner.mock.calls[0]?.[0].input).toContain("area: work ");
    expect(runner.mock.calls[0]?.[0].input).not.toContain("personal");
  });
});

describe("settle wait", () => {
  it("reads at 2000 ms when the size is constant", async () => {
    enqueue();
    const s = setup(transcript(3));
    await run(s, ok());
    expect(s.readAt).toStrictEqual([2000]);
  });

  it("reads 2000 ms after the last growth", async () => {
    enqueue();
    const s = setup(transcript(3), { sizes: (e) => 100 + Math.min(e, 1000) });
    await run(s, ok());
    expect(s.readAt).toStrictEqual([3000]);
  });

  it("reads at 10000 ms when the file keeps growing", async () => {
    enqueue();
    const s = setup(transcript(3), { sizes: (e) => 100 + e });
    await run(s, ok());
    expect(s.readAt).toStrictEqual([10000]);
  });
});

describe("transcript_missing", () => {
  it.each([
    ["stat ENOENT", TRANSCRIPT, { missing: true }],
    ["a directory", TRANSCRIPT, { dir: true }],
    ["a relative path", "rel/x.jsonl", {}],
    ["a non-string path", 42, {}],
    ["a read error", TRANSCRIPT, { readThrows: true }],
  ])("deletes the job for %s", async (_n, path, opts) => {
    enqueue("sess-1", "work", path);
    const s = setup(transcript(3), opts as FsOpts);
    const runner = ok();
    await run(s, runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 transcript_missing");
    expect(queued()).toStrictEqual([]);
  });
});

describe("skips and parts", () => {
  it("skips a trivial session and deletes the job", async () => {
    enqueue();
    const s = setup(transcript(2));
    const runner = ok();
    await run(s, runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 skipped_trivial");
    expect(queued()).toStrictEqual([]);
  });

  it("captures exactly min_user_prompts", async () => {
    enqueue();
    const runner = ok();
    await run(setup(transcript(3)), runner);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("skips a known session id", async () => {
    writeState({
      "sess-1": { lineage: null, prompts: 3, parts: 1, capturedAt: new Date(NOW).toISOString() },
    });
    enqueue();
    const runner = ok();
    await run(setup(transcript(4)), runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 skipped_duplicate");
    expect(queued()).toStrictEqual([]);
  });

  it("skips a known lineage under a new session id", async () => {
    writeState({
      "first-id": {
        lineage: "lin-1",
        prompts: 3,
        parts: 1,
        capturedAt: new Date(NOW).toISOString(),
      },
    });
    enqueue("new-id");
    const runner = ok();
    await run(setup(transcript(4, "lin-1")), runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("new-id skipped_duplicate");
    expect(queued()).toStrictEqual([]);
  });

  it("captures a new session as part 1", async () => {
    enqueue("abcdefgh-ij");
    const runner = ok();
    await run(setup(transcript(3)), runner);
    expect(runner).toHaveBeenCalledTimes(1);
    const input = runner.mock.calls[0]?.[0].input as string;
    expect(input).toContain("source_id: claude-code:abcdefgh-ij  part: 1");
    expect(input).toContain("2026-10-31 proj abcdefgh.md");
  });

  it("captures a resumed session as part 2 from the new prompts only", async () => {
    writeState({
      "firstid12-x": {
        lineage: "lin-1",
        prompts: 3,
        parts: 1,
        capturedAt: new Date(NOW).toISOString(),
      },
    });
    enqueue("resumed-1");
    const runner = ok();
    await run(setup(transcript(6, "lin-1")), runner);
    expect(runner).toHaveBeenCalledTimes(1);
    const input = runner.mock.calls[0]?.[0].input as string;
    expect(input).toContain("source_id: claude-code:firstid12-x:2  part: 2");
    expect(input).toContain("firstid1 part 2.md");
    expect(input).toContain("PROMPT-4");
    for (const n of [1, 2, 3]) expect(input).not.toContain(`PROMPT-${n} `);
  });
});

describe("invalid_field", () => {
  it("drops a job whose area has two lines", async () => {
    enqueue("sess-1", "a\nb");
    const runner = ok();
    await run(setup(transcript(3)), runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 invalid_field");
    expect(queued()).toStrictEqual([]);
  });

  it("drops a job whose transcript has no timestamps", async () => {
    enqueue();
    const noTime = transcript(3).replaceAll("timestamp", "tstamp");
    const runner = ok();
    await run(setup(noTime), runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 invalid_field");
    expect(queued()).toStrictEqual([]);
  });

  it("drops a job with a bad session id", async () => {
    mkdirSync(join(dir, "queue"), { recursive: true });
    writeFileSync(
      join(dir, "queue", `${NOW}-bad.json`),
      JSON.stringify({
        version: 1,
        event: { session_id: "../x", transcript_path: TRANSCRIPT, cwd: "/proj" },
        attempts: 0,
        createdAt: new Date(NOW).toISOString(),
        area: "work",
      }),
    );
    const runner = ok();
    const s = setup(transcript(3));
    await run(s, runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain(" - invalid_field");
    expect(queued()).toStrictEqual([]);
    expect(s.stat).not.toHaveBeenCalled();
    expect(s.readFile).not.toHaveBeenCalled();
  });
});

describe("runner outcomes", () => {
  const outcome = (o: Outcome) => vi.fn(async (_a: { input: string }) => o);

  it("api_helper_present deletes the job", async () => {
    enqueue();
    await run(setup(transcript(3)), outcome({ ok: false, code: "api_helper_present" }));
    expect(logText()).toContain("sess-1 api_helper_present");
    expect(queued()).toStrictEqual([]);
  });

  it.each([
    [
      "headless_failed",
      { ok: false, code: "headless_failed", exit: 1 } as Outcome,
      "headless_failed exit=1",
    ],
    ["claude_not_found", { ok: false, code: "claude_not_found" } as Outcome, "claude_not_found"],
    ["timeout", { ok: false, code: "timeout" } as Outcome, "timeout"],
    [
      "a failed result",
      { ok: true, result: result({ status: "failed", session_note: null }) } as Outcome,
      "failed",
    ],
  ])("%s keeps the job with one more attempt", async (_n, o, line) => {
    enqueue();
    await run(setup(transcript(3)), outcome(o));
    expect(logText()).toContain(`sess-1 ${line}`);
    expect(attempts()).toStrictEqual([1]);
  });

  it("runner not_configured keeps the job without an attempt", async () => {
    enqueue();
    await run(setup(transcript(3)), outcome({ ok: false, code: "not_configured" }));
    expect(logText()).toContain("sess-1 not_configured");
    expect(attempts()).toStrictEqual([0]);
  });

  it("an invalid detail logs invalid_detail, keeps the job and hides the text", async () => {
    enqueue();
    await run(setup(transcript(3)), outcome({ ok: true, result: result({ detail: "Bad Text" }) }));
    expect(logText()).toContain("sess-1 invalid_detail");
    expect(logText()).not.toContain("Bad Text");
    expect(attempts()).toStrictEqual([1]);
    expect(() => readFileSync(join(dir, "state.json"))).toThrow();
  });

  it.each(["../x.md", "a/../b.md", "/abs.md", "C:/x.md", "a\\b.md", "a//b.md", "n.txt"])(
    "never logs the session note %s",
    async (note) => {
      enqueue();
      await run(
        setup(transcript(3)),
        outcome({ ok: true, result: result({ session_note: note }) }),
      );
      const line =
        logText()
          .split("\n")
          .find((l) => l.includes("sess-1")) ?? "";
      expect(line).toContain("sess-1 saved");
      expect(line).not.toContain(note);
      expect(queued()).toStrictEqual([]);
    },
  );

  it("logs a valid people path after the session note", async () => {
    enqueue();
    await run(
      setup(transcript(3)),
      outcome({ ok: true, result: result({ people_updated: ["work/people/ana.md"] }) }),
    );
    expect(logText()).toContain("saved notes=work/sessions/n.md,work/people/ana.md recipes=0");
  });

  it("never logs transcript text", async () => {
    enqueue();
    await run(setup(transcript(3)), outcome({ ok: false, code: "timeout" }));
    expect(logText()).not.toContain(MARKER);
  });

  it("a throwing runner leaves its job and the next job still runs", async () => {
    clock = NOW - 2000;
    enqueue("job-one");
    clock = NOW - 1000;
    enqueue("job-two");
    clock = NOW;
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ok: true,
        result: result({ status: "failed", session_note: null }),
      });
    await run(setup(transcript(3)), runner as never);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(attempts()).toStrictEqual([0, 1]);
    expect(logText()).toContain("job-one worker_error");
  });
});

const posix = process.platform !== "win32";

describe.skipIf(!posix)("real file system", () => {
  const realRun = (runner: ReturnType<typeof ok>) =>
    runWorker({
      dataDir: dir,
      pluginRoot: "/plugin",
      settings: readSettings({}),
      env: {},
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      runner: runner as never,
    });

  it("treats a symlink to a regular file as transcript_missing", async () => {
    const real = join(dir, "real.jsonl");
    writeFileSync(real, transcript(3));
    const link = join(dir, "link.jsonl");
    symlinkSync(real, link);
    enqueue("sess-1", "work", link);
    const runner = ok();
    await realRun(runner);
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 transcript_missing");
    expect(queued()).toStrictEqual([]);
  });

  it("refuses a symlink at the descriptor even when stat says regular file", async () => {
    const real = join(dir, "real2.jsonl");
    writeFileSync(real, transcript(3));
    const link = join(dir, "link2.jsonl");
    symlinkSync(real, link);
    enqueue("sess-1", "work", link);
    const runner = ok();
    const s = setup("", {});
    await runWorker({
      dataDir: dir,
      pluginRoot: "/plugin",
      settings: readSettings({}),
      env: {},
      now: () => clock,
      sleep: s.sleep,
      fs: { stat: s.stat },
      runner: runner as never,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 transcript_missing");
  });

  it("does not follow a symlink when it stats the transcript", async () => {
    const real = join(dir, "real3.jsonl");
    writeFileSync(real, transcript(3));
    const link = join(dir, "link3.jsonl");
    symlinkSync(real, link);
    enqueue("sess-1", "work", link);
    const s = setup(transcript(3));
    await runWorker({
      dataDir: dir,
      pluginRoot: "/plugin",
      settings: readSettings({}),
      env: {},
      now: () => clock,
      sleep: s.sleep,
      fs: { readFile: s.readFile },
      runner: ok() as never,
    });
    expect(s.readFile).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 transcript_missing");
  });

  it("treats a FIFO swapped in after the stat as transcript_missing", async () => {
    const fifo = join(dir, "fifo.jsonl");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    enqueue("sess-1", "work", fifo);
    const runner = ok();
    const s = setup("", {});
    // stat claims a regular file; the descriptor check must still refuse the FIFO
    await runWorker({
      dataDir: dir,
      pluginRoot: "/plugin",
      settings: readSettings({}),
      env: {},
      now: () => clock,
      sleep: s.sleep,
      fs: { stat: s.stat },
      runner: runner as never,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(logText()).toContain("sess-1 transcript_missing");
    expect(queued()).toStrictEqual([]);
  });

  it("reads a regular file through the default reader", async () => {
    const file = join(dir, "ok.jsonl");
    writeFileSync(file, transcript(3));
    enqueue("sess-1", "work", file);
    const runner = ok();
    await realRun(runner);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!posix)("worker as a child process", () => {
  function runChild(script: Parameters<typeof installFakeClaude>[0], jobs: number) {
    const fake = installFakeClaude(script);
    const home = mkdtempSync(join(tmpdir(), "worker-home-"));
    try {
      const file = join(dir, "t.jsonl");
      writeFileSync(file, transcript(3));
      const cq = createQueue({ dataDir: dir, now: Date.now });
      cq.enqueue({ session_id: "sess-1", transcript_path: file, cwd: "/proj" }, { area: "work" });
      if (jobs > 1) {
        cq.enqueue(
          { session_id: "sess-2", transcript_path: join(dir, "missing.jsonl"), cwd: "/proj" },
          { area: "work" },
        );
      }
      const r = spawnSync(
        process.execPath,
        [join(process.cwd(), "plugin", "scripts", "capture-worker.mjs"), join(dir, "queue")],
        {
          encoding: "utf8",
          env: { ...fake.env, HOME: home, TWOBRAIN_AREA: "personal" },
        },
      );
      return { r, fake };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("is silent on a normal job and passes no TWOBRAIN_AREA to claude", () => {
    const { r, fake } = runChild({ result: { status: "nothing_to_save" } }, 1);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    const runs = fake.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.env.TWOBRAIN_AREA).toBeUndefined();
    expect(runs[0]?.stdin).toContain("area: work ");
  });

  it("is silent when claude fails and another job is missing its transcript", () => {
    const { r } = runChild({ exit: 1, stdout: "SECRET-LOOKING-NOISE" }, 2);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(logText()).toContain("headless_failed exit=1");
    expect(logText()).toContain("sess-2 transcript_missing");
  });
});
