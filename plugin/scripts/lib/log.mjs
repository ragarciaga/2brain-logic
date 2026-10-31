import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[a-z_]+$/;
const MAX_BYTES = 1048576;

/**
 * Local capture log: one content-free line per event. Only a fixed allowlist of
 * fields is ever written (exit, notes, recipes); anything else is dropped.
 *
 * @param {{ dataDir: string, now: () => number }} opts `now` returns epoch ms
 * @returns {{ log: (sessionId: unknown, code: string, fields?: Record<string, unknown>) => void }}
 */
export function createLog({ dataDir, now }) {
  const dir = join(dataDir, "logs");
  const file = join(dir, "capture.log");

  /**
   * I/O errors propagate: callers log "if possible".
   * @param {unknown} sessionId
   * @param {string} code
   * @param {Record<string, unknown>} [fields]
   */
  function log(sessionId, code, fields = {}) {
    if (typeof code !== "string" || !CODE.test(code)) {
      throw new TypeError("invalid log code");
    }
    const id8 =
      typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessionId.slice(0, 8) : "-";
    const parts = [new Date(now()).toISOString(), id8, code];
    if (Number.isInteger(fields.exit)) {
      parts.push(`exit=${fields.exit}`);
    }
    if (Array.isArray(fields.notes) && fields.notes.every((n) => typeof n === "string")) {
      const joined = fields.notes.map((n) => n.replace(/\p{Cc}/gu, " ")).join(",");
      parts.push(`notes=${joined}`);
    }
    if (Number.isInteger(fields.recipes) && Number(fields.recipes) >= 0) {
      parts.push(`recipes=${fields.recipes}`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
        throw err;
      }
    }
    if (size >= MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${parts.join(" ")}\n`, { mode: 0o600 });
  }

  return { log };
}
