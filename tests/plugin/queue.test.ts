import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueue } from "../../plugin/scripts/lib/queue.mjs";

const DAY = 86400000;
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const posix = process.platform !== "win32";

let dir: string;
let log: ReturnType<typeof vi.fn<(id: unknown, code: string) => void>>;
let q: ReturnType<typeof createQueue>;
let clock: number;

const queueFiles = () => readdirSync(join(dir, "queue")).sort();
const write = (sub: string, name: string, body: string) => {
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, name), body);
};
const jobBody = (attempts: number, ageMs: number) =>
  JSON.stringify({
    version: 1,
    event: { session_id: "x" },
    attempts,
    createdAt: new Date(NOW - ageMs).toISOString(),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-test-"));
  clock = NOW;
  log = vi.fn();
  q = createQueue({ dataDir: dir, now: () => clock, log });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("enqueue", () => {
  it("writes the named job with only the allowed event fields", () => {
    const job = q.enqueue({
      session_id: "abc-1",
      transcript_path: "/t/x.jsonl",
      cwd: "/p",
      hook_event_name: "SessionEnd",
      reason: "other",
      prompt: "PLANTED",
      extra: 5,
    });
    expect(job.name).toBe(`${NOW}-abc-1.json`);
    expect(queueFiles()).toEqual([job.name]);
    const onDisk = JSON.parse(readFileSync(join(dir, "queue", job.name), "utf8"));
    expect(onDisk).toStrictEqual({
      version: 1,
      event: {
        session_id: "abc-1",
        transcript_path: "/t/x.jsonl",
        cwd: "/p",
        hook_event_name: "SessionEnd",
        reason: "other",
      },
      attempts: 0,
      createdAt: "2026-10-31T12:00:00.000Z",
    });
    expect(job.data).toStrictEqual(onDisk);
    expect(existsSync(join(dir, "failed"))).toBe(true);
  });

  it("drops non-string values of allowed fields", () => {
    const job = q.enqueue({ session_id: "a", cwd: 5, reason: null });
    expect(job.data.event).toStrictEqual({ session_id: "a" });
  });

  it.skipIf(!posix)("creates the job file with mode 0600", () => {
    const job = q.enqueue({ session_id: "abc" });
    expect(statSync(join(dir, "queue", job.name)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "queue")).mode & 0o077).toBe(0);
  });

  it.skipIf(!posix)("ends with mode 0600 even under a restrictive umask", () => {
    const old = process.umask(0o277);
    try {
      const job = q.enqueue({ session_id: "abc" });
      expect(statSync(join(dir, "queue", job.name)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  it.each(["../x", "", "a/b", "a b", "x".repeat(129)])(
    "rejects the session id %j and writes nothing",
    (id) => {
      expect(() => q.enqueue({ session_id: id })).toThrow(TypeError);
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("rejects a missing or non-string session id", () => {
    expect(() => q.enqueue({})).toThrow(TypeError);
    expect(() => q.enqueue({ session_id: 7 })).toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("list", () => {
  it("is empty without a queue directory and with an empty one", () => {
    expect(q.list()).toEqual([]);
    mkdirSync(join(dir, "queue"));
    expect(q.list()).toEqual([]);
  });

  it("returns one job", () => {
    const job = q.enqueue({ session_id: "one" });
    expect(q.list()).toStrictEqual([job]);
  });

  it("sorts by epoch prefix, ignores .tmp and unparsable files", () => {
    write("queue", "100-b.json", jobBody(0, 0));
    write("queue", "20-z.json", jobBody(0, 0));
    write("queue", "100-a.json", jobBody(0, 0));
    write("queue", "5-x.json.123.tmp", jobBody(0, 0));
    write("queue", "1-bad.json", "{nope");
    expect(q.list().map((j) => j.name)).toEqual(["20-z.json", "100-a.json", "100-b.json"]);
  });
});

describe("recordAttempt", () => {
  it("increments attempts on disk and in the result, leaving no tmp file", () => {
    const job = q.enqueue({ session_id: "abc" });
    const next = q.recordAttempt(job);
    expect(next.data.attempts).toBe(1);
    expect(job.data.attempts).toBe(0);
    expect(queueFiles()).toEqual([job.name]);
    expect(JSON.parse(readFileSync(join(dir, "queue", job.name), "utf8")).attempts).toBe(1);
    expect(q.recordAttempt(next).data.attempts).toBe(2);
  });

  it.skipIf(!posix)("keeps mode 0600", () => {
    const job = q.recordAttempt(q.enqueue({ session_id: "abc" }));
    expect(statSync(join(dir, "queue", job.name)).mode & 0o777).toBe(0o600);
  });
});

describe("remove", () => {
  it("deletes the job and tolerates a missing one", () => {
    const job = q.enqueue({ session_id: "abc" });
    q.remove(job);
    expect(queueFiles()).toEqual([]);
    expect(() => q.remove(job)).not.toThrow();
  });
});

describe("sweep", () => {
  it("gives up on 3 attempts, on 8 days old and on invalid JSON, keeping a healthy job", () => {
    write("queue", "1-tries.json", jobBody(3, 0));
    write("queue", "2-old.json", jobBody(0, 8 * DAY));
    write("queue", "3-broken.json", "{nope");
    write("queue", "4-shape.json", JSON.stringify({ version: 1 }));
    write("queue", "5-keep.json", jobBody(2, 6 * DAY));
    q.sweep();
    expect(queueFiles()).toEqual(["5-keep.json"]);
    expect(readdirSync(join(dir, "failed")).sort()).toEqual([
      "1-tries.json",
      "2-old.json",
      "3-broken.json",
      "4-shape.json",
    ]);
    expect(log.mock.calls).toEqual([
      ["tries", "gave_up"],
      ["old", "gave_up"],
      ["broken", "gave_up"],
      ["shape", "gave_up"],
    ]);
  });

  it("works without a logger or any directory", () => {
    const bare = createQueue({ dataDir: dir, now: () => clock });
    expect(() => bare.sweep()).not.toThrow();
    write("queue", "1-t.json", jobBody(3, 0));
    bare.sweep();
    expect(existsSync(join(dir, "failed", "1-t.json"))).toBe(true);
  });

  it("deletes failed files older than 30 days, counted from the give-up time", () => {
    write("failed", "old.json", "{}");
    write("failed", "recent.json", "{}");
    utimesSync(join(dir, "failed", "old.json"), (NOW - 31 * DAY) / 1000, (NOW - 31 * DAY) / 1000);
    utimesSync(
      join(dir, "failed", "recent.json"),
      (NOW - 29 * DAY) / 1000,
      (NOW - 29 * DAY) / 1000,
    );
    q.sweep();
    expect(readdirSync(join(dir, "failed"))).toEqual(["recent.json"]);
  });

  it("stamps a job that just gave up so it survives the same sweep", () => {
    write("queue", "1-old.json", jobBody(0, 40 * DAY));
    const past = (NOW - 40 * DAY) / 1000;
    utimesSync(join(dir, "queue", "1-old.json"), past, past);
    q.sweep();
    expect(existsSync(join(dir, "failed", "1-old.json"))).toBe(true);
    clock = NOW + 31 * DAY;
    q.sweep();
    expect(readdirSync(join(dir, "failed"))).toEqual([]);
  });
});
