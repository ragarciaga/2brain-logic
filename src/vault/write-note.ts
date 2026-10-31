import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { loadVaultConfig } from "../config/vault-config.js";
import type { GitApi, GitAuthor } from "../git/index.js";
import { pushIfAhead, pushWithRetry, syncBeforeWrite, trackedAtHead } from "../git/sync.js";
import { parseNote, stringifyNote } from "./frontmatter.js";
import type { NoteInput } from "./note-schema.js";
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
  const counts = new Map<string, number>();
  try {
    scrubbedFrontmatter = scrubber.scrubFrontmatter(frontmatter);
    scrubbedBody = scrubber.scrub(body);
    for (const hits of [scrubbedFrontmatter.hits, scrubbedBody.hits]) {
      for (const [rule, count] of hits) counts.set(rule, (counts.get(rule) ?? 0) + count);
    }
  } catch {
    throw new ScrubFailedError();
  }
  const redactions = [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { frontmatter: scrubbedFrontmatter.data, body: scrubbedBody.text, redactions };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Real path of the deepest ancestor of `target` that exists. */
async function realpathOfDeepestAncestor(target: string): Promise<string> {
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
 * Create the single write path into the vault: refuse a path that matches a scrub rule
 * (`UnsafePathError`, before any git work), pull with rebase (on a rebase conflict the sync in
 * src/git/sync.ts keeps both versions: the remote one at its path, the local one as
 * `<name> (conflict YYYY-MM-DD).md`, scrubbed like any note, committed, and the write goes on; an
 * interrupted rebuild is recovered first and logged as `rebuild_recovered`), read the vault
 * config, validate
 * the frontmatter and path against it, scrub secrets from the frontmatter and the body, validate
 * the scrubbed frontmatter again. If the target already holds a regular file with the same bytes
 * as the scrubbed note and that file is tracked at HEAD, the result is `unchanged` (no commit; a
 * push only when the branch is ahead of its upstream, so a commit left pending by a failed push is
 * delivered); other content there is `NoteExistsError`. An identical file that is not tracked at
 * HEAD (a crash between writing and committing) is committed and pushed like a create. At a free
 * path, a `source_id` that belongs to another note is `DuplicateSourceError`. Otherwise write a
 * new file, commit, push (one attempt plus retries after 1 s, 2 s and 4 s; an exit-1 rejection is
 * not retried). A push that never lands throws `PushPendingError` with the local commit; the next
 * write pushes it with its own. If the commit fails and HEAD did not move, the file is unstaged
 * and removed (unless it was already there) so a retry starts clean. Writes are serialized because
 * they share one working tree. The config is read again after every pull, so a change pushed from
 * another clone applies to the next write without a restart; an invalid config throws
 * `ConfigInvalidError` and an invalid note throws `InvalidFrontmatterError` or `WrongFolderError`,
 * all before any file work. Validation never rewrites the frontmatter or the body; the scrub does,
 * replacing each secret with `[REDACTED:<rule>]`, and the result lists the redactions (rule and
 * count, never a value). A scrubber failure throws `ScrubFailedError` before anything is written.
 * The second validation keeps "stored = validated" true when a redaction changes a required value.
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
}: NoteWriterOptions): NoteWriter {
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

  async function writeOne(note: NoteInput): Promise<WriteResult> {
    // A secret in the path would reach the file name, the commit message and the remote. The path
    // is never rewritten (a placeholder contains `:`): any rule match refuses it.
    let pathHasSecret: boolean;
    try {
      pathHasSecret = scrubber.scrub(note.path).hits.size > 0;
    } catch {
      throw new ScrubFailedError();
    }
    if (pathHasSecret) throw new UnsafePathError();

    const { conflicts, recovered } = await syncBeforeWrite(root, { git, author, now, prepareCopy });
    if (recovered) log("rebuild_recovered");
    if (conflicts > 0) log(`conflicts_kept: ${conflicts}`);
    const config = await loadVaultConfig(root);
    const verdict = validateFrontmatter(note.frontmatter, note.path, config);
    if (!verdict.ok) {
      if (verdict.error === "wrong_folder") throw new WrongFolderError(verdict.expected);
      throw new InvalidFrontmatterError(verdict.missing, verdict.invalid);
    }

    const scrubbed = scrubNote(scrubber, note.frontmatter, note.body);
    const recheck = validateFrontmatter(scrubbed.frontmatter, note.path, config);
    if (!recheck.ok) {
      if (recheck.error === "wrong_folder") throw new WrongFolderError(recheck.expected);
      throw new InvalidFrontmatterError(recheck.missing, recheck.invalid);
    }

    const target = resolve(root, note.path);
    if (!target.startsWith(root + sep)) throw new UnsafePathError();

    const realRoot = await realpath(root);
    // Check the real location before mkdir, so a symlinked directory cannot make
    // `mkdir -p` create anything outside the vault.
    const parent = dirname(target);
    if (!isInside(realRoot, await realpathOfDeepestAncestor(parent))) throw new UnsafePathError();

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
    const outcome = await pushWithRetry(root, { push: git.push, sleep });
    if (!outcome.pushed) throw new PushPendingError(note.path, outcome.commit, outcome.exitCode);
    return scrubbed.redactions.length > 0
      ? { path: note.path, commit, redactions: scrubbed.redactions }
      : { path: note.path, commit };
  }

  return {
    write(note) {
      const run = queue.then(() => writeOne(note));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
