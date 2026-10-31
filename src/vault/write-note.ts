import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { GitApi, GitAuthor } from "../git/index.js";
import { stringifyNote } from "./frontmatter.js";
import type { NoteInput } from "./note-schema.js";

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

export interface WriteResult {
  path: string;
  commit: string;
}

export interface NoteWriter {
  write(note: NoteInput): Promise<WriteResult>;
}

export interface NoteWriterOptions {
  vaultDir: string;
  author: GitAuthor;
  git: GitApi;
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
 * Create the single write path into the vault: pull with rebase, write a new file, commit, push.
 * Writes are serialized because they share one working tree.
 */
export function createNoteWriter({ vaultDir, author, git }: NoteWriterOptions): NoteWriter {
  const root = resolve(vaultDir);
  let queue: Promise<unknown> = Promise.resolve();

  async function writeOne(note: NoteInput): Promise<WriteResult> {
    await git.pullRebase(root, author);

    const target = resolve(root, note.path);
    if (!target.startsWith(root + sep)) throw new UnsafePathError();

    const realRoot = await realpath(root);
    // Check the real location before mkdir, so a symlinked directory cannot make
    // `mkdir -p` create anything outside the vault.
    const parent = dirname(target);
    if (!isInside(realRoot, await realpathOfDeepestAncestor(parent))) throw new UnsafePathError();
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
      await writeFile(target, stringifyNote(note.frontmatter, note.body), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NoteExistsError();
      throw error;
    }

    const commit = await git.commitFile(root, note.path, `2brain: add ${note.path}`, author);
    await git.push(root);
    return { path: note.path, commit };
  }

  return {
    write(note) {
      const run = queue.then(() => writeOne(note));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
