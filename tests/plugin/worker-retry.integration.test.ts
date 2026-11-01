import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorker } from "../../plugin/scripts/capture-worker.mjs";
import { runCapture } from "../../plugin/scripts/lib/headless.mjs";
import { createQueue } from "../../plugin/scripts/lib/queue.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";
import { type FakeScript, installFakeClaude } from "./helpers/fake-claude.js";

const posix = process.platform !== "win32";
const MIN = 60000;
const NOTE = "work/sessions/2026-10-31-example.md";
const MARKER = "RETRY-TRANSCRIPT-MARKER";

const base = {
  status: "saved",
  session_note: NOTE,
  recipes: [] as string[],
  people_updated: [] as string[],
  already_saved: false,
  detail: "ok",
};
const mcp = { ...base, status: "mcp_unavailable", session_note: null };

let dir: string;
let homes: string[];
let children: ReturnType<typeof spawn>[];
let q: ReturnType<typeof createQueue>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-retry-"));
  homes = [];
  children = [];
  q = createQueue({ dataDir: dir, now: Date.now });
});
afterEach(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function transcript(n: number, first: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: i === 1 ? first : `${first}-${i}`,
        timestamp: "2026-10-31T10:00:00Z",
        message: { role: "user", content: `PROMPT-${i} ${MARKER}` },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: `${first}-a${i}`,
        timestamp: "2026-10-31T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: `ANSWER-${i}` }] },
      }),
    );
  }
  return lines.join("\n");
}

function enqueue(id: string): void {
  const file = join(dir, `t-${id}.jsonl`);
  writeFileSync(file, transcript(3, `lin-${id}`));
  q.enqueue({ session_id: id, transcript_path: file, cwd: "/proj" }, { area: "work" });
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "worker-retry-home-"));
  homes.push(h);
  return h;
}

/** Starts the real worker; resolves with its exit status, output and close time. */
function startWorker(env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "plugin", "scripts", "capture-worker.mjs"), join(dir, "queue")],
    { env: { ...env, HOME: home() }, stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  children.push(child);
  let out = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  return new Promise<{ status: number | null; out: string; closedAt: number }>((resolve) => {
    child.on("close", (status) => resolve({ status, out, closedAt: Date.now() }));
  });
}

async function work(env: Record<string, string>) {
  const r = await startWorker(env);
  expect(r.status).toBe(0);
  expect(r.out).toBe("");
  return r;
}

function setScript(fake: ReturnType<typeof installFakeClaude>, script: FakeScript): void {
  writeFileSync(fake.env.FAKE_CLAUDE_SCRIPT as string, JSON.stringify(script));
}

const log = () => {
  try {
    return readFileSync(join(dir, "logs", "capture.log"), "utf8");
  } catch {
    return "";
  }
};
const attempts = () => q.list().map((j) => j.data.attempts);
const lockFile = () => join(dir, "capture.lock");
const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));

