import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cmdLine,
  DEFAULT_TIMEOUT_MS,
  resolveClaude,
  runCapture,
} from "../../plugin/scripts/lib/headless.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";

const root = mkdtempSync(join(tmpdir(), "headless-platform-"));
const settings = readSettings({});
const schemaText = readFileSync("plugin/prompts/result.schema.json", "utf8");

afterEach(() => vi.useRealTimers());

class Stub extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stdinChunks: string[] = [];
  stdin = {
    on: () => undefined,
    end: (s: string) => {
      this.stdinChunks.push(s);
    },
  };
  kill = vi.fn();
}

interface Call {
  command: string;
  args: string[];
  opts: Record<string, unknown>;
}

function harness(platform: string, files: string[], env: Record<string, string>, extra = {}) {
  const calls: Call[] = [];
  const child = new Stub();
  const spawn = vi.fn((command: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ command, args, opts });
    return child;
  });
  const execFile = vi.fn();
  const kill = vi.fn();
  const set = new Set(files);
  const run = (paths = { pluginRoot: root, dataDir: join(root, "data") }) =>
    runCapture(
      { settings, env, paths, input: "the input" },
      {
        platform,
        spawn: spawn as never,
        execFile: execFile as never,
        kill,
        home: root,
        isFile: (f: string) => set.has(f),
        ...extra,
      },
    );
  return { calls, child, spawn, execFile, kill, run };
}

describe("resolveClaude", () => {
  const isFile = (set: string[]) => (f: string) => set.includes(f);

  it("prefers claude.exe over claude.cmd in the same dir", () => {
    const files = ["C:\\a\\claude.cmd", "C:\\a\\claude.exe"];
    const got = resolveClaude({ PATH: "C:\\a" }, { platform: "win32", isFile: isFile(files) });
    expect(got).toStrictEqual({ file: "C:\\a\\claude.exe", kind: "exe" });
  });

  it("prefers claude.exe in a later dir over claude.cmd in an earlier one", () => {
    const files = ["C:\\a\\claude.cmd", "C:\\b\\claude.exe"];
    const got = resolveClaude(
      { PATH: "C:\\a;C:\\b" },
      { platform: "win32", isFile: isFile(files) },
    );
    expect(got).toStrictEqual({ file: "C:\\b\\claude.exe", kind: "exe" });
  });

  it("falls back to claude.cmd", () => {
    const got = resolveClaude(
      { PATH: "C:\\a" },
      { platform: "win32", isFile: isFile(["C:\\a\\claude.cmd"]) },
    );
    expect(got).toStrictEqual({ file: "C:\\a\\claude.cmd", kind: "cmd" });
  });

  it("reads the Path key in any case on win32 and skips relative and empty entries", () => {
    const files = ["rel\\claude.exe", "C:\\ok\\claude.exe"];
    const got = resolveClaude(
      { Path: ';rel;"C:\\ok"' },
      { platform: "win32", isFile: isFile(files) },
    );
    expect(got).toStrictEqual({ file: "C:\\ok\\claude.exe", kind: "exe" });
  });

  it("is case sensitive for PATH on linux and skips relative dirs", () => {
    const files = ["/rel/claude", "bin/claude", "/bin/claude"];
    expect(
      resolveClaude({ Path: "/bin" }, { platform: "linux", isFile: isFile(files) }),
    ).toBeNull();
    expect(
      resolveClaude({ PATH: "bin::/bin" }, { platform: "linux", isFile: isFile(files) }),
    ).toStrictEqual({ file: "/bin/claude", kind: "exe" });
  });

  it("returns null without PATH", () => {
    expect(resolveClaude({}, { platform: "linux", isFile: () => true })).toBeNull();
  });
});

