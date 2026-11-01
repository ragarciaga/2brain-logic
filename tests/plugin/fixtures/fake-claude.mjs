// Shared fake `claude` for the plugin tests. The test installs it as an executable named
// `claude` in a temp dir that is the only PATH entry, so the real binary is never reachable.
// FAKE_CLAUDE_SCRIPT names a JSON file: { result, exit, stdout, sleepMs, hang, skipStdin,
// spawnGrandchild }. FAKE_CLAUDE_RECORD names a directory that receives run-<pid>.json.
// The record also holds `ppid` (the pid of the process that started the fake, the worker).
// FAKE_CLAUDE_FIRE_HOOK names a JSON file { hook, event }: after reading stdin the fake runs
// that hook script with the fake's own env (so it sees whatever the worker set, such as
// TWOBRAIN_CAPTURE), writes the event to its stdin and records { exit, stdout, stderr, queue }
// in `firedHook`, where `queue` lists the .json files in CLAUDE_PLUGIN_DATA/queue.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const recordDir = process.env.FAKE_CLAUDE_RECORD;
/** @type {Record<string, any>} */
const script = scriptFile ? JSON.parse(readFileSync(scriptFile, "utf8")) : {};
/** @type {{ argv: string[], env: Record<string, any>, pid: number, ppid: number, grandchildPid: number | null, firedHook?: { exit: number | null, stdout: string, stderr: string, queue: string[] }, stdin: string | null, start: number, end: number | null }} */
const record = {
  argv: process.argv.slice(2),
  env: { ...process.env },
  pid: process.pid,
  ppid: process.ppid,
  grandchildPid: null,
  stdin: null,
  start: Date.now(),
  end: null,
};

function save() {
  if (!recordDir) return;
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, `run-${process.pid}.json`), JSON.stringify(record));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (script.spawnGrandchild) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  record.grandchildPid = grandchild.pid ?? null;
}
save();

if (!script.skipStdin) record.stdin = await readStdin();
if (process.env.FAKE_CLAUDE_FIRE_HOOK) {
  const { hook, event } = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_FIRE_HOOK, "utf8"));
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  /** @type {string[]} */
  let queue = [];
  try {
    queue = readdirSync(join(process.env.CLAUDE_PLUGIN_DATA ?? "", "queue")).filter((f) =>
      f.endsWith(".json"),
    );
  } catch {
    // no queue directory
  }
  record.firedHook = { exit: r.status, stdout: r.stdout, stderr: r.stderr, queue };
  save();
}
if (script.sleepMs) await new Promise((resolve) => setTimeout(resolve, script.sleepMs));
save();
if (script.hang) setInterval(() => {}, 1000);
else {
  record.end = Date.now();
  save();
  const out =
    script.stdout !== undefined
      ? script.stdout
      : JSON.stringify({ type: "result", structured_output: script.result });
  process.stdout.write(out, () => process.exit(script.exit ?? 0));
}
