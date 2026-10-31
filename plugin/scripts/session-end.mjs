import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLog } from "./lib/log.mjs";
import { createQueue } from "./lib/queue.mjs";
import { readSettings } from "./lib/settings.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUIRED = ["session_id", "transcript_path", "cwd"];

/**
 * @typedef {object} HookDeps
 * @property {typeof nodeSpawn} [spawn]
 * @property {(event: Record<string, unknown>, options?: { area?: string }) => unknown} [enqueue]
 * @property {(sessionId: unknown, code: string) => void} [log]
 */

/**
 * SessionEnd hook: store one job, start the worker detached, stay silent, exit 0.
 *
 * @param {string} stdinText
 * @param {Record<string, string | undefined>} env
 * @param {HookDeps} [deps]
 * @returns {0}
 */
export function runHook(stdinText, env, deps = {}) {
  if (env.TWOBRAIN_CAPTURE === "1") return 0;
  /** @type {unknown} */
  let sessionId;
  /** @type {HookDeps["log"]} */
  let log = deps.log;
  try {
    const settings = readSettings(env);
    if (!settings.enabled) return 0;
    const dataDir = env.CLAUDE_PLUGIN_DATA;
    if (!dataDir || !isAbsolute(dataDir)) return 0;
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
    }
    const dflt = createLog({ dataDir, now: Date.now }).log;
    log ??= dflt;
    const enqueue = deps.enqueue ?? createQueue({ dataDir, now: Date.now, log: dflt }).enqueue;
    const doSpawn = deps.spawn ?? nodeSpawn;

    /** @type {unknown} */
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      event = undefined;
    }
    const obj = /** @type {Record<string, unknown>} */ (event);
    const valid =
      typeof event === "object" &&
      event !== null &&
      REQUIRED.every((k) => typeof obj[k] === "string" && obj[k] !== "") &&
      SESSION_ID.test(/** @type {string} */ (obj.session_id));
    if (!valid) {
      log(undefined, "invalid_input");
      return 0;
    }
    sessionId = obj.session_id;

    const fromEnv = (env.TWOBRAIN_AREA ?? "").trim();
    const area = fromEnv !== "" ? fromEnv : settings.area.trim();
    enqueue(obj, { area });

    const failLog = log;
    const child = doSpawn(
      process.execPath,
      [join(SCRIPTS_DIR, "capture-worker.mjs"), join(dataDir, "queue")],
      { detached: true, stdio: "ignore", shell: false, windowsHide: true, env },
    );
    child.on("error", () => {
      try {
        failLog(sessionId, "hook_error");
      } catch {
        // nothing more can be done silently
      }
    });
    child.unref();
  } catch {
    try {
      log?.(sessionId, "hook_error");
    } catch {
      // logging is best effort
    }
  }
  return 0;
}

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** @returns {boolean} */
function isMain() {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = runHook(await readStdin(), process.env);
  } catch {
    process.exitCode = 0;
  }
}