describe("runCapture platform handling", () => {
  it("has a default timeout of 600000 ms and applies it", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600000);
    vi.useFakeTimers();
    const h = harness("linux", ["/bin/claude"], { PATH: "/bin" });
    const p = h.run();
    await vi.advanceTimersByTimeAsync(599999);
    expect(h.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
    h.child.emit("close", null);
    expect(await p).toStrictEqual({ ok: false, code: "timeout" });
  });

  it("spawns detached on POSIX and kills the process group", async () => {
    const h = harness("linux", ["/bin/claude"], { PATH: "/bin" }, { timeoutMs: 5 });
    const p = h.run();
    await vi.waitFor(() => expect(h.kill).toHaveBeenCalled());
    expect(h.kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(h.execFile).not.toHaveBeenCalled();
    h.child.emit("close", null);
    expect(await p).toStrictEqual({ ok: false, code: "timeout" });
    const [call] = h.calls;
    expect(call?.command).toBe("/bin/claude");
    expect(call?.opts).toMatchObject({
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(h.child.stdinChunks).toStrictEqual(["the input"]);
  });

  it("kills with taskkill on win32 and does not detach", async () => {
    const h = harness("win32", ["C:\\b\\claude.exe"], { Path: "C:\\b" }, { timeoutMs: 5 });
    const p = h.run();
    await vi.waitFor(() => expect(h.execFile).toHaveBeenCalled());
    expect(h.execFile.mock.calls[0]?.slice(0, 3)).toStrictEqual([
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "4242", "/T", "/F"],
      { cwd: join(root, "data"), shell: false, windowsHide: true },
    ]);
    expect(h.kill).not.toHaveBeenCalled();
    h.child.emit("close", null);
    expect(await p).toStrictEqual({ ok: false, code: "timeout" });
    expect(h.calls[0]?.command).toBe("C:\\b\\claude.exe");
    expect(h.calls[0]?.opts).toMatchObject({ detached: false, windowsVerbatimArguments: false });
  });

  it.each([
    ["relative", "rel\\win"],
    ["missing", undefined],
  ])(
    "kills with an absolute taskkill under C:\\Windows for a %s SystemRoot",
    async (_n, sysRoot) => {
      const env: Record<string, string> = { Path: "C:\\b" };
      if (sysRoot) env.SystemRoot = sysRoot;
      const h = harness("win32", ["C:\\b\\claude.exe"], env, { timeoutMs: 5 });
      const p = h.run();
      await vi.waitFor(() => expect(h.execFile).toHaveBeenCalled());
      expect(h.execFile.mock.calls[0]?.[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
      h.child.emit("close", null);
      await p;
    },
  );

  it("uses an absolute SystemRoot for taskkill and cmd.exe, and a relative ComSpec falls back", async () => {
    const h = harness(
      "win32",
      ["C:\\a\\claude.cmd"],
      {
        Path: "C:\\a",
        SystemRoot: "D:\\Win",
        ComSpec: "cmd.exe",
      },
      { timeoutMs: 5 },
    );
    const p = h.run();
    await vi.waitFor(() => expect(h.execFile).toHaveBeenCalled());
    expect(h.execFile.mock.calls[0]?.[0]).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(h.calls[0]?.command).toBe("D:\\Win\\System32\\cmd.exe");
    h.child.emit("close", null);
    await p;
  });

  it("returns claude_not_found without spawning when nothing is on PATH", async () => {
    const h = harness("win32", [], { Path: "C:\\b" });
    expect(await h.run()).toStrictEqual({ ok: false, code: "claude_not_found" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("returns claude_not_found on a spawn ENOENT when the cwd exists", async () => {
    const h = harness("linux", ["/bin/claude"], { PATH: "/bin" });
    const p = h.run({ pluginRoot: root, dataDir: root });
    h.child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(await p).toStrictEqual({ ok: false, code: "claude_not_found" });
  });

  it("returns headless_failed on a spawn ENOENT when the cwd is missing", async () => {
    const h = harness("linux", ["/bin/claude"], { PATH: "/bin" });
    const p = h.run({ pluginRoot: root, dataDir: join(root, "missing") });
    h.child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(await p).toStrictEqual({ ok: false, code: "headless_failed", exit: null });
  });

  it("returns headless_failed on another spawn error", async () => {
    const h = harness("linux", ["/bin/claude"], { PATH: "/bin" });
    const p = h.run();
    h.child.emit("error", Object.assign(new Error("x"), { code: "EACCES" }));
    expect(await p).toStrictEqual({ ok: false, code: "headless_failed", exit: null });
  });

  it("runs a cmd-only install through cmd.exe with a verbatim line that decodes to the argv", async () => {
    const cmd = "C:\\Program Files\\100% a&b (x)\\claude.cmd";
    const h = harness("win32", [cmd], {
      Path: "C:\\Program Files\\100% a&b (x)",
      SystemRoot: "C:\\Windows",
    });
    const p = h.run();
    h.child.emit("close", 1);
    await p;
    const [call] = h.calls;
    expect(call?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call?.args.slice(0, 3)).toStrictEqual(["/d", "/s", "/c"]);
    expect(call?.opts).toMatchObject({
      windowsVerbatimArguments: true,
      shell: false,
      windowsHide: true,
    });
    expect(h.child.stdinChunks).toStrictEqual(["the input"]);
    const line = call?.args[3] ?? "";
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    const argv = decode(line.slice(1, -1));
    expect(argv[0]).toBe(cmd);
    const rest = argv.slice(1);
    expect(rest).toContain("");
    const schema = rest[rest.indexOf("--json-schema") + 1];
    expect(schema).toBe(JSON.stringify(JSON.parse(schemaText)));
    expect(rest[0]).toBe("-p");
    expect(rest.at(-1)).toBe("--no-session-persistence");
    for (const a of rest) expect(a).not.toMatch(/[\r\n]/);
  });

  it("prefers ComSpec when absolute", async () => {
    const h = harness("win32", ["C:\\a\\claude.cmd"], {
      Path: "C:\\a",
      ComSpec: "D:\\sys\\cmd.exe",
    });
    const p = h.run();
    h.child.emit("close", 1);
    await p;
    expect(h.calls[0]?.command).toBe("D:\\sys\\cmd.exe");
  });

  it("refuses a CR or LF in an argv element on the cmd route", async () => {
    const h = harness("win32", ["C:\\a\\claude.cmd"], { Path: "C:\\a" });
    const out = await h.run({ pluginRoot: "C:\\x\ny", dataDir: join(root, "data") });
    expect(out).toStrictEqual({ ok: false, code: "headless_failed", exit: null });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("cmdLine", () => {
  it.each(["a\nb", "a\rb", "a\0b"])("rejects %j", (bad) => {
    expect(cmdLine("C:\\c.cmd", ["ok", bad])).toBeNull();
    expect(cmdLine(bad, ["ok"])).toBeNull();
  });

  it("rejects a line over the length limit", () => {
    expect(cmdLine("C:\\c.cmd", ["x".repeat(9000)])).toBeNull();
  });

  it("round-trips hard arguments through the decoder", () => {
    const args = [
      "",
      "plain",
      "with space",
      'say "hi"',
      "back\\",
      'back\\\\"q',
      "%PATH% !x! ^ & | < > ( )",
      "a,b;c=d",
      '{"k":["v"]}',
      "--flag",
    ];
    const line = cmdLine("C:\\p q\\claude.cmd", args);
    expect(decode(line ?? "")).toStrictEqual(["C:\\p q\\claude.cmd", ...args]);
  });
});

/**
 * Test decoder: cmd.exe removes one level of carets (the command token), the npm shim's `%*`
 * expansion removes a second level from the arguments, then the C runtime splits them.
 */
function decode(line: string): string[] {
  let i = 0;
  let command = "";
  while (i < line.length && line[i] !== " ") {
    if (line[i] === "^") i++;
    command += line[i++];
  }
  const rest = line.slice(i + 1);
  const dropCarets = (s: string) => s.replace(/\^(.)/gs, "$1");
  const text = dropCarets(dropCarets(rest));
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k] as string;
    if (c === "\\") {
      let n = 0;
      while (text[k] === "\\") {
        n++;
        k++;
      }
      if (text[k] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQuote = !inQuote;
      } else {
        cur += "\\".repeat(n);
        k--;
      }
      started = true;
    } else if (c === '"') {
      inQuote = !inQuote;
      started = true;
    } else if (c === " " && !inQuote) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return [command, ...out];
}
