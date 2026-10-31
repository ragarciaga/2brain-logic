/**
 * @typedef {object} DigestOptions
 * @property {number} [fromPrompt] counted prompts to skip at the start of `text`
 * @property {string} [timeZone] IANA zone for `lastDate` (default: the local zone)
 */

/**
 * @typedef {object} Digest
 * @property {string} text
 * @property {number} userPrompts
 * @property {string | null} lineage
 * @property {string | null} lastDate
 */

export const RESULT_CAP = 2000;
export const DIGEST_MAX = 150000;
export const HEAD = 30000;
export const TAIL = 120000;

const COMMAND_TAGS = ["<command-name>", "<local-command-stdout>", "<local-command-stderr>"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {number} code */
function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** @param {number} code */
function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * First `max` characters, never ending inside a surrogate pair.
 * @param {string} text
 * @param {number} max
 */
function takeStart(text, max) {
  if (text.length <= max) return text;
  const end = isHigh(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * Last `max` characters, never starting inside a surrogate pair.
 * @param {string} text
 * @param {number} max
 */
function takeEnd(text, max) {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isLow(text.charCodeAt(start)) ? start + 1 : start);
}

/**
 * Keeps the head and the tail of a long digest with one marker line between them.
 * @param {string} text
 * @returns {string}
 */
export function cutDigest(text) {
  if (text.length <= DIGEST_MAX) return text;
  const head = takeStart(text, HEAD);
  const tail = takeEnd(text, TAIL);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n[${omitted} characters left out]\n${tail}`;
}

/**
 * @typedef {{ kind: "text" | "tool_use" | "tool_result", text: string }} Item
 */

/**
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function blocksOf(content) {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter(isObject);
  return [];
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
function toolLine(block) {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const input = isObject(block.input) ? block.input : {};
  const arg =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : "";
  return arg === "" ? `TOOL ${name}` : `TOOL ${name}: ${arg}`;
}

/**
 * @param {Record<string, unknown>[]} blocks
 * @returns {string | undefined}
 */
function firstText(blocks) {
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

/**
 * @param {string | null} timestamp
 * @param {string | undefined} timeZone
 * @returns {string | null}
 */
function formatDate(timestamp, timeZone) {
  if (timestamp === null) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  /** @param {string | undefined} zone */
  const parts = (zone) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  let list;
  try {
    list = parts(timeZone);
  } catch {
    list = parts(undefined);
  }
  /** @param {string} type */
  const pick = (type) => list.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * Builds a bounded plain-text digest of a Claude Code transcript (JSONL lines).
 * Pure: no I/O. Lines that are not valid JSON or have an unknown shape are skipped.
 * @param {string[]} lines
 * @param {DigestOptions} [opts]
 * @returns {Digest}
 */
export function buildDigest(lines, opts = {}) {
  const skip =
    Number.isInteger(opts.fromPrompt) && /** @type {number} */ (opts.fromPrompt) > 0
      ? /** @type {number} */ (opts.fromPrompt)
      : 0;
  /** @type {string[]} */
  const out = [];
  let userPrompts = 0;
  /** @type {string | null} */
  let lineage = null;
  /** @type {string | null} */
  let lastTimestamp = null;

  for (const line of lines) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(entry) || (entry.type !== "user" && entry.type !== "assistant")) continue;
    const message = entry.message;
    if (!isObject(message)) continue;
    const content = message.content;
    if (!(typeof content === "string" ? content !== "" : Array.isArray(content))) continue;

    if (typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))) {
      lastTimestamp = entry.timestamp;
    }
    if (entry.isMeta === true || entry.isSidechain === true) continue;

    const blocks = blocksOf(content);
    if (entry.type === "assistant") {
      if (skip > 0 && userPrompts <= skip) continue;
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          out.push(`ASSISTANT: ${block.text}`);
        } else if (block.type === "tool_use") {
          out.push(toolLine(block));
        }
      }
      continue;
    }

    const first = firstText(blocks);
    const isPrompt =
      first !== undefined &&
      first.trim() !== "" &&
      !COMMAND_TAGS.some((tag) => first.startsWith(tag));
    if (isPrompt) {
      userPrompts += 1;
      if (lineage === null && typeof entry.uuid === "string") lineage = entry.uuid;
      if (userPrompts > skip) out.push(`USER: ${first}`);
      continue;
    }
    if (skip > 0 && userPrompts <= skip) continue;
    // Not a prompt: only tool results are kept; command-tag entries stay out of the text.
    if (first !== undefined && COMMAND_TAGS.some((tag) => first.startsWith(tag))) continue;
    for (const block of blocks) {
      if (block.type === "tool_result") {
        out.push(`RESULT: ${takeStart(resultText(block.content), RESULT_CAP)}`);
      }
    }
  }

  const timeZone =
    typeof opts.timeZone === "string" && opts.timeZone !== "" ? opts.timeZone : undefined;
  return {
    text: cutDigest(out.join("\n\n")),
    userPrompts,
    lineage,
    lastDate: formatDate(lastTimestamp, timeZone),
  };
}
