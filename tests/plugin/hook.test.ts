import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHook } from "../../plugin/scripts/session-end.mjs";

const HOOK = resolve("plugin/scripts/session-end.mjs");
const SCRIPTS = resolve("plugin/scripts");
const posix = process.platform !== "win32";

const EVENT = {
  session_id: "abc-123",
  transcript_path: "/t/x.jsonl",
  cwd: "/p",
  hook_event_name: "SessionEnd",
  reason: "other",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const logFile = (d = dir) => join(d, "logs", "capture.log");
const logText = (d = dir) => (existsSync(logFile(d)) ? readFileSync(logFile(d), "utf8") : "");

function fakeSpawn() {
  const child = { unref: vi.fn(), on: vi.fn() };
  return { spawn: vi.fn(() => child), child };
}

describe("runHook in process", () => {
  it("stores one job and starts the worker detached", () => {
    const { spawn, child } = fakeSpawn();
    const enqueue = vi.fn();
    const env = { CLAUDE_PLUGIN_DATA: dir };
    const code = runHook(JSON.stringify(EVENT), env, {
      spawn: spawn as never,
      enqueue,
      log: vi.fn(),
    });
    expect(code).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toStrictEqual(EVENT);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toStrictEqual([join(SCRIPTS, "capture-worker.mjs"), join(dir, "queue")]);
    expect(args[2]).toMatchObject({
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    expect((args[2] as { env: unknown }).env).toBe(env);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TWOBRAIN_CAPTURE=1", { TWOBRAIN_CAPTURE: "1" }],
    ["enabled false", { CLAUDE_PLUGIN_OPTION_ENABLED: "false" }],
  ])("does nothing with %s", (_n, extra) => {
    const { spawn } = fakeSpawn();
    const enqueue = vi.fn();
    const log = vi.fn();
    const code = runHook(
      JSON.stringify(EVENT),
      { CLAUDE_PLUGIN_DATA: dir, ...extra },
      {
        spawn: spawn as never,
        enqueue,
        log,
      },
    );
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toStrictEqual([]);
  });

  it.each([
    ["trimmed env wins over the setting", " work ", "personal", "work"],
    ["empty env falls back to the setting", "", " personal ", "personal"],
    ["both empty gives an empty string", "  ", "", ""],
  ])("area: %s", (_n, fromEnv, setting, expected) => {
    const { spawn } = fakeSpawn();
    const enqueue = vi.fn();
    runHook(
      JSON.stringify(EVENT),
      {
        CLAUDE_PLUGIN_DATA: dir,
        TWOBRAIN_AREA: fromEnv,
        CLAUDE_PLUGIN_OPTION_AREA: setting,
      },
      { spawn: spawn as never, enqueue, log: vi.fn() },
    );
    expect(enqueue.mock.calls[0]?.[1]).toStrictEqual({ area: expected });
  });

  it("stores the area in the real job file", () => {
    const { spawn } = fakeSpawn();
    runHook(
      JSON.stringify(EVENT),
      { CLAUDE_PLUGIN_DATA: dir, TWOBRAIN_AREA: " work " },
      {
        spawn: spawn as never,
      },
    );
    const [name] = readdirSync(join(dir, "queue"));
    const job = JSON.parse(readFileSync(join(dir, "queue", name as string), "utf8"));
    expect(job.area).toBe("work");
    expect(job.event).toStrictEqual(EVENT);
  });

  it("logs hook_error and keeps the job when spawn throws", () => {
    const spawn = vi.fn(() => {
      throw new Error("boom");
    });
    const code = runHook(
      JSON.stringify(EVENT),
      { CLAUDE_PLUGIN_DATA: dir },
      {
        spawn: spawn as never,
      },
    );
    expect(code).toBe(0);
    expect(readdirSync(join(dir, "queue")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(logText()).toContain(" abc-123 hook_error");
  });

  it("logs hook_error from an asynchronous spawn error", () => {
    const { spawn, child } = fakeSpawn();
    runHook(JSON.stringify(EVENT), { CLAUDE_PLUGIN_DATA: dir }, { spawn: spawn as never });
    const handler = child.on.mock.calls.find((c) => c[0] === "error")?.[1] as () => void;
    expect(handler).toBeTypeOf("function");
    handler();
    expect(logText()).toContain("hook_error");
  });

  it("rejects a session id that fails the pattern", () => {
    const { spawn } = fakeSpawn();
    runHook(
      JSON.stringify({ ...EVENT, session_id: "../x" }),
      { CLAUDE_PLUGIN_DATA: dir },
      {
        spawn: spawn as never,
      },
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(logText()).toContain("invalid_input");
  });
});

function runChild(input: string, env: Record<string, string | undefined>) {
  const full: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of ["TWOBRAIN_CAPTURE", "CLAUDE_PLUGIN_DATA", "TWOBRAIN_AREA"]) {
    if (!(k in env)) delete full[k];
  }
  for (const k of Object.keys(full)) {
    if (k.startsWith("CLAUDE_PLUGIN_OPTION_") && !(k in env)) delete full[k];
  }
  return spawnSync(process.execPath, [HOOK], {
    input,
    env: full as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

function expectSilent(r: ReturnType<typeof runChild>) {
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
}

describe("session-end.mjs as a child process", () => {
  it.each([
    ["not JSON", "nope"],
    ["missing session_id", JSON.stringify({ ...EVENT, session_id: undefined })],
    ["missing transcript_path", JSON.stringify({ ...EVENT, transcript_path: undefined })],
    ["missing cwd", JSON.stringify({ ...EVENT, cwd: undefined })],
  ])("logs invalid_input for %s", (_n, input) => {
    const r = runChild(input, { CLAUDE_PLUGIN_DATA: dir });
    expectSilent(r);
    expect(logText()).toContain(" - invalid_input");
    expect(existsSync(join(dir, "queue")) ? readdirSync(join(dir, "queue")) : []).toStrictEqual([]);
  });

  it.each([
    ["TWOBRAIN_CAPTURE=1", { TWOBRAIN_CAPTURE: "1" }],
    ["enabled false", { CLAUDE_PLUGIN_OPTION_ENABLED: "false" }],
  ])("writes nothing with %s", (_n, extra) => {
    expectSilent(runChild(JSON.stringify(EVENT), { CLAUDE_PLUGIN_DATA: dir, ...extra }));
    expect(readdirSync(dir)).toStrictEqual([]);
  });

  it("logs hook_error when queue is a regular file", () => {
    writeFileSync(join(dir, "queue"), "x");
    expectSilent(runChild(JSON.stringify(EVENT), { CLAUDE_PLUGIN_DATA: dir }));
    expect(logText()).toContain("abc-123 hook_error");
  });

  it("writes nothing when CLAUDE_PLUGIN_DATA is a regular file", () => {
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    expectSilent(runChild(JSON.stringify(EVENT), { CLAUDE_PLUGIN_DATA: file }));
    expect(readdirSync(dir)).toStrictEqual(["afile"]);
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("writes nothing when CLAUDE_PLUGIN_DATA is unset", () => {
    expectSilent(runChild(JSON.stringify(EVENT), {}));
    expect(readdirSync(dir)).toStrictEqual([]);
  });

  const hasSetpriv = posix && spawnSync("setpriv", ["--version"]).status === 0;
  const root = posix && process.getuid?.() === 0;
  it.skipIf(!posix || (root && !hasSetpriv))(
    "creates a missing data dir as 0700 under umask 777",
    () => {
      // Under root the copy is made world readable so the unprivileged user can run it.
      const parent = mkdtempSync(join(tmpdir(), "hook-umask-"));
      try {
        chmodSync(parent, 0o777);
        const data = join(parent, "data");
        const run = ["sh", "-c", 'umask 777; exec "$@"', "sh", process.execPath, HOOK];
        const cmd = root
          ? ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", ...run]
          : run;
        const r = spawnSync(cmd[0] as string, cmd.slice(1), {
          input: JSON.stringify({ ...EVENT, cwd: undefined }),
          env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
          encoding: "utf8",
        });
        expectSilent(r);
        expect(statSync(data).mode & 0o777).toBe(0o700);
        expect(logText(data)).toContain("invalid_input");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
});
