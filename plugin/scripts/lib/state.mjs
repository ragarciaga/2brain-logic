import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86400000;
const TTL_MS = 180 * DAY_MS;

/**
 * @typedef {object} Entry
 * @property {string | null} lineage
 * @property {number} prompts user prompts covered by the captures so far
 * @property {number} parts parts captured so far
 * @property {string} capturedAt ISO timestamp
 */

/**
 * @typedef {object} StateFile
 * @property {1} version
 * @property {Record<string, Entry>} sessions keyed by the first session id of a lineage
 */

/**
 * @typedef {{ action: "skipped_duplicate" }
 *   | { action: "capture", part: number, sourceId: string, idForName: string, fromPrompt: number }
 * } Decision
 */

/** @returns {StateFile} */
function emptyState() {
  return { version: 1, sessions: {} };
}

/**
 * @param {unknown} v
 * @returns {v is Entry}
 */
function isEntry(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  return (
    Number.isInteger(o.prompts) &&
    /** @type {number} */ (o.prompts) >= 0 &&
    Number.isInteger(o.parts) &&
    /** @type {number} */ (o.parts) >= 0 &&
    (o.lineage === null || typeof o.lineage === "string") &&
    typeof o.capturedAt === "string" &&
    !Number.isNaN(Date.parse(o.capturedAt))
  );
}

/**
 * Read `<dataDir>/state.json`. A missing, unreadable, invalid or wrong-version
 * file gives an empty state; invalid entries are dropped. Never throws.
 *
 * @param {string} dataDir
 * @returns {StateFile}
 */
export function readState(dataDir) {
  const state = emptyState();
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
    if (typeof raw !== "object" || raw === null || raw.version !== 1) return state;
    const sessions = raw.sessions;
    if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) {
      return state;
    }
    for (const [key, value] of Object.entries(sessions)) {
      if (!SESSION_ID.test(key) || !isEntry(value)) continue;
      state.sessions[key] = {
        lineage: value.lineage,
        prompts: value.prompts,
        parts: value.parts,
        capturedAt: value.capturedAt,
      };
    }
  } catch {
    return emptyState();
  }
  return state;
}

/**
 * The entry of a session id, else the first entry of the same non-empty lineage.
 *
 * @param {StateFile} state
 * @param {string} sessionId
 * @param {string | null | undefined} lineage
 * @returns {string | null} key of the entry
 */
function findEntry(state, sessionId, lineage) {
  if (Object.hasOwn(state.sessions, sessionId)) return sessionId;
  if (typeof lineage === "string" && lineage !== "") {
    for (const [key, entry] of Object.entries(state.sessions)) {
      if (entry.lineage === lineage) return key;
    }
  }
  return null;
}

/**
 * Decide whether a session is captured, and as which part. Pure.
 *
 * @param {StateFile} state
 * @param {{
 *   sessionId: string,
 *   lineage: string | null,
 *   userPrompts: number,
 *   minUserPrompts: number,
 * }} input
 * @returns {Decision}
 */
export function decide(state, { sessionId, lineage, userPrompts, minUserPrompts }) {
  const key = findEntry(state, sessionId, lineage);
  if (key === null) {
    return {
      action: "capture",
      part: 1,
      sourceId: `claude-code:${sessionId}`,
      idForName: sessionId,
      fromPrompt: 0,
    };
  }
  const entry = state.sessions[key];
  if (userPrompts - entry.prompts < minUserPrompts) return { action: "skipped_duplicate" };
  const part = entry.parts + 1;
  return {
    action: "capture",
    part,
    // part 1 keeps the plain source id, also after a nothing_to_save recorded parts: 0
    sourceId: part === 1 ? `claude-code:${key}` : `claude-code:${key}:${part}`,
    idForName: key,
    fromPrompt: entry.prompts,
  };
}

/**
 * Record a capture in `<dataDir>/state.json` (atomic, mode 0600) and prune
 * entries older than 180 days. Stores ids, counts and dates only.
 *
 * @param {string} dataDir
 * @param {{
 *   sessionId: string,
 *   lineage: string | null,
 *   userPrompts: number,
 *   part: number,
 * }} input
 * @param {number} now epoch ms
 */
export function recordCapture(dataDir, { sessionId, lineage, userPrompts, part }, now) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new TypeError("invalid session id");
  }
  const state = readState(dataDir);
  const key = findEntry(state, sessionId, lineage) ?? sessionId;
  const previous = state.sessions[key]?.lineage ?? null;
  const own = typeof lineage === "string" && lineage !== "" ? lineage : null;
  state.sessions[key] = {
    lineage: own ?? previous,
    prompts: userPrompts,
    parts: part,
    capturedAt: new Date(now).toISOString(),
  };
  for (const [k, entry] of Object.entries(state.sessions)) {
    if (Date.parse(entry.capturedAt) < now - TTL_MS) delete state.sessions[k];
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = join(dataDir, `state.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "w" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(dataDir, "state.json"));
}
