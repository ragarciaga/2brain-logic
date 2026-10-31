import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { loadVaultConfig, type VaultConfig } from "../config/vault-config.js";
import type { GitApi, GitAuthor } from "../git/index.js";
import { pushIfAhead, pushWithRetry, syncBeforeWrite, trackedAtHead } from "../git/sync.js";
import { parseNote, stringifyNote } from "./frontmatter.js";
import type { NoteArchive, NoteInput, NotePatch } from "./note-schema.js";
import {
  AlreadyArchivedError,
  ArchiveTargetExistsError,
  appendBody,
  appendedBytes,
  archiveTarget,
  ImmutableBodyError,
  isImmutableBody,
  isInArchive,
  mergeProperties,
  NoteNotFoundError,
  propertiesUnchanged,
  readStoredNote,
} from "./operations.js";
import {
  type ScrubFrontmatterResult,
  type ScrubResult,
  scrub,
  scrubFrontmatter,
} from "./scrub/index.js";
import { createSourceIndex, type SourceIndex, sourceIdKey } from "./source-index.js";
import { validateFrontmatter } from "./validate.js";

export class NoteExistsError extends Error {
  constructor() {
    super("A note already exists at that path");
    this.name = "NoteExistsError";
  }
}

/** The target resolves outside the vault. The message never names a resolved or real path. */
export class UnsafePathError extends Error {
  constructor() {
    super("Path escapes the vault");
    this.name = "UnsafePathError";
  }
}

/**
 * A required frontmatter property is absent or has a rejected value. `missing` and `invalid` hold
 * owner property names only; the message and the fields never carry a value from the note.
 */
export class InvalidFrontmatterError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    super("Frontmatter is invalid");
    this.name = "InvalidFrontmatterError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** The note's path is outside the folder its type requires. `expected` comes from the config. */
export class WrongFolderError extends Error {
  readonly expected: string;

  constructor(expected: string) {
    super("Note is outside the folder for its type");
    this.name = "WrongFolderError";
    this.expected = expected;
  }
}

/**
 * The secret scrub could not finish (a rule failed, or the data was too deep or cyclic). The
 * message is fixed and the error carries no `cause`: nothing from the scrubber or the note reaches
 * a response or a log through it.
 */
export class ScrubFailedError extends Error {
  constructor() {
    super("Secret scrub failed");
    this.name = "ScrubFailedError";
  }
}

/**
 * The note is committed locally but the push did not land (a transient failure after all retries,
 * or a rejection because the remote moved). `commit` is the local HEAD sha; the next write pushes
 * it. The message is fixed and there is no `cause`: nothing from git (URL, stderr) reaches a
 * response or a log through it.
 */
export class PushPendingError extends Error {
  readonly path: string;
  readonly commit: string;
  readonly exitCode: number | null;

  constructor(path: string, commit: string, exitCode: number | null) {
    super("Push is pending");
    this.name = "PushPendingError";
    this.path = path;
    this.commit = commit;
    this.exitCode = exitCode;
  }
}

/** How many times one scrub rule redacted something in a note. Rule id and count only. */
export interface Redaction {
  rule: string;
  count: number;
}

export interface Scrubber {
  scrub(text: string): ScrubResult;
  scrubFrontmatter(data: Record<string, unknown>): ScrubFrontmatterResult;
}

/** The real scrubber with its default rules. */
const defaultScrubber: Scrubber = {
  scrub: (text) => scrub(text),
  scrubFrontmatter: (data) => scrubFrontmatter(data),
};

/** Another note already holds this `source_id`. `existingPath` is the vault path of that note. */
export class DuplicateSourceError extends Error {
  readonly existingPath: string;

  constructor(existingPath: string) {
    super("Another note has this source id");
    this.name = "DuplicateSourceError";
    this.existingPath = existingPath;
  }
}

export interface WriteResult {
  path: string;
  /** Null when the note was already stored with identical content (`unchanged`). */
  commit: string | null;
  unchanged?: true;
  /** Present only when something was redacted; sorted by rule id. */
  redactions?: Redaction[];
}