describe.skipIf(!posix)("worker retries (real worker, fake claude)", () => {
  it("mcp_unavailable keeps the job; the next run saves it with one fake run", async () => {
    const fake = installFakeClaude({ result: mcp });
    enqueue("abcdefgh-ij");
    await work(fake.env);
    expect(log()).toContain("abcdefgh mcp_unavailable");
    expect(attempts()).toStrictEqual([1]);
    expect(fake.runs()).toHaveLength(1);
    expect(existsSync(lockFile())).toBe(false);

    setScript(fake, { result: base });
    await work(fake.env);
    expect(fake.runs()).toHaveLength(2);
    expect(log()).toContain(`abcdefgh saved notes=${NOTE} recipes=0`);
    expect(state().sessions["abcdefgh-ij"]).toMatchObject({ prompts: 3, parts: 1 });
    expect(q.list()).toHaveLength(0);
  }, 60000);

  it("after three mcp_unavailable runs the next start gives up with no fake run", async () => {
    const fake = installFakeClaude({ result: mcp });
    enqueue("abcdefgh-ij");
    for (let i = 1; i <= 3; i++) {
      await work(fake.env);
      expect(attempts()).toStrictEqual([i]);
    }
    expect(fake.runs()).toHaveLength(3);
    await work(fake.env);
    expect(fake.runs()).toHaveLength(3);
    expect(log()).toContain("abcdefgh gave_up");
    expect(q.list()).toHaveLength(0);
    expect(readdirSync(join(dir, "failed"))).toHaveLength(1);
  }, 60000);

  it("session_type_missing keeps the job with one attempt", async () => {
    const fake = installFakeClaude({
      result: { ...base, status: "session_type_missing", session_note: null },
    });
    enqueue("abcdefgh-ij");
    await work(fake.env);
    expect(log()).toContain("abcdefgh session_type_missing");
    expect(attempts()).toStrictEqual([1]);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("a fake that exits 1 logs headless_failed exit=1 and keeps the job", async () => {
    const fake = installFakeClaude({ exit: 1, stdout: "STDOUT-NOISE" });
    enqueue("abcdefgh-ij");
    await work(fake.env);
    expect(log()).toContain("abcdefgh headless_failed exit=1");
    expect(log()).not.toContain("STDOUT-NOISE");
    expect(attempts()).toStrictEqual([1]);
  });

  it("a hanging fake with a 1 s timeout logs timeout and keeps the job", async () => {
    const fake = installFakeClaude({ hang: true, stdout: "STDOUT-NOISE" });
    enqueue("abcdefgh-ij");
    await runWorker({
      dataDir: dir,
      pluginRoot: join(process.cwd(), "plugin"),
      settings: readSettings({}),
      env: { ...fake.env, HOME: home() },
      now: Date.now,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      runner: (j) => runCapture(j, { timeoutMs: 1000 }),
    });
    expect(log()).toContain("abcdefgh timeout");
    expect(log()).not.toContain("STDOUT-NOISE");
    expect(attempts()).toStrictEqual([1]);
    expect(existsSync(lockFile())).toBe(false);
  });
});

describe.skipIf(!posix)("capture lock (real workers, fake claude)", () => {
  const plant = (ageMs: number) =>
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - ageMs).toISOString() }),
    );

  it("two workers started at once give two runs that do not overlap", async () => {
    const fake = installFakeClaude({ result: base, sleepMs: 2000 });
    enqueue("job-aaaa-1");
    enqueue("job-bbbb-2");
    const [a, b] = await Promise.all([startWorker(fake.env), startWorker(fake.env)]);
    expect([a.status, b.status]).toStrictEqual([0, 0]);
    const runs = fake.runs().sort((x, y) => x.start - y.start);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.end).not.toBeNull();
    expect(runs[1]?.start).toBeGreaterThanOrEqual(runs[0]?.end as number);
    expect(Object.keys(state().sessions).sort()).toStrictEqual(["job-aaaa-1", "job-bbbb-2"]);
    expect(q.list()).toHaveLength(0);
    expect(existsSync(lockFile())).toBe(false);
  }, 30000);

  it("a job queued during a run is drained by the holder; a second worker exits early", async () => {
    const fake = installFakeClaude({ result: base, sleepMs: 2000 });
    enqueue("job-aaaa-1");
    const first = startWorker(fake.env);
    const deadline = Date.now() + 15000;
    const records = fake.env.FAKE_CLAUDE_RECORD as string;
    while (!existsSync(records) || readdirSync(records).length === 0) {
      if (Date.now() > deadline) throw new Error("no fake run started");
      await new Promise((r) => setTimeout(r, 25));
    }
    enqueue("job-bbbb-2");
    const second = await startWorker(fake.env);
    expect(second.status).toBe(0);
    expect(fake.runs()).toHaveLength(1);
    const firstDone = await first;
    expect(second.closedAt).toBeLessThan(firstDone.closedAt);
    expect(fake.runs()).toHaveLength(2);
    expect(Object.keys(state().sessions).sort()).toStrictEqual(["job-aaaa-1", "job-bbbb-2"]);
    expect(q.list()).toHaveLength(0);
    expect(existsSync(lockFile())).toBe(false);
  }, 30000);

  it("takes over a lock planted 16 minutes ago", async () => {
    const fake = installFakeClaude({ result: base });
    enqueue("abcdefgh-ij");
    plant(16 * MIN);
    await work(fake.env);
    expect(fake.runs()).toHaveLength(1);
    expect(log()).toContain("abcdefgh saved");
    expect(q.list()).toHaveLength(0);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("exits with no run when a live process holds a 1-minute lock", async () => {
    const fake = installFakeClaude({ result: base });
    enqueue("abcdefgh-ij");
    plant(MIN);
    await work(fake.env);
    expect(fake.runs()).toHaveLength(0);
    expect(attempts()).toStrictEqual([0]);
    expect(log()).toBe("");
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(process.pid);
  });
});
