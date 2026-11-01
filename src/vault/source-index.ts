import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseNote } from "./frontmatter.js";

/** The vault is larger than the index limits. The message is fixed and names no path. */
export class SourceIndexLimitError extends Error {
  constructor() {
    super("Source index limit exceeded");
    this.name = "SourceIndexLimitError";
  }
}

export interface SourceIndexLimits {
  maxEntries: number;
  maxFiles: number;
  maxFrontmatterBytes: number;
}

const DEFAULT_LIMITS: SourceIndexLimits = {
  maxEntries: 100_000,
  maxFiles: 20_000,
  maxFrontmatterBytes: 64 * 1024,
};

const CHUNK = 4096;

/** Key of a source id: a non-empty string as is, a finite number or bigint as its decimal text. */
export function sourceIdKey(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "bigint") return String(value);
  return undefined;
}

/** Read only the frontmatter block of a file, or undefined when there is none inside the cap. */
export async function readFrontmatterBlock(file: string, cap: number): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let text = "";
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(buf, 0, CHUNK, total);
      if (bytesRead === 0) return undefined;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      text = Buffer.concat(chunks).toString("utf8");
      if (total >= 4 && !text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
      if (total < 4 && !"---\r\n".startsWith(text.slice(0, total))) return undefined;
      const close = text.indexOf("\n---", 3);
      if (close !== -1) {
        const block = text.slice(0, close + 4);
        return Buffer.byteLength(block) <= cap ? block : undefined;
      }
      if (total >= cap) return undefined;
    }
  } finally {
    await handle.close();
  }
}

/** Map every note's source id (own property `propertyName`) to its vault-relative path. */
export async function buildSourceIndex(
  root: string,
  propertyName: string,
  limits: Partial<SourceIndexLimits> = {},
): Promise<Map<string, string>> {
  const { maxEntries, maxFiles, maxFrontmatterBytes } = { ...DEFAULT_LIMITS, ...limits };
  const index = new Map<string, string>();
  let entries = 0;
  let files = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const rel = pending.pop() as string;
    const listing = await readdir(join(root, rel), { withFileTypes: true });
    listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of listing) {
      entries += 1;
      if (entries > maxEntries) throw new SourceIndexLimitError();
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        subdirs.push(relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      files += 1;
      if (files > maxFiles) throw new SourceIndexLimitError();
      let id: string | undefined;
      try {
        const block = await readFrontmatterBlock(join(root, relPath), maxFrontmatterBytes);
        if (block === undefined) continue;
        const data = parseNote(block).data;
        if (!Object.hasOwn(data, propertyName)) continue;
        id = sourceIdKey(data[propertyName]);
      } catch {
        continue;
      }
      if (id !== undefined && !index.has(id)) index.set(id, relPath);
    }
    // Reverse so the stack pops directories in sorted order.
    for (let i = subdirs.length - 1; i >= 0; i -= 1) pending.push(subdirs[i] as string);
  }
  return index;
}

export interface SourceIndex {
  lookup(root: string, head: string, propertyName: string, id: string): Promise<string | undefined>;
}

/** An index cached for one (HEAD sha, property name) pair; it is rebuilt when either changes. */
export function createSourceIndex(limits: Partial<SourceIndexLimits> = {}): SourceIndex {
  let cacheKey: string | undefined;
  let cached = new Map<string, string>();
  return {
    async lookup(root, head, propertyName, id) {
      const key = JSON.stringify([root, head, propertyName]);
      if (cacheKey !== key) {
        cached = await buildSourceIndex(root, propertyName, limits);
        cacheKey = key;
      }
      return cached.get(id);
    },
  };
}
