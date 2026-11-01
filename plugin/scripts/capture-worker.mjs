import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDigest } from "./lib/digest.mjs";
import { runCapture } from "./lib/headless.mjs";
import { buildInput, NOT_CONFIGURED, resolveArea } from "./lib/input.mjs";
import { createLog } from "./lib/log.mjs";
import { readProgress } from "./lib/progress.mjs";
import { createQueue } from "./lib/queue.mjs";
import { readSettings } from "./lib/settings.mjs";
import { decide, readState, recordCapture } from "./lib/state.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DETAIL = /^[a-z0-9_ =.,:-]{0,120}$/;
const CONTROL = /\p{Cc}/u;

/**
 * True for a vault-relative note path that is safe to show: 1 to 300 characters, no control
 * character or backslash, not absolute, ends with .md, no empty, "." or ".." segment.
 * @param {unknown} v
 * @returns {v is string}
 */
function isNotePath(v) {
  if (typeof v !== "string" || v.length < 1 || v.length > 300) return false;
  if (CONTROL.test(v) || v.includes("\\")) return false;
  if (v.startsWith("/") || /^[A-Za-z]:/.test(v)) return false;
  if (!v.endsWith(".md")) return false;
  return v.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
/**
 * Reads the transcript through a descriptor: no blocking open, no followed symlink, and the open
 * file must be a regular file.
 * @param {string} path
 * @returns {string}
 */
function readRegular(path) {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The env of the capture run: no TWOBRAIN_AREA (any letter case on win32), so the child never
 * sees an area other than the one of the job.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
function withoutArea(env) {
  const win = process.platform === "win32";
  /** @type {Record<string, string | undefined>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "__proto__") continue;
    if ((win ? key.toUpperCase() : key) === "TWOBRAIN_AREA") continue;
    out[key] = value;
  }
  return out;
}

const POLL_MS = 250;
const SETTLE_MS = 2000;
const MAX_WAIT_MS = 10000;

/**
 * @typedef {object} WorkerDeps
 * @property {string} dataDir
 * @property {string} pluginRoot
 * @property {import("./lib/settings.mjs").Settings} settings
 * @property {Record<string, string | undefined>} env
 * @property {() => number} now epoch ms
 * @property {(ms: number) => Promise<void>} sleep
 * @property {{ stat?: (path: string) => { size: number, isFile: () => boolean }, readFile?: (path: string) => string }} [fs]
 * @property {(job: {
 *   settings: import("./lib/settings.mjs").Settings,
 *   env: Record<string, string | undefined>,
 *   paths: { pluginRoot: string, dataDir: string },
 *   input: string,
 * }) => Promise<import("./lib/headless.mjs").CaptureOutcome>} [runner]
 * @property {ReturnType<typeof createQueue>} [queue]
 * @property {(sessionId: unknown, code: string, fields?: Record<string, unknown>) => void} [log]
 */

/**
 * Settle wait: the transcript is read once its size has not changed for 2 s, or after 10 s.
 * Returns false when the file is gone or is not a regular file.
 *
 * @param {string} path
 * @param {{ stat: (path: string) => { size: number, isFile: () => boolean } }} fs
 * @param {() => number} now
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<boolean>}
 */
async function settle(path, fs, now, sleep) {
  const start = now();
  let st = fs.stat(path);
  if (!st.isFile()) return false;
  let size = st.size;
  let stableSince = now();
  while (now() - stableSince < SETTLE_MS && now() - start < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    st = fs.stat(path);
    if (!st.isFile()) return false;
    if (st.size !== size) {
      size = st.size;
      stableSince = now();
    }
  }
  return true;
}

/**
 * Handles every queued job, oldest first. Writes nothing to stdout or stderr; the log lines carry
 * codes only. An exception inside one job leaves that job in the queue and moves on.
 *
 * @param {WorkerDeps} deps
 * @returns {Promise<void>}
 */
export async function runWorker(deps) {
  const { dataDir, pluginRoot, settings, env, now, sleep } = deps;
  const fs = {
    stat: deps.fs?.stat ?? ((/** @type {string} */ p) => lstatSync(p)),
    readFile: deps.fs?.readFile ?? readRegular,
  };
  const runner = deps.runner ?? runCapture;
  const log = deps.log ?? createLog({ dataDir, now }).log;
  const queue = deps.queue ?? createQueue({ dataDir, now, log });

  /** @type {(sessionId: unknown, code: string, fields?: Record<string, unknown>) => void} */
  const safeLog = (sessionId, code, fields) => {
    try {
      log(sessionId, code, fields);
    } catch {
      // logging is best effort
    }
  };

  /**
   * Acts on a validated result. The detail and the paths of the model are only shown in the log,
   * never passed to the file system, the state or the queue.
   * @param {ReturnType<typeof queue.list>[number]} job
   * @param {string} sessionId
   * @param {import("./lib/headless.mjs").CaptureResult} result
   * @param {{ part: number }} decision
   * @param {number} prompts
   * @param {string | null} lineage
   */
  const handleResult = (job, sessionId, result, decision, prompts, lineage) => {
    if (typeof result.detail !== "string" || !DETAIL.test(result.detail)) {
      safeLog(sessionId, "invalid_detail");
      queue.recordAttempt(job);
      return;
    }
    const notes = [result.session_note, ...result.people_updated].filter(isNotePath);
    const recipes = result.recipes.filter(isNotePath).length;
    const record = (/** @type {number} */ part) => {
      recordCapture(dataDir, { sessionId, lineage, userPrompts: prompts, part }, now());
      queue.remove(job);
    };
    if (result.status === "saved") {
      record(decision.part);
      if (result.already_saved) safeLog(sessionId, "already_saved", { notes });
      else safeLog(sessionId, "saved", { notes, recipes });
    } else if (result.status === "nothing_to_save") {
      record(decision.part - 1);
      safeLog(sessionId, "nothing_to_save");
    } else if (
      result.status === "failed" ||
      result.status === "mcp_unavailable" ||
      result.status === "session_type_missing"
    ) {
      safeLog(sessionId, result.status);
      queue.recordAttempt(job);
    } else {
      safeLog(sessionId, "headless_failed");
      queue.recordAttempt(job);
    }
  };

  queue.sweep();
  const jobs = queue.list();
  let lastTrigger = -1;
  jobs.forEach((j, i) => {
    if (j.data.event.reason !== "logout") lastTrigger = i;
  });
  for (const [i, job] of jobs.entries()) {
    const event = job.data.event;
    const sessionId = event.session_id;
    try {
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
        safeLog(undefined, "invalid_field");
        queue.remove(job);
        continue;
      }
      // a logout job waits until a newer job of another kind is queued
      if (event.reason === "logout" && i > lastTrigger) continue;
      const area = resolveArea(
        {},
        { area: typeof job.data.area === "string" ? job.data.area : "" },
      );
      if (area === NOT_CONFIGURED) {
        safeLog(sessionId, "not_configured");
        continue;
      }
      const path = event.transcript_path;
      let lines = null;
      if (typeof path === "string" && isAbsolute(path)) {
        try {
          if (await settle(path, fs, now, sleep)) lines = fs.readFile(path).split("\n");
        } catch {
          lines = null;
        }
      }
      if (lines === null) {
        safeLog(sessionId, "transcript_missing");
        queue.remove(job);
        continue;
      }
      let digest = buildDigest(lines);
      if (digest.userPrompts < settings.min_user_prompts) {
        safeLog(sessionId, "skipped_trivial");
        queue.remove(job);
        continue;
      }
      const decision = decide(readState(dataDir), {
        sessionId,
        lineage: digest.lineage,
        userPrompts: digest.userPrompts,
        minUserPrompts: settings.min_user_prompts,
      });
      if (decision.action === "skipped_duplicate") {
        safeLog(sessionId, "skipped_duplicate");
        queue.remove(job);
        continue;
      }
      const prompts = digest.userPrompts;
      const lineage = digest.lineage;
      if (decision.fromPrompt > 0) digest = buildDigest(lines, { fromPrompt: decision.fromPrompt });
      const cwd = event.cwd;
      const progress = readProgress(cwd);
      /** @type {string} */
      let input;
      try {
        input = buildInput({
          area,
          language: settings.note_language,
          lastDate: digest.lastDate,
          cwd: cwd ?? "",
          sessionId: decision.idForName,
          sourceId: decision.sourceId,
          part: decision.part,
          progress,
          digest: digest.text,
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("invalid_field:")) {
          safeLog(sessionId, "invalid_field");
          queue.remove(job);
          continue;
        }
        throw err;
      }
      const outcome = await runner({
        settings,
        env: withoutArea(env),
        paths: { pluginRoot, dataDir },
        input,
      });
      if (outcome.ok) {
        handleResult(job, sessionId, outcome.result, decision, prompts, lineage);
      } else if (outcome.code === "api_helper_present") {
        safeLog(sessionId, outcome.code);
        queue.remove(job);
      } else if (outcome.code === "not_configured") {
        safeLog(sessionId, outcome.code);
      } else if (outcome.code === "headless_failed") {
        safeLog(sessionId, outcome.code, { exit: outcome.exit });
        queue.recordAttempt(job);
      } else {
        safeLog(sessionId, outcome.code);
        queue.recordAttempt(job);
      }
    } catch {
      safeLog(sessionId, "worker_error");
    }
  }
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
    const queueDir = process.argv[2];
    if (queueDir && isAbsolute(queueDir) && basename(queueDir) === "queue") {
      await runWorker({
        dataDir: dirname(queueDir),
        pluginRoot: resolve(SCRIPTS_DIR, ".."),
        settings: readSettings(process.env),
        env: process.env,
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    }
  } catch {
    // silent by design
  }
  process.exitCode = 0;
}
