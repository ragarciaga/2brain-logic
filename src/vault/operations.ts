import { isDeepStrictEqual } from "node:util";
import { parseNote } from "./frontmatter.js";

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
