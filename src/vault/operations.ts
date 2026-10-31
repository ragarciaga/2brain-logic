import { isDeepStrictEqual } from "node:util";
import type { VaultConfig } from "../config/vault-config.js";
import { parseNote, stringifyNote } from "./frontmatter.js";

/** No regular note exists at the path. The message is fixed and names no path. */
export class NoteNotFoundError extends Error {
  constructor() {
    super("No note at that path");
    this.name = "NoteNotFoundError";
  }
}

export interface StoredNote {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Read a stored note: strict UTF-8, then the same parser as the write path. Undefined when the
 * bytes are not UTF-8, the frontmatter does not parse (or names a code engine), is not a map, or
 * the body is not the verbatim tail of the file (so re-assembling it could change it).
 */
export function readStoredNote(bytes: Buffer): StoredNote | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const { data, content } = parseNote(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    if (!text.endsWith(content)) return undefined;
    return { data, body: content };
  } catch {
    return undefined;
  }
}

/**
 * A new object: existing keys keep their order, `set` keys replace or append. Shallow: a nested
 * object in `set` replaces the whole value. Keys are defined, never assigned, so a key such as
 * `__proto__` cannot reach a prototype.
 */
export function mergeProperties(
  data: Record<string, unknown>,
  set: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of [data, set]) {
    for (const key of Object.keys(source)) {
      Object.defineProperty(merged, key, {
        value: source[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return merged;
}

/** Every `set` key is already an own key of `data` with a deeply equal value. */
export function propertiesUnchanged(
  data: Record<string, unknown>,
  set: Record<string, unknown>,
): boolean {
  return Object.keys(set).every(
    (key) => Object.hasOwn(data, key) && isDeepStrictEqual(data[key], set[key]),
  );
}

/** The note's type is configured `immutable_body: true`. The message is fixed and names nothing. */
export class ImmutableBodyError extends Error {
  constructor() {
    super("Note body is immutable");
    this.name = "ImmutableBodyError";
  }
}

/**
 * The type of a note (read under the owner's `type` property name, matched against the owner's
 * type values) is configured `immutable_body: true`. A missing or non-string type is false.
 */
export function isImmutableBody(data: Record<string, unknown>, config: VaultConfig): boolean {
  const key = config.properties.type;
  if (!Object.hasOwn(data, key)) return false;
  const typeValue = data[key];
  if (typeof typeValue !== "string") return false;
  const entry = Object.values(config.types).find((candidate) => candidate.value === typeValue);
  return entry?.immutable_body === true;
}

/**
 * The body after an append: the old body bytes, then exactly one blank line, then `text`
 * unchanged. An empty `text` returns the body; an empty body returns `text`.
 */
export function appendBody(body: string, text: string): string {
  if (text === "") return body;
  if (body === "") return text;
  if (/\r?\n\r?\n$/.test(body)) return body + text;
  if (body.endsWith("\r\n")) return `${body}\r\n${text}`;
  if (body.endsWith("\n")) return `${body}\n${text}`;
  return `${body}\n\n${text}`;
}

/**
 * The file bytes for a note whose properties did not change and whose body grew from
 * `stored.body` to `newBody`. When the original can take the suffix as is, the original bytes
 * (frontmatter formatting included) are kept; otherwise the note is re-assembled.
 */
export function appendedBytes(original: Buffer, stored: StoredNote, newBody: string): Buffer {
  if (newBody === stored.body) return original;
  const fenceIndex = original.length - Buffer.byteLength(stored.body) - 1;
  if (fenceIndex >= 0 && original[fenceIndex] === 0x0a) {
    const candidate = Buffer.concat([
      original,
      Buffer.from(newBody.slice(stored.body.length), "utf8"),
    ]);
    const reread = readStoredNote(candidate);
    if (
      reread !== undefined &&
      reread.body === newBody &&
      isDeepStrictEqual(reread.data, stored.data)
    ) {
      return candidate;
    }
  }
  return Buffer.from(stringifyNote(stored.data, newBody));
}
