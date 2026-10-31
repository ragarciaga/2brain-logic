import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const PROGRESS_HEADER = "--- progress.md (first 20,000 characters) ---";

const MAX_CHARS = 20000;
// Four bytes is the longest UTF-8 sequence, so this many bytes always hold MAX_CHARS code points.
const MAX_BYTES = MAX_CHARS * 4;

/**
 * Reads the project's progress file for the capture request. Read-only, bounded to MAX_BYTES, and
 * only when the file's real path is a regular file inside the real path of `cwd`.
 * Returns the header line, a newline and the first 20,000 code points, or null for anything else.
 * Never throws.
 *
 * @param {unknown} cwd
 * @returns {string | null}
 */
export function readProgress(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  try {
    const root = realpathSync(cwd);
    const target = realpathSync(join(cwd, "docs", "progress.md"));
    const rel = relative(root, target);
    if (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel)) return null;
    if (!statSync(target).isFile()) return null;
    return `${PROGRESS_HEADER}\n${firstCodePoints(readBounded(target))}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function readBounded(path) {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buf = Buffer.alloc(MAX_BYTES);
    let total = 0;
    while (total < MAX_BYTES) {
      const n = readSync(fd, buf, total, MAX_BYTES - total, null);
      if (n === 0) break;
      total += n;
    }
    return buf.toString("utf8", 0, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstCodePoints(text) {
  let count = 0;
  let end = 0;
  for (const ch of text) {
    if (count === MAX_CHARS) break;
    count++;
    end += ch.length;
  }
  return text.slice(0, end);
}