export interface NoteWriter {
  write(note: NoteInput): Promise<WriteResult>;
  /**
   * Set frontmatter properties of an existing note and/or append text to its body. Earlier body
   * bytes are never changed; an append to a type configured `immutable_body`, or a set that moves such a note to a type
   * without it, is refused.
   */
  patch(input: NotePatch): Promise<WriteResult>;
  /**
   * Move an existing note to `<archive folder>/<its path>` with its bytes and history (any note,
   * an `immutable_body` one included; the body is never rewritten). Nothing is ever deleted.
   */
  archive(input: NoteArchive): Promise<WriteResult>;
}

/** What a read learned from its pull: `stale` is true when the pull failed and the clone is as it was. */
export interface PulledState {
  stale: boolean;
}

export interface VaultWriter extends NoteWriter {
  /**
   * Run `fn` on the write queue after a pull (the same sync a write does). A failed pull does not
   * fail the call: `fn` runs on the local clone with `stale: true`. A rejection of `fn` rejects
   * the call and does not block the queue.
   */
  withPulled<T>(fn: (state: PulledState) => Promise<T>): Promise<T>;
}

export interface NoteWriterOptions {
  vaultDir: string;
  author: GitAuthor;
  git: GitApi;
  /** Defaults to the real scrubber; tests pass a failing one. */
  scrubber?: Scrubber;
  /** Defaults to one index per writer; tests inject small limits. */
  sourceIndex?: SourceIndex;
  /** Clock for the date in a conflict copy name (UTC day). Defaults to the system clock. */
  now?: () => Date;
  /** Receives the `conflicts_kept: <n>` line. Defaults to `console.error`. */
  log?: (message: string) => void;
  /** Waits between push retries. Defaults to a real timer; tests inject one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

/** Combine redaction counts of several scrub results, sorted by rule id. */
function toRedactions(...maps: ReadonlyMap<string, number>[]): Redaction[] {
  const counts = new Map<string, number>();
  for (const hits of maps) {
    for (const [rule, count] of hits) counts.set(rule, (counts.get(rule) ?? 0) + count);
  }
  return [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/**
 * Scrub every string of the frontmatter (nested values included) and the body. Any exception from
 * the scrubber becomes `ScrubFailedError` without a cause. Redaction counts of both parts are
 * combined and sorted by rule id.
 */
export function scrubNote(
  scrubber: Scrubber,
  frontmatter: Record<string, unknown>,
  body: string,
): { frontmatter: Record<string, unknown>; body: string; redactions: Redaction[] } {
  let scrubbedFrontmatter: ScrubFrontmatterResult;
  let scrubbedBody: ScrubResult;
  let redactions: Redaction[];
  try {
    scrubbedFrontmatter = scrubber.scrubFrontmatter(frontmatter);
    scrubbedBody = scrubber.scrub(body);
    redactions = toRedactions(scrubbedFrontmatter.hits, scrubbedBody.hits);
  } catch {
    throw new ScrubFailedError();
  }
  return { frontmatter: scrubbedFrontmatter.data, body: scrubbedBody.text, redactions };
}

/**
 * Scrub the values of a patch's `set` only (nested values included); the stored note is never
 * handed to the scrubber. Any exception becomes `ScrubFailedError` without a cause.
 */
export function scrubProperties(
  scrubber: Scrubber,
  data: Record<string, unknown>,
): { data: Record<string, unknown>; redactions: Redaction[] } {
  try {
    const scrubbed = scrubber.scrubFrontmatter(data);
    return { data: scrubbed.data, redactions: toRedactions(scrubbed.hits) };
  } catch {
    throw new ScrubFailedError();
  }
}

/** Scrub one text (an appended body part). Any exception becomes `ScrubFailedError`, no cause. */
export function scrubText(
  scrubber: Scrubber,
  text: string,
): { text: string; redactions: Redaction[] } {
  try {
    const scrubbed = scrubber.scrub(text);
    return { text: scrubbed.text, redactions: toRedactions(scrubbed.hits) };
  } catch {
    throw new ScrubFailedError();
  }
}

/** Merge redaction lists, adding the counts of equal rules, sorted by rule id. */
export function combineRedactions(...lists: Redaction[][]): Redaction[] {
  return toRedactions(...lists.map((list) => new Map(list.map((r) => [r.rule, r.count]))));
}

/** Throw the validation error for a frontmatter that does not satisfy the vault config. */
function assertValid(
  frontmatter: Record<string, unknown>,
  path: string,
  config: VaultConfig,
): void {
  const verdict = validateFrontmatter(frontmatter, path, config);
  if (verdict.ok) return;
  if (verdict.error === "wrong_folder") throw new WrongFolderError(verdict.expected);
  throw new InvalidFrontmatterError(verdict.missing, verdict.invalid);
}

export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Real path of the deepest ancestor of `target` that exists. */
export async function realpathOfDeepestAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Create the single write path into the vault, for creating a note (`write`), for setting
 * properties of an existing one (`patch`) and for moving one to the archive folder (`archive`). All
 * run on one queue (they share one working tree) and share the same steps: refuse a path that matches a scrub rule (`UnsafePathError`, before any git
 * work), pull with rebase (on a rebase conflict the sync in src/git/sync.ts keeps both versions:
 * the remote one at its path, the local one as `<name> (conflict YYYY-MM-DD).md`, scrubbed like
 * any note, committed, and the write goes on; an interrupted rebuild is recovered first and logged
 * as `rebuild_recovered`), read the vault config (again after every pull, so a change pushed from
 * another clone applies to the next write without a restart; an invalid config throws
 * `ConfigInvalidError`), validate against it (`InvalidFrontmatterError` or `WrongFolderError`),
 * scrub, validate the scrubbed result again (keeps "stored = validated" true when a redaction
 * changes a required value), commit, push (one attempt plus retries after 1 s, 2 s and 4 s; an
 * exit-1 rejection is not retried). A push that never lands throws `PushPendingError` with the
 * local commit; the next write pushes it with its own. All of this happens before any file work.
 * Validation never rewrites anything; the scrub replaces each secret with `[REDACTED:<rule>]` and
 * the result lists the redactions (rule and count, never a value). A scrubber failure throws
 * `ScrubFailedError` before anything is written.
 *
 * `write` scrubs the frontmatter and the body. If the target already holds a regular file with the
 * same bytes as the scrubbed note and that file is tracked at HEAD, the result is `unchanged` (no
 * commit; a push only when the branch is ahead of its upstream, so a commit left pending by a
 * failed push is delivered); other content there is `NoteExistsError`. An identical file that is
 * not tracked at HEAD (a crash between writing and committing) is committed and pushed like a
 * create. At a free path, a `source_id` that belongs to another note is `DuplicateSourceError`.
 * If the commit fails and HEAD did not move, the file is unstaged and removed (unless it was
 * already there) so a retry starts clean.
 *
 * `patch` merges `set` into the frontmatter of the existing note at the path (top-level keys are
 * replaced, the others kept) and/or appends `append` to its body. A missing path, a directory or a
 * non-file there is `NoteNotFoundError`; a symlink is `UnsafePathError`; a note whose frontmatter
 * cannot be read is `InvalidFrontmatterError` with empty lists. Any `append` (an empty one
 * included) on a note whose stored or merged type is configured `immutable_body: true` is
 * `ImmutableBodyError`, and so is a `set` (with or without `append`) that changes a note of such a
 * type to a type without it (immutability is one-way; a change between two immutable types is
 * allowed). Both are checked before validation, scrub or any file work. Only the incoming `set`
 * values and the appended text are scrubbed (the stored note is trusted as it is). The appended
 * text goes after the old body bytes, which stay as they are, separated by exactly one blank line
 * (see `appendBody`). With no property change the original bytes plus the suffix are stored, so
 * the frontmatter keeps its formatting. If every `set` value already equals the stored one and the
 * append is empty, the file is left alone and the result is `unchanged` (a push only when the
 * branch is ahead). A `source_id` set to the value of another note is `DuplicateSourceError`. A
 * property change rewrites the frontmatter block (comments and quoting are lost); either change
 * commits `2brain: update <path>` and pushes. If the commit fails and HEAD did not move, the file
 * is unstaged and the original bytes are restored.
 *
 * `archive` moves a tracked note with `git mv` to `<vault.archive_folder>/<its path>`, byte for byte
 * (any note, an `immutable_body` one included; the body is never read or rewritten), commits
 * `2brain: archive <path> -> <new path>` and pushes. A path already inside the archive folder is
 * `AlreadyArchivedError`; anything at the target (or a file where a target directory is needed) is
 * `ArchiveTargetExistsError`; a missing, untracked or non-file source is `NoteNotFoundError`; a
 * symlink on either path is `UnsafePathError`. If the commit fails and HEAD did not move, the note
 * is moved back; if HEAD moved, the move stays. Nothing is deleted.
 *
 * `withPulled` gives the read tools the same queue: it pulls (the same sync, with the same logs),
 * then runs the caller's function inside the queue slot, so a read waits for an earlier write and
 * a later write waits for the read. A failed pull logs `read_pull_failed` and runs the function
 * with `stale: true`; nothing is written by this call.
 */
export function createNoteWriter({
  vaultDir,
  author,
  git,
  scrubber = defaultScrubber,
  sourceIndex = createSourceIndex(),
  now = () => new Date(),
  log = console.error,
  sleep = (ms) => new Promise<void>((done) => setTimeout(done, ms)),
}: NoteWriterOptions): VaultWriter {
  const root = resolve(vaultDir);
  let queue: Promise<unknown> = Promise.resolve();

  /** Scrub a conflict copy like a created note. Any failure is `ScrubFailedError`. */
  function prepareCopy(text: string): string {
    let parsed: ReturnType<typeof parseNote>;
    try {
      parsed = parseNote(text);
    } catch {
      throw new ScrubFailedError();
    }
    const scrubbed = scrubNote(scrubber, parsed.data, parsed.content);
    if (scrubbed.redactions.length === 0) return text;
    return stringifyNote(scrubbed.frontmatter, scrubbed.body);
  }

  /**
   * A secret in the path would reach the file name, the commit message and the remote. The path
   * is never rewritten (a placeholder contains `:`): any rule match refuses it.
   */
  function refuseSecretPath(path: string): void {
    let pathHasSecret: boolean;
    try {
      pathHasSecret = scrubber.scrub(path).hits.size > 0;
    } catch {
      throw new ScrubFailedError();
    }
    if (pathHasSecret) throw new UnsafePathError();
  }

  /** Pull and log what the sync did. */
  async function syncAndLog(): Promise<void> {
    const { conflicts, recovered } = await syncBeforeWrite(root, { git, author, now, prepareCopy });
    if (recovered) log("rebuild_recovered");
    if (conflicts > 0) log(`conflicts_kept: ${conflicts}`);
  }

  /** Pull, log what the sync did, and read the vault config as it is after the pull. */
  async function syncAndLoadConfig(): Promise<VaultConfig> {
    await syncAndLog();
    return loadVaultConfig(root);
  }

  /** The lexical and the real location of the target's parent must both be inside the vault. */
  async function resolveParent(
    path: string,
  ): Promise<{ target: string; parent: string; realRoot: string }> {
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new UnsafePathError();

    const realRoot = await realpath(root);
    // Check the real location before mkdir, so a symlinked directory cannot make
    // `mkdir -p` create anything outside the vault.
    const parent = dirname(target);
    if (!isInside(realRoot, await realpathOfDeepestAncestor(parent))) throw new UnsafePathError();
    return { target, parent, realRoot };
  }

  async function pushOrPending(path: string): Promise<void> {
    const outcome = await pushWithRetry(root, { push: git.push, sleep });
    if (!outcome.pushed) throw new PushPendingError(path, outcome.commit, outcome.exitCode);
  }

  async function writeOne(note: NoteInput): Promise<WriteResult> {
    refuseSecretPath(note.path);
    const config = await syncAndLoadConfig();
    assertValid(note.frontmatter, note.path, config);

    const scrubbed = scrubNote(scrubber, note.frontmatter, note.body);
    assertValid(scrubbed.frontmatter, note.path, config);

    const { target, parent, realRoot } = await resolveParent(note.path);

    const bytes = stringifyNote(scrubbed.frontmatter, scrubbed.body);
    const redactionsPart =
      scrubbed.redactions.length > 0 ? { redactions: scrubbed.redactions } : {};
    // The parent is inside the vault, so this never reads outside it. A final symlink is never
    // followed (lstat), and the file is read only when its size matches.
    let existing: Stats | undefined;
    try {
      existing = await lstat(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    // An identical file that HEAD does not track was left by a crash between write and commit.
    let adopted = false;
    if (existing !== undefined) {
      if (!existing.isFile() || existing.size !== Buffer.byteLength(bytes)) {
        throw new NoteExistsError();
      }
      if (!(await readFile(target)).equals(Buffer.from(bytes))) throw new NoteExistsError();
      if (await trackedAtHead(root, note.path)) {
        const pending = await pushIfAhead(root, { push: git.push, sleep });
        if (pending !== undefined && !pending.pushed) {
          throw new PushPendingError(note.path, pending.commit, pending.exitCode);
        }
        return { path: note.path, commit: null, unchanged: true, ...redactionsPart };
      }
      adopted = true;
    }

    const head = await git.headSha(root);
    const id = sourceIdKey(
      Object.hasOwn(scrubbed.frontmatter, config.properties.source_id)
        ? scrubbed.frontmatter[config.properties.source_id]
        : undefined,
    );
    if (id !== undefined) {
      const found = await sourceIndex.lookup(root, head, config.properties.source_id, id);
      if (found !== undefined && found !== note.path) throw new DuplicateSourceError(found);
    }

    if (!adopted) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        // A file already sits where a directory is needed: the path is taken.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTDIR") throw new NoteExistsError();
        throw error;
      }
      if (!isInside(realRoot, await realpath(parent))) throw new UnsafePathError();

      try {
        await writeFile(target, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NoteExistsError();
        throw error;
      }
    }

    let commit: string;
    try {
      commit = await git.commitFile(root, note.path, `2brain: add ${note.path}`, author);
    } catch (error) {
      // Only when HEAD did not move: a landed commit keeps its file. Best effort, then the
      // original error is rethrown.
      try {
        if ((await git.headSha(root)) === head) {
          await git.unstageFile(root, note.path);
          if (!adopted) {
            await unlink(target).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e;
            });
          }
        }
      } catch {
        // swallowed on purpose
      }
      throw error;
    }
    await pushOrPending(note.path);
    return scrubbed.redactions.length > 0
      ? { path: note.path, commit, redactions: scrubbed.redactions }
      : { path: note.path, commit };
  }

  async function patchOne(input: NotePatch): Promise<WriteResult> {
    refuseSecretPath(input.path);
    const config = await syncAndLoadConfig();
    const { target, parent, realRoot } = await resolveParent(input.path);

    // The note must exist already: a missing parent or file is "not found", a symlink anywhere on
    // the way out of the vault is refused, and nothing is created.
    try {
      if (!isInside(realRoot, await realpath(parent))) throw new UnsafePathError();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new NoteNotFoundError();
      throw error;
    }
    let existing: Stats;
    try {
      existing = await lstat(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new NoteNotFoundError();
      throw error;
    }
    if (existing.isSymbolicLink()) throw new UnsafePathError();
    if (!existing.isFile()) throw new NoteNotFoundError();

    const original = await readFile(target);
    const stored = readStoredNote(original);
    if (stored === undefined) throw new InvalidFrontmatterError([], []);
    const { data, body } = stored;

    const set = input.set ?? {};
    // A transcript body is never modified: refuse any append before validation, scrub or writes.
    // Immutability is one-way: a set cannot move an immutable note to a mutable type either.
    const storedImmutable = isImmutableBody(data, config);
    const mergedImmutable = isImmutableBody(mergeProperties(data, set), config);
    if (input.append !== undefined && (storedImmutable || mergedImmutable)) {
      throw new ImmutableBodyError();
    }
    if (storedImmutable && !mergedImmutable) throw new ImmutableBodyError();

    // Validate the merge as the caller sent it, then scrub only the incoming values and validate
    // what will be stored.
    assertValid(mergeProperties(data, set), input.path, config);
    const scrubbed =
      input.set === undefined
        ? { data: {}, redactions: [] as Redaction[] }
        : scrubProperties(scrubber, input.set);
    const added =
      input.append === undefined
        ? { text: "", redactions: [] as Redaction[] }
        : scrubText(scrubber, input.append);
    const merged = mergeProperties(data, scrubbed.data);
    assertValid(merged, input.path, config);
    const allRedactions = combineRedactions(scrubbed.redactions, added.redactions);
    const redactionsPart = allRedactions.length > 0 ? { redactions: allRedactions } : {};

    const newBody = appendBody(body, added.text);
    const bytes = propertiesUnchanged(data, scrubbed.data)
      ? appendedBytes(original, stored, newBody)
      : Buffer.from(stringifyNote(merged, newBody));
    if (original.equals(bytes)) {
      const pending = await pushIfAhead(root, { push: git.push, sleep });
      if (pending !== undefined && !pending.pushed) {
        throw new PushPendingError(input.path, pending.commit, pending.exitCode);
      }
      return { path: input.path, commit: null, unchanged: true, ...redactionsPart };
    }

    const head = await git.headSha(root);
    const sourceKey = config.properties.source_id;
    if (Object.hasOwn(scrubbed.data, sourceKey)) {
      const id = sourceIdKey(merged[sourceKey]);
      if (id !== undefined) {
        const found = await sourceIndex.lookup(root, head, sourceKey, id);
        if (found !== undefined && found !== input.path) throw new DuplicateSourceError(found);
      }
    }

    await writeFile(target, bytes);
    let commit: string;
    try {
      commit = await git.commitFile(root, input.path, `2brain: update ${input.path}`, author);
    } catch (error) {
      // Only when HEAD did not move: put the original bytes back and unstage. Best effort, then
      // the original error is rethrown.
      try {
        if ((await git.headSha(root)) === head) {
          await git.unstageFile(root, input.path);
          await writeFile(target, original);
        }
      } catch {
        // swallowed on purpose
      }
      throw error;
    }
    await pushOrPending(input.path);
    return { path: input.path, commit, ...redactionsPart };
  }

  /**
   * lstat every prefix of `rel` from the vault root down. A symlink anywhere is `UnsafePathError`.
   * `NoteNotFoundError` when a component is absent or a parent is not a directory; the last
   * component must be a regular file. Nothing is followed.
   */
  async function lstatSourceChain(rel: string): Promise<void> {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      let info: Stats;
      try {
        info = await lstat(resolve(root, ...parts.slice(0, i)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") throw new NoteNotFoundError();
        throw error;
      }
      if (info.isSymbolicLink()) throw new UnsafePathError();
      if (i < parts.length ? !info.isDirectory() : !info.isFile()) throw new NoteNotFoundError();
    }
  }

  /**
   * lstat every prefix of the archive target. A symlink anywhere is `UnsafePathError`; a file where
   * a directory is needed, or anything at the target itself, is `ArchiveTargetExistsError`. The
   * walk stops at the first absent component (nothing can exist below it).
   */
  async function lstatTargetChain(rel: string): Promise<void> {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      let info: Stats;
      try {
        info = await lstat(resolve(root, ...parts.slice(0, i)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code === "ENOTDIR") throw new ArchiveTargetExistsError();
        throw error;
      }
      if (info.isSymbolicLink()) throw new UnsafePathError();
      if (i === parts.length || !info.isDirectory()) throw new ArchiveTargetExistsError();
    }
  }

  async function archiveOne(input: NoteArchive): Promise<WriteResult> {
    refuseSecretPath(input.path);
    const config = await syncAndLoadConfig();
    const folder = config.vault.archive_folder;
    if (isInArchive(input.path, folder)) throw new AlreadyArchivedError();
    const to = archiveTarget(input.path, folder);
    refuseSecretPath(to);

    // Source: a tracked regular file with no symlink on the way. The body is never read or
    // rewritten; the move keeps the bytes.
    await resolveParent(input.path);
    await lstatSourceChain(input.path);
    if (!(await trackedAtHead(root, input.path))) throw new NoteNotFoundError();

    // Target: nothing may be there, and no symlink on the way.
    const { parent, realRoot } = await resolveParent(to);
    await lstatTargetChain(to);

    const head = await git.headSha(root);
    try {
      await mkdir(parent, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTDIR") throw new ArchiveTargetExistsError();
      throw error;
    }
    if (!isInside(realRoot, await realpath(parent))) throw new UnsafePathError();

    await git.moveFile(root, input.path, to);
    let commit: string;
    try {
      commit = await git.commitPaths(
        root,
        [input.path, to],
        `2brain: archive ${input.path} -> ${to}`,
        author,
      );
    } catch (error) {
      // Only when HEAD did not move: move the note back. Best effort, then the original error is
      // rethrown. A landed commit keeps the move.
      try {
        if ((await git.headSha(root)) === head) await git.moveFile(root, to, input.path);
      } catch {
        // swallowed on purpose
      }
      throw error;
    }
    await pushOrPending(to);
    return { path: to, commit };
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    write: (note) => enqueue(() => writeOne(note)),
    patch: (input) => enqueue(() => patchOne(input)),
    archive: (input) => enqueue(() => archiveOne(input)),
    withPulled: (fn) =>
      enqueue(async () => {
        let stale = false;
        try {
          await syncAndLog();
        } catch {
          stale = true;
          log("read_pull_failed");
        }
        return fn({ stale });
      }),
  };
}
