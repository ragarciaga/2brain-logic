import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86400000;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 7 * DAY_MS;
const FAILED_TTL_MS = 30 * DAY_MS;
const EVENT_KEYS = ["session_id", "transcript_path", "cwd", "hook_event_name", "reason"];

/**
 * Create a directory that is private and usable whatever the umask is.
 * @param {string} path
 */
function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * @typedef {object} JobFile
 * @property {1} version
 * @property {Record<string, string>} event
 * @property {number} attempts
 * @property {string} createdAt ISO timestamp
 * @property {string} [area] area resolved when the job was stored
 */

/**
 * @typedef {object} Job
 * @property {string} name file name inside queue/
 * @property {JobFile} data
 */

/**
 * @param {unknown} v
 * @returns {v is JobFile}
 */
function isJobFile(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  return (
    o.version === 1 &&
    typeof o.event === "object" &&
    o.event !== null &&
    Number.isInteger(o.attempts) &&
    typeof o.createdAt === "string" &&
    !Number.isNaN(Date.parse(o.createdAt))
  );
}

/**
 * Job store under the plugin data directory (queue/ and failed/).
 *
 * @param {{
 *   dataDir: string,
 *   now: () => number,
 *   log?: (sessionId: unknown, code: string, fields?: Record<string, unknown>) => void,
 * }} opts `now` returns epoch ms
 */
export function createQueue({ dataDir, now, log }) {
  const queueDir = join(dataDir, "queue");
  const failedDir = join(dataDir, "failed");

  /** @param {string} dir @param {string} name @param {JobFile} data */
  function writeAtomic(dir, name, data) {
    const tmp = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, name));
  }

  function ensureDirs() {
    privateDir(queueDir);
    privateDir(failedDir);
  }

  /** @returns {string[]} */
  function jobNames() {
    try {
      return readdirSync(queueDir).filter((n) => n.endsWith(".json"));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /** @param {string} name */
  function idFromName(name) {
    return name.replace(/^\d+-/, "").replace(/\.json$/, "");
  }

  /**
   * @param {Record<string, unknown>} event hook input
   * @param {{ area?: string }} [options] `area` is stored with the job when it is a string
   * @returns {Job}
   */
  function enqueue(event, options = {}) {
    const id = event?.session_id;
    if (typeof id !== "string" || !SESSION_ID.test(id)) {
      throw new TypeError("invalid session id");
    }
    /** @type {Record<string, string>} */
    const kept = {};
    for (const key of EVENT_KEYS) {
      const value = event[key];
      if (typeof value === "string") kept[key] = value;
    }
    ensureDirs();
    const t = now();
    const name = `${t}-${id}.json`;
    /** @type {JobFile} */
    const data = {
      version: 1,
      event: kept,
      attempts: 0,
      createdAt: new Date(t).toISOString(),
    };
    if (typeof options.area === "string") data.area = options.area;
    writeAtomic(queueDir, name, data);
    return { name, data };
  }

  /** @returns {Job[]} oldest first */
  function list() {
    /** @type {Job[]} */
    const jobs = [];
    for (const name of jobNames()) {
      try {
        const data = JSON.parse(readFileSync(join(queueDir, name), "utf8"));
        if (isJobFile(data)) jobs.push({ name, data });
      } catch {
        // unreadable or invalid: sweep() gives it up
      }
    }
    const epoch = (/** @type {string} */ n) => Number.parseInt(n, 10);
    jobs.sort(
      (a, b) => epoch(a.name) - epoch(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return jobs;
  }

  /**
   * @param {Job} job
   * @returns {Job}
   */
  function recordAttempt(job) {
    const data = { ...job.data, attempts: job.data.attempts + 1 };
    writeAtomic(queueDir, job.name, data);
    return { name: job.name, data };
  }

  /** @param {Job} job */
  function remove(job) {
    rmSync(join(queueDir, job.name), { force: true });
  }

  /** Give up exhausted, expired and invalid jobs; delete old failed/ files. */
  function sweep() {
    const t = now();
    for (const name of jobNames()) {
      const path = join(queueDir, name);
      let giveUp = false;
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        giveUp =
          !isJobFile(data) ||
          data.attempts >= MAX_ATTEMPTS ||
          t - Date.parse(data.createdAt) > MAX_AGE_MS;
      } catch {
        giveUp = true;
      }
      if (!giveUp) continue;
      privateDir(failedDir);
      const dest = join(failedDir, name);
      renameSync(path, dest);
      utimesSync(dest, t / 1000, t / 1000);
      log?.(idFromName(name), "gave_up");
    }
    /** @type {string[]} */
    let old = [];
    try {
      old = readdirSync(failedDir);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
        throw err;
      }
    }
    for (const name of old) {
      const path = join(failedDir, name);
      if (statSync(path).mtimeMs < t - FAILED_TTL_MS) {
        rmSync(path, { force: true });
      }
    }
  }

  return { enqueue, list, recordAttempt, remove, sweep };
}
