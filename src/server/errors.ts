import type { z } from "zod";
import { ConfigInvalidError } from "../config/vault-config.js";
import { GitError } from "../git/index.js";
import {
  AlreadyArchivedError,
  ArchiveTargetExistsError,
  ImmutableBodyError,
  NoteNotFoundError,
} from "../vault/operations.js";
import { SourceIndexLimitError } from "../vault/source-index.js";
import {
  DuplicateSourceError,
  InvalidFrontmatterError,
  NoteExistsError,
  PushPendingError,
  type Redaction,
  ScrubFailedError,
  UnsafePathError,
  WrongFolderError,
} from "../vault/write-note.js";

/**
 * The one table from vault errors to codes, HTTP statuses, detail fields and log lines. The ingest
 * routes and the MCP write tools both use it, so a code or a detail field cannot drift between
 * them. Nothing here carries a request value, note content, a stack or an error message.
 */

export type WriteErrorCode =
  | "duplicate_source"
  | "write_failed"
  | "scrub_failed"
  | "config_invalid"
  | "note_exists"
  | "immutable_body"
  | "already_archived"
  | "archive_target_exists"
  | "note_not_found"
  | "unsafe_path"
  | "invalid_frontmatter"
  | "wrong_folder"
  | "push_pending";

export interface MappedWriteError {
  status: 400 | 404 | 409 | 500 | 502 | 503;
  body: { ok: false; error: WriteErrorCode; [detail: string]: unknown };
  /** The line to log, or undefined when the ingest API logs nothing for this error. */
  log: string | undefined;
}

/**
 * Log line for an invalid vault config: the file and the key path only. The error message may
 * quote the YAML, so it never reaches a log or a response.
 */
export function configInvalidLogLine(error: ConfigInvalidError): string {
  return error.keyPath === ""
    ? `config_invalid: ${error.file}`
    : `config_invalid: ${error.file} at ${error.keyPath}`;
}

/** Body of a `invalid_body` response: where and why, never the rejected value. */
export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/** `redacted: rule=count, ...`: rule ids and counts only. */
export function redactedLogLine(redactions: readonly Redaction[]): string {
  return `redacted: ${redactions.map((r) => `${r.rule}=${r.count}`).join(", ")}`;
}

/** Map an error thrown by the vault writer. Anything unknown becomes `write_failed`. */
export function mapWriteError(error: unknown): MappedWriteError {
  if (error instanceof DuplicateSourceError) {
    return {
      status: 409,
      body: { ok: false, error: "duplicate_source", path: error.existingPath },
      log: "duplicate_source rejected",
    };
  }
  if (error instanceof SourceIndexLimitError) {
    return {
      status: 500,
      body: { ok: false, error: "write_failed" },
      log: "write_failed: source index limit",
    };
  }
  if (error instanceof ScrubFailedError) {
    return { status: 500, body: { ok: false, error: "scrub_failed" }, log: "scrub_failed" };
  }
  if (error instanceof ConfigInvalidError) {
    return {
      status: 503,
      body: { ok: false, error: "config_invalid", file: error.file, keyPath: error.keyPath },
      log: configInvalidLogLine(error),
    };
  }
  if (error instanceof NoteExistsError) {
    return { status: 409, body: { ok: false, error: "note_exists" }, log: undefined };
  }
  if (error instanceof ImmutableBodyError) {
    return {
      status: 409,
      body: { ok: false, error: "immutable_body" },
      log: "immutable_body rejected",
    };
  }
  if (error instanceof AlreadyArchivedError) {
    return {
      status: 409,
      body: { ok: false, error: "already_archived" },
      log: "already_archived rejected",
    };
  }
  if (error instanceof ArchiveTargetExistsError) {
    return {
      status: 409,
      body: { ok: false, error: "archive_target_exists" },
      log: "archive_target_exists rejected",
    };
  }
  if (error instanceof NoteNotFoundError) {
    return { status: 404, body: { ok: false, error: "note_not_found" }, log: "note_not_found" };
  }
  if (error instanceof UnsafePathError) {
    return {
      status: 400,
      body: { ok: false, error: "unsafe_path" },
      log: "unsafe_path rejected",
    };
  }
  if (error instanceof InvalidFrontmatterError) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "invalid_frontmatter",
        missing: error.missing,
        invalid: error.invalid,
      },
      log: "invalid_frontmatter rejected",
    };
  }
  if (error instanceof WrongFolderError) {
    return {
      status: 400,
      body: { ok: false, error: "wrong_folder", expected: error.expected },
      log: "wrong_folder rejected",
    };
  }
  if (error instanceof PushPendingError) {
    return {
      status: 502,
      body: { ok: false, error: "push_pending", path: error.path, commit: error.commit },
      log: `push_pending: git push exit ${error.exitCode ?? "unknown"}`,
    };
  }
  if (error instanceof GitError) {
    return {
      status: 500,
      body: { ok: false, error: "write_failed" },
      log: `write_failed: git ${error.subcommand} exit ${error.exitCode ?? "unknown"}`,
    };
  }
  return {
    status: 500,
    body: { ok: false, error: "write_failed" },
    log: "write_failed: unexpected error",
  };
}
