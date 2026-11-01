import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLock, createQueue } from "../../plugin/scripts/lib/queue.mjs";

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

  it("stores the area when given, including an empty one, and none otherwise", () => {
    const withArea = q.enqueue({ session_id: "a1" }, { area: "work" });
    expect(withArea.data.area).toBe("work");
    expect(JSON.parse(readFileSync(join(dir, "queue", withArea.name), "utf8")).area).toBe("work");
    clock += 1;
    const empty = q.enqueue({ session_id: "a2" }, { area: "" });
    expect(empty.data.area).toBe("");
    clock += 1;
    const none = q.enqueue({ session_id: "a3" });
    expect("area" in none.data).toBe(false);
  });

  it("keeps the area when an attempt is recorded", () => {
    const job = q.enqueue({ session_id: "a4" }, { area: "work" });
    const again = q.recordAttempt(job);
    expect(again.data.area).toBe("work");
    expect(q.list()[0]?.data.area).toBe("work");
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
      expect(statSync(join(dir, "queue")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "failed")).mode & 0o777).toBe(0o700);
      const second = q.enqueue({ session_id: "def" });
      expect(queueFiles()).toContain(second.name);
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

describe("entries that are not regular files", () => {
  it("list and sweep skip a directory and a symlink named like a job", () => {
    write("queue", "1-keep.json", jobBody(0, 0));
    mkdirSync(join(dir, "queue", "2-dir.json"));
    writeFileSync(join(dir, "target.txt"), jobBody(3, 0));
    if (posix) symlinkSync(join(dir, "target.txt"), join(dir, "queue", "3-link.json"));
    expect(q.list().map((j) => j.name)).toEqual(["1-keep.json"]);
    q.sweep();
    expect(queueFiles()).toEqual(
      posix ? ["1-keep.json", "2-dir.json", "3-link.json"] : ["1-keep.json", "2-dir.json"],
    );
    expect(log).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "failed", "2-dir.json"))).toBe(false);
  });

  it("keeps a subdirectory of failed/ older than 30 days without throwing", () => {
    mkdirSync(join(dir, "failed", "sub"), { recursive: true });
    utimesSync(join(dir, "failed", "sub"), (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
    expect(() => q.sweep()).not.toThrow();
    expect(readdirSync(join(dir, "failed"))).toEqual(["sub"]);
  });

  it.skipIf(!posix)("keeps an old symlink in failed/ instead of deleting it", () => {
    writeFileSync(join(dir, "target.txt"), "x");
    mkdirSync(join(dir, "failed"), { recursive: true });
    const link = join(dir, "failed", "old-link.json");
    symlinkSync(join(dir, "target.txt"), link);
    lutimesSync(link, (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
    q.sweep();
    expect(readdirSync(join(dir, "failed"))).toEqual(["old-link.json"]);
  });
});

describe("createLock", () => {
  const MIN = 60000;
  const lockPath = () => join(dir, "capture.lock");
  const plant = (body: string, ageMs = 0) => {
    writeFileSync(lockPath(), body);
    const t = (NOW - ageMs) / 1000;
    utimesSync(lockPath(), t, t);
  };
  const planted = (pid: number, ageMs: number) =>
    plant(JSON.stringify({ pid, startedAt: new Date(NOW - ageMs).toISOString() }), ageMs);
  const lock = (
    pid: number,
    isAlive: (pid: number) => boolean = () => true,
    fs?: Parameters<typeof createLock>[0]["fs"],
  ) => createLock({ dataDir: dir, now: () => clock, pid, isAlive, fs });

  it("creates the file exclusively with pid and startedAt, and a second acquire fails", () => {
    const a = lock(1001);
    expect(a.acquire()).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toStrictEqual({
      pid: 1001,
      startedAt: new Date(NOW).toISOString(),
    });
    if (posix) expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    expect(lock(1002).acquire()).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(1001);
  });

  it("creates with the wx flag", () => {
    const calls: unknown[] = [];
    const real = writeFileSync;
    const b = lock(1002, () => true, {
      writeFileSync: ((path: string, data: string, opts: unknown) => {
        calls.push(opts);
        return real(path, data, opts as never);
      }) as never,
    });
    expect(b.acquire()).toBe(true);
    expect(calls[0]).toMatchObject({ flag: "wx" });
  });

  it("takes over a 16-minute lock and respects a 14-minute one", () => {
    planted(1001, 14 * MIN);
    expect(lock(1002).acquire()).toBe(false);
    planted(1001, 16 * MIN);
    expect(lock(1002).acquire()).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(1002);
    expect(existsSync(`${lockPath()}.takeover`)).toBe(false);
  });

  it("takes over a lock whose pid is dead at any age", () => {
    planted(1001, MIN);
    expect(lock(1002, (pid) => pid !== 1001).acquire()).toBe(true);
  });

  it("treats a lock with our own pid as stale", () => {
    planted(1002, MIN);
    expect(lock(1002).acquire()).toBe(true);
  });

  it("holds unparseable content while its mtime is fresh and takes it over when old", () => {
    plant("not json", 14 * MIN);
    expect(lock(1002).acquire()).toBe(false);
    plant("not json", 16 * MIN);
    expect(lock(1002).acquire()).toBe(true);
    plant('{"pid":"x"}', MIN);
    expect(lock(1003).acquire()).toBe(false);
  });

  it("lets only one of two workers that find the same stale lock acquire it", () => {
    planted(1001, 16 * MIN);
    let b: ReturnType<typeof createLock> | undefined;
    let bResult: boolean | undefined;
    let reads = 0;
    const realRead = readFileSync;
    const a = lock(1002, () => true, {
      readFileSync: ((path: string, enc: string) => {
        const text = realRead(path, enc as never);
        if (++reads === 1) bResult = b?.acquire();
        return text;
      }) as never,
    });
    b = lock(1003);
    const aResult = a.acquire();
    expect([aResult, bResult].filter(Boolean)).toHaveLength(1);
    expect(bResult).toBe(true);
    expect(aResult).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(1003);
  });

  it("removes a takeover mutex over 15 minutes old and refuses a fresh one", () => {
    planted(1001, 16 * MIN);
    writeFileSync(`${lockPath()}.takeover`, "x");
    expect(lock(1002).acquire()).toBe(false);
    const t = (NOW - 16 * MIN) / 1000;
    utimesSync(`${lockPath()}.takeover`, t, t);
    expect(lock(1002).acquire()).toBe(true);
  });

  it("refresh keeps a 20-minute drain from looking stale", () => {
    const a = lock(1001);
    expect(a.acquire()).toBe(true);
    clock += 10 * MIN;
    expect(a.refresh()).toBe(true);
    clock += 10 * MIN;
    expect(lock(1002).acquire()).toBe(false);
  });

  it("without a refresh the same drain is stale", () => {
    expect(lock(1001).acquire()).toBe(true);
    clock += 20 * MIN;
    expect(lock(1002).acquire()).toBe(true);
  });

  it("refresh returns false after a takeover or a release", () => {
    const a = lock(1001);
    expect(a.acquire()).toBe(true);
    clock += 16 * MIN;
    expect(lock(1002).acquire()).toBe(true);
    expect(a.refresh()).toBe(false);
    const b = lock(1002);
    b.release();
    expect(b.refresh()).toBe(false);
  });

  it("release removes our lock, leaves a foreign one and never throws", () => {
    const a = lock(1001);
    expect(a.acquire()).toBe(true);
    a.release();
    expect(existsSync(lockPath())).toBe(false);
    a.release();
    planted(1002, MIN);
    a.release();
    expect(existsSync(lockPath())).toBe(true);
  });

  it("returns false when the data directory does not exist", () => {
    const missing = createLock({ dataDir: join(dir, "nope"), now: () => clock, pid: 1 });
    expect(missing.acquire()).toBe(false);
  });
});
