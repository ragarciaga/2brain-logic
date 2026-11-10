import { lstat, readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { VaultConfig } from "../config/vault-config.js";
import {
  readBlob,
  restoreFromHead,
  type TrackedChange,
  trackedChanges,
  unstageFile,
} from "../git/index.js";
import { trackedAtHead } from "../git/sync.js";
import { meetingFolder } from "../meetings/name.js";
import { stringifyNote } from "./frontmatter.js";
import { mergeProperties, readStoredNote } from "./operations.js";

/** A single wikilink to a base name, as the meeting writer stores it in `versions`. */
const LINK = /^\[\[([^[\]|#^/\\]+)\]\]$/u;

/** The bytes of a regular file at the vault-relative path; undefined for anything else. */
async function regularFile(root: string, rel: string): Promise<Buffer | undefined> {
  const target = resolve(root, rel);
  try {
    if (!(await lstat(target)).isFile()) return undefined;
    return await readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function ownValue(data: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

/**
 * True when the change is exactly the frontmatter rewrite of an interrupted version link: the
 * worktree (and the index, when staged) holds the HEAD note with only `versions` set to one link,
 * byte for byte as the meeting writer builds it, and the linked note sits next to it, is not
 * tracked at HEAD, and links back.
 */
async function isInterruptedLink(
  root: string,
  cfg: VaultConfig,
  change: TrackedChange,
): Promise<boolean> {
  const key = cfg.meetings.properties.versions;
  const worktree = await regularFile(root, change.path);
  if (worktree === undefined) return false;
  if (change.index === "M") {
    const staged = await readBlob(root, change.path, "index");
    if (staged === undefined || !staged.equals(worktree)) return false;
  }
  const headBytes = await readBlob(root, change.path, "head");
  const atHead = headBytes === undefined ? undefined : readStoredNote(headBytes);
  if (atHead === undefined) return false;
  const headVersions = ownValue(atHead.data, key);
  if (headVersions !== undefined && !(Array.isArray(headVersions) && headVersions.length === 0)) {
    return false;
  }
  const now = readStoredNote(worktree);
  const versions = now === undefined ? undefined : ownValue(now.data, key);
  if (!Array.isArray(versions) || versions.length !== 1 || typeof versions[0] !== "string") {
    return false;
  }
  const linkedBase = LINK.exec(versions[0])?.[1];
  if (linkedBase === undefined) return false;
  const expected = stringifyNote(mergeProperties(atHead.data, { [key]: versions }), atHead.body);
  if (!Buffer.from(expected).equals(worktree)) return false;

  const linked = `${posix.dirname(change.path)}/${linkedBase}.md`;
  const linkedBytes = await regularFile(root, linked);
  if (linkedBytes === undefined || (await trackedAtHead(root, linked))) return false;
  const linkedNote = readStoredNote(linkedBytes);
  const back = `[[${posix.basename(change.path, ".md")}]]`;
  return linkedNote !== undefined && isDeepStrictEqual(ownValue(linkedNote.data, key), [back]);
}

/**
 * Undo what a crash in the middle of a meeting commit left in the index and the worktree, so the
 * next pull is not refused and the meeting can be delivered again. Only paths directly inside a
 * meeting folder are touched:
 * - a tracked note whose only change is the interrupted version link (see `isInterruptedLink`) is
 *   put back to HEAD; the retried meeting writes the same link again in its own commit;
 * - a note staged as new (not at HEAD) is unstaged; its file stays as it is, and a retry adopts it
 *   when its bytes are identical to what it would write.
 * Anything else is left alone. Nothing is deleted. The config is loaded only when something is
 * changed. Returns how many paths were put back.
 */
export async function restoreInterruptedMeeting(
  root: string,
  loadConfig: () => Promise<VaultConfig>,
): Promise<number> {
  const changes = await trackedChanges(root);
  if (changes.length === 0) return 0;
  const cfg = await loadConfig();
  if (cfg.types.meeting?.folder === undefined) return 0;
  const folders = new Set(cfg.areas.map((area) => meetingFolder(cfg, area)));
  const relevant = changes.filter(
    (c) => folders.has(posix.dirname(c.path)) && c.path.endsWith(".md"),
  );
  let restored = 0;
  for (const change of relevant) {
    if (!/^[M ]$/.test(change.index) || !/^[M ]$/.test(change.worktree)) continue;
    if (await isInterruptedLink(root, cfg, change)) {
      await restoreFromHead(root, change.path);
      restored += 1;
    }
  }
  for (const change of relevant) {
    if (change.index !== "A") continue;
    await unstageFile(root, change.path);
    restored += 1;
  }
  return restored;
}
