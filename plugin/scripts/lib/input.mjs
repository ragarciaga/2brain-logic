import { indent, LABEL_LINE, LINE_BREAK_ALL } from "./digest.mjs";
import { PROGRESS_HEADER } from "./progress.mjs";
import { preScrub } from "./scrub.mjs";

/** The area used when neither `TWOBRAIN_AREA` nor the `area` setting is set. */
export const NOT_CONFIGURED = "not_configured";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_ID = /^claude-code:[A-Za-z0-9_-]{1,128}(?::[1-9]\d{0,5})?$/;
const NAME_FORMAT = /\p{Cf}/gu;
const NAME_UNSAFE = /[^\p{L}\p{N} ._-]/gu;
const FIELD_UNSAFE = /[\p{Cc}\u2028\u2029]/u;
const PROJECT_MAX_BYTES = 120;
const SEPARATOR = "--- transcript digest ---";

/** @param {string} name */
function invalid(name) {
  return new Error(`invalid_field:${name}`);
}

/**
 * @param {unknown} part
 * @returns {part is number}
 */
function isPart(part) {
  return typeof part === "number" && Number.isSafeInteger(part) && part >= 1;
}

/**
 * First code points of `text` that fit in `maxBytes` of UTF-8, never splitting a code point.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function takeBytes(text, maxBytes) {
  let used = 0;
  let out = "";
  for (const ch of text) {
    used += Buffer.byteLength(ch, "utf8");
    if (used > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Last non-empty segment of a POSIX or Windows path, made safe for a file name: only letters,
 * digits, space, dot, underscore and hyphen survive (format characters are dropped, anything else
 * becomes "-"), spaces collapse, no "---" and no trailing dot or space remain, and the result is
 * at most 120 UTF-8 bytes.
 * @param {string} cwd
 * @returns {string}
 */
export function projectName(cwd) {
  const segments = String(cwd)
    .split(/[\\/]/)
    .filter((s) => s !== "");
  let name = (segments[segments.length - 1] ?? "")
    .replace(NAME_FORMAT, "")
    .replace(NAME_UNSAFE, "-")
    .replace(/ {2,}/g, " ");
  // The steps feed each other (the cut can expose a trailing blank, the replacement can join
  // dashes), so repeat until nothing changes.
  for (let prev = ""; prev !== name; ) {
    prev = name;
    name = takeBytes(name.replace(/-{3,}/g, "-"), PROJECT_MAX_BYTES).replace(/[. ]$/, "-");
  }
  return name === "" ? "project" : name;
}

/**
 * @param {{ lastDate: unknown, cwd: unknown, sessionId: unknown, part: unknown }} args
 * @returns {string}
 */
export function noteFileName({ lastDate, cwd, sessionId, part }) {
  if (typeof lastDate !== "string" || !DATE.test(lastDate)) throw invalid("lastDate");
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw invalid("sessionId");
  if (!isPart(part)) throw invalid("part");
  if (typeof cwd !== "string") throw invalid("cwd");
  const suffix = part >= 2 ? ` part ${part}` : "";
  return `${lastDate} ${projectName(cwd)} ${sessionId.slice(0, 8)}${suffix}.md`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ area?: string }} settings
 * @returns {string}
 */
export function resolveArea(env, settings) {
  const fromEnv = (env.TWOBRAIN_AREA ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const fromSetting = (settings.area ?? "").trim();
  return fromSetting !== "" ? fromSetting : NOT_CONFIGURED;
}

/**
 * A header value: single line, 1 to 64 characters, no `---`, no edge whitespace.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function headerValue(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    FIELD_UNSAFE.test(value) ||
    value.includes("---") ||
    value !== value.trim()
  ) {
    throw invalid(name);
  }
  return value;
}

/**
 * @param {string} text
 * @returns {string}
 */
function safeDigest(text) {
  return preScrub(text)
    .text.split(LINE_BREAK_ALL)
    .map((line) =>
      line !== "" && !LABEL_LINE.test(line) && !line.startsWith(" ") ? `  ${line}` : line,
    )
    .join("\n");
}

/**
 * Builds the plain-text CAPTURE REQUEST for the headless session. Header fields come only from
 * validated values; progress and digest are scrubbed and cannot start a line that looks like a
 * header, a separator or a label. Throws `Error("invalid_field:<name>")` for a bad field.
 * @param {{
 *   area: unknown, language: unknown, lastDate: unknown, cwd: unknown, sessionId: unknown,
 *   sourceId: unknown, part: unknown, progress: unknown, digest: unknown
 * }} args
 * @returns {string}
 */
export function buildInput({
  area,
  language,
  lastDate,
  cwd,
  sessionId,
  sourceId,
  part,
  progress,
  digest,
}) {
  const areaValue = headerValue(area, "area");
  const languageValue = headerValue(language, "language");
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) throw invalid("sourceId");
  const fileName = noteFileName({ lastDate, cwd, sessionId, part });
  const project = projectName(/** @type {string} */ (cwd));
  const lines = [
    "CAPTURE REQUEST",
    `area: ${areaValue}  language: ${languageValue}  date: ${lastDate}  project: ${project}`,
    `source_id: ${sourceId}  part: ${part}`,
    `note path: <session folder for area>/${fileName}`,
  ];
  if (typeof progress === "string") {
    const prefix = `${PROGRESS_HEADER}\n`;
    const body = progress.startsWith(prefix) ? progress.slice(prefix.length) : progress;
    lines.push(PROGRESS_HEADER, `  ${indent(preScrub(body).text)}`);
  }
  lines.push(SEPARATOR);
  const digestText = typeof digest === "string" ? safeDigest(digest) : "";
  if (digestText !== "") lines.push(digestText);
  return `${lines.join("\n")}\n`;
}
