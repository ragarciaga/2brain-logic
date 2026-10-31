import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { loadVaultConfig } from "../config/vault-config.js";
import type { GitApi, GitAuthor } from "../git/index.js";
import { stringifyNote } from "./frontmatter.js";
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
 * (`UnsafePathError`, before any git work), pull with rebase, read the vault config, validate
 * the frontmatter and path against it, scrub secrets from the frontmatter and the body, validate
 * the scrubbed frontmatter again. If the target already holds a regular file with the same bytes
 * as the scrubbed note, the result is `unchanged` (no commit, no push); other content there is
 * `NoteExistsError`. At a free path, a `source_id` that belongs to another note is
 * `DuplicateSourceError`. Otherwise write a new file, commit, push; if the commit fails and HEAD
 * did not move, the file is unstaged and removed so a retry starts clean. Writes are serialized because
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
}: NoteWriterOptions): NoteWriter {
  const root = resolve(vaultDir);
  let queue: Promise<unknown> = Promise.resolve();

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

    await git.pullRebase(root, author);
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
    if (existing !== undefined) {
      if (!existing.isFile() || existing.size !== Buffer.byteLength(bytes)) {
        throw new NoteExistsError();
      }
      if (!(await readFile(target)).equals(Buffer.from(bytes))) throw new NoteExistsError();
      return { path: note.path, commit: null, unchanged: true, ...redactionsPart };
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

    let commit: string;
    try {
      commit = await git.commitFile(root, note.path, `2brain: add ${note.path}`, author);
    } catch (error) {
      // Only when HEAD did not move: a landed commit keeps its file. Best effort, then the
      // original error is rethrown.
      try {
        if ((await git.headSha(root)) === head) {
          await git.unstageFile(root, note.path);
          await unlink(target).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
          });
        }
      } catch {
        // swallowed on purpose
      }
      throw error;
    }
    await git.push(root);
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
