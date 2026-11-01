import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FakeRun, installFakeClaude } from "../plugin/helpers/fake-claude.js";

export interface PluginRun extends FakeRun {
  ppid: number;
  firedHook?: { exit: number | null; stdout: string; stderr: string; queue: string[] };
}

export interface ParentResult {
  exit: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  hookPid: number;
  parentPid: number;
  jobs: string[];
  exitedAt: number;
}

export interface SnapshotEntry {
  path: string;
  bytes: string;
  mtimeMs: number;
}

/** Runs inside the parent process: starts the real hook, records what it did, exits at once. */
const PARENT_SCRIPT = `
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
const { argv, event, queueDir } = JSON.parse(process.env.PARENT_INPUT);
const t0 = Date.now();
const child = spawn(process.execPath, argv, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: process.env });
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => { stdout += c; });
child.stderr.on("data", (c) => { stderr += c; });
child.stdin.end(JSON.stringify(event));
child.on("exit", (code) => {
  const exitedAt = Date.now();
  let jobs = [];
  try { jobs = readdirSync(queueDir).filter((f) => f.endsWith(".json")); } catch {}
  process.stdout.write(JSON.stringify({ exit: code, elapsedMs: exitedAt - t0, stdout, stderr, hookPid: child.pid, parentPid: process.pid, jobs, exitedAt }), () => process.exit(0));
});
`;

export function makePluginFixture() {
  const root = mkdtempSync(join(tmpdir(), "hook-worker-"));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "progress.md"), "# Progress\n\n- step one\n");
  const transcriptPath = join(root, "transcript.jsonl");
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: `u-${i}`,
        timestamp: "2026-10-31T10:00:00Z",
        message: { role: "user", content: `PROMPT-${i}` },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: `a-${i}`,
        timestamp: "2026-10-31T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: `ANSWER-${i}` }] },
      }),
    );
  }
  writeFileSync(transcriptPath, lines.join("\n"));

  const saved = {
    status: "saved",
    session_note: "work/sessions/2026-10-31-example.md",
    recipes: [],
    people_updated: [],
    already_saved: false,
    detail: "ok",
  };
  const fake = installFakeClaude({ result: saved, sleepMs: 3000 });
  const pluginRoot = resolve("plugin");
  const env: Record<string, string> = {
    ...fake.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    TWOBRAIN_AREA: "work",
  };
  const event = {
    session_id: "e2e-session-01",
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "SessionEnd",
    reason: "other",
  };

  function hookArgv(): string[] {
    const cfg = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
    const entry = cfg.hooks.SessionEnd[0].hooks[0];
    if (entry.command !== "node") throw new Error(`unexpected hook command ${entry.command}`);
    return (entry.args as string[]).map((a) =>
      a.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginRoot),
    );
  }

  function runParent(
    ev: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
  ): ParentResult {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PARENT_SCRIPT], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: {
        ...env,
        ...extraEnv,
        PARENT_INPUT: JSON.stringify({
          argv: hookArgv(),
          event: ev,
          queueDir: join(dataDir, "queue"),
        }),
      },
    });
    if (r.status !== 0) throw new Error(`parent failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as ParentResult;
  }

  function snapshot(dir: string): SnapshotEntry[] {
    const out: SnapshotEntry[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else
          out.push({
            path: p,
            bytes: readFileSync(p).toString("base64"),
            mtimeMs: st.mtimeMs,
          });
      }
    };
    walk(dir);
    return out;
  }

  async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pred();
  }

  function pidGone(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  const logLines = (): string[] => {
    try {
      return readFileSync(join(dataDir, "logs", "capture.log"), "utf8")
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const queueJobs = (): string[] => {
    try {
      return readdirSync(join(dataDir, "queue")).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  };
  const state = () => JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  const runs = () => fake.runs() as PluginRun[];

  async function cleanup(): Promise<void> {
    const ppids = runs().map((r) => r.ppid);
    await waitFor(() => ppids.every(pidGone), 15000);
    rmSync(root, { recursive: true, force: true });
    rmSync(resolve(fake.binDir, ".."), { recursive: true, force: true });
  }

  return {
    root,
    dataDir,
    cwd,
    event,
    env,
    fake,
    hookArgv,
    runParent,
    snapshot,
    waitFor,
    pidGone,
    logLines,
    queueJobs,
    state,
    runs,
    cleanup,
  };
}
