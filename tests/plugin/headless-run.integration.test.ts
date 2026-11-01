import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "../../plugin/scripts/lib/headless.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";
import { type FakeScript, installFakeClaude } from "./helpers/fake-claude.js";

const root = mkdtempSync(join(tmpdir(), "headless-run-"));
const dataDir = join(root, "data");
mkdirSync(dataDir);
const emptyHome = join(root, "home");
mkdirSync(emptyHome);
const paths = { pluginRoot: join(process.cwd(), "plugin"), dataDir };
const settings = readSettings({});

const good = {
  status: "saved",
  session_note: "work/sessions/2026-01-01-example.md",
  recipes: ["work/recipes/example.md"],
  people_updated: [],
  already_saved: false,
  detail: "ok",
};
const MARKER = "text-that-must-not-leak-4f9a";

function run(script: FakeScript, input = "input", extra: Parameters<typeof runCapture>[1] = {}) {
  const fake = installFakeClaude(script);
  const done = runCapture({ settings, env: fake.env, paths, input }, { home: emptyHome, ...extra });
  return { fake, done };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
  } catch {
    // no /proc: trust kill(pid, 0)
  }
  return true;
}

describe("runCapture", () => {
  it("sends the input on stdin byte for byte and nothing in argv", async () => {
    const input = "LINE-ONE-m1\nLINE-TWO-m2 é中\r\n\nLINE-THREE-m3";
    const { fake, done } = run({ result: good }, input);
    const out = await done;
    expect(out).toStrictEqual({ ok: true, result: good });
    const [rec] = fake.runs();
    expect(rec?.stdin).toBe(input);
    for (const m of ["LINE-ONE-m1", "LINE-TWO-m2", "LINE-THREE-m3"]) {
      expect(rec?.argv.some((a) => a.includes(m))).toBe(false);
    }
    expect(rec?.argv[0]).toBe("-p");
    expect(rec?.env.TWOBRAIN_CAPTURE).toBe("1");
  });

  it("returns a fresh object holding only the schema keys", async () => {
    const out = await run({ result: good }).done;
    expect(out.ok && Object.keys(out.result).sort()).toStrictEqual(Object.keys(good).sort());
  });

  const bad: [string, FakeScript, number][] = [
    ["exit 1", { exit: 1, result: good }, 1],
    ["exit 3 with text", { exit: 3, stdout: MARKER }, 3],
    ["non-JSON stdout", { stdout: MARKER }, 0],
    ["no structured_output", { stdout: JSON.stringify({ note: MARKER }) }, 0],
    ["array output", { stdout: "[]" }, 0],
    ["extra key", { result: { ...good, extra: MARKER } }, 0],
    ["missing key", { result: { ...good, detail: undefined } }, 0],
    ["bad detail", { result: { ...good, detail: "Secret Text" } }, 0],
    ["long detail", { result: { ...good, detail: "a".repeat(121) } }, 0],
    ["bad status", { result: { ...good, status: MARKER } }, 0],
    ["non-boolean already_saved", { result: { ...good, already_saved: "no" } }, 0],
    ["control char in path", { result: { ...good, session_note: "a\u0000b" } }, 0],
    ["empty path", { result: { ...good, recipes: [""] } }, 0],
    ["too many paths", { result: { ...good, people_updated: Array(51).fill("a.md") } }, 0],
    ["string output", { result: MARKER }, 0],
  ];
  it.each(bad)("%s gives headless_failed with the real exit", async (_n, script, exit) => {
    const out = await run(script).done;
    expect(out).toStrictEqual({ ok: false, code: "headless_failed", exit });
    expect(JSON.stringify(out)).not.toContain(MARKER);
  });

  it("answers headless_failed when stdout is over the cap", async () => {
    const out = await run({ stdout: "x".repeat(1024 * 1024 + 10) }).done;
    expect(out).toMatchObject({ ok: false, code: "headless_failed" });
  });

  it("survives a fake that never reads stdin and exits 1", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", on);
    process.on("unhandledRejection", on);
    try {
      const out = await run({ skipStdin: true, exit: 1 }, "x".repeat(2_000_000)).done;
      await new Promise((r) => setTimeout(r, 100));
      expect(out).toStrictEqual({ ok: false, code: "headless_failed", exit: 1 });
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("uncaughtException", on);
      process.off("unhandledRejection", on);
    }
  });

  it("kills the whole tree on timeout", async () => {
    let pids: { pid: number; grandchildPid: number | null } | undefined;
    let out: unknown;
    for (let attempt = 0; attempt < 3 && !pids?.grandchildPid; attempt++) {
      const { fake, done } = run({ hang: true, spawnGrandchild: true }, "in", { timeoutMs: 1000 });
      out = await done;
      pids = fake.runs()[0];
    }
    expect(out).toStrictEqual({ ok: false, code: "timeout" });
    const { pid, grandchildPid } = pids ?? { pid: 0, grandchildPid: null };
    expect(pid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (alive(pid) || alive(grandchildPid as number))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(alive(pid)).toBe(false);
    expect(alive(grandchildPid as number)).toBe(false);
  });

  it("returns api_helper_present without running claude", async () => {
    const home = mkdtempSync(join(root, "home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), '{"apiKeyHelper":"x"}');
    const fake = installFakeClaude({ result: good });
    const out = await runCapture({ settings, env: fake.env, paths, input: "i" }, { home });
    expect(out).toStrictEqual({ ok: false, code: "api_helper_present" });
    expect(fake.runs()).toHaveLength(0);
  });

  it("returns claude_not_found for an empty PATH dir and no spawn", async () => {
    const empty = mkdtempSync(join(root, "empty-"));
    const out = await runCapture(
      { settings, env: { PATH: empty }, paths, input: "i" },
      { home: emptyHome },
    );
    expect(out).toStrictEqual({ ok: false, code: "claude_not_found" });
  });

  it("returns not_configured for an invalid model", async () => {
    const out = await runCapture(
      { settings: { ...settings, model: "a;b" }, env: {}, paths, input: "i" },
      { home: emptyHome },
    );
    expect(out).toStrictEqual({ ok: false, code: "not_configured" });
  });

  it("returns headless_failed, not claude_not_found, when the data dir is missing", async () => {
    const fake = installFakeClaude({ result: good });
    const out = await runCapture(
      { settings, env: fake.env, paths: { ...paths, dataDir: join(root, "nope") }, input: "i" },
      { home: emptyHome },
    );
    expect(out).toStrictEqual({ ok: false, code: "headless_failed", exit: null });
  });

  it("returns claude_not_found when the found file cannot be executed (spawn ENOENT)", async () => {
    const fake = installFakeClaude({ result: good });
    writeFileSync(join(fake.binDir, "claude"), "#!/nonexistent/interpreter\n");
    const out = await runCapture(
      { settings, env: fake.env, paths, input: "i" },
      { home: emptyHome },
    );
    expect(out).toStrictEqual({ ok: false, code: "claude_not_found" });
  });

  it("resolves a relative CLAUDE_CONFIG_DIR against the data dir", async () => {
    const data = mkdtempSync(join(root, "data-"));
    mkdirSync(join(data, "rel"));
    writeFileSync(join(data, "rel", "settings.json"), '{"apiKeyHelper":"x"}');
    const fake = installFakeClaude({ result: good });
    const out = await runCapture(
      {
        settings,
        env: { ...fake.env, CLAUDE_CONFIG_DIR: "rel" },
        paths: { ...paths, dataDir: data },
        input: "i",
      },
      { home: emptyHome },
    );
    expect(out).toStrictEqual({ ok: false, code: "api_helper_present" });
    expect(fake.runs()).toHaveLength(0);
  });
});
