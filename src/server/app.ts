import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { ingestTokenAuth } from "../auth/ingest-token.js";
import { ConfigInvalidError } from "../config/vault-config.js";
import { GitError } from "../git/index.js";
import { NoteArchive, NoteInput, NotePatch } from "../vault/note-schema.js";
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
  type NoteWriter,
  PushPendingError,
  ScrubFailedError,
  UnsafePathError,
  type WriteResult,
  WrongFolderError,
} from "../vault/write-note.js";

export interface AppOptions {
  writer: NoteWriter;
  /** Secret every request except GET /health must present as `Authorization: Bearer <token>`. */
  ingestToken: string;
  /** Where failures are logged. Defaults to console.error. */
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

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
function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/** Content type check and JSON parse shared by POST and PATCH. */
async function readJsonBody(c: Context): Promise<JsonBody> {
  const mediaType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      response: c.json({ ok: false, error: "unsupported_media_type" }, 415),
    };
  }
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ ok: false, error: "invalid_json" }, 400) };
  }
}

export function createApp({ writer, ingestToken, log = console.error }: AppOptions): Hono {
  const app = new Hono();

  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
  });

  function okResponse(c: Context, result: WriteResult, changedStatus: 200 | 201): Response {
    const redactions = result.redactions;
    const hasRedactions = redactions !== undefined && redactions.length > 0;
    if (hasRedactions) {
      log(`redacted: ${redactions.map((r) => `${r.rule}=${r.count}`).join(", ")}`);
    }
    if (result.unchanged) {
      return c.json(
        {
          ok: true,
          path: result.path,
          commit: null,
          unchanged: true,
          ...(hasRedactions ? { redactions } : {}),
        },
        200,
      );
    }
    return c.json(
      {
        ok: true,
        path: result.path,
        commit: result.commit,
        ...(hasRedactions ? { redactions } : {}),
      },
      changedStatus,
    );
  }

  function errorResponse(c: Context, error: unknown): Response {
    if (error instanceof DuplicateSourceError) {
      log("duplicate_source rejected");
      return c.json({ ok: false, error: "duplicate_source", path: error.existingPath }, 409);
    }
    if (error instanceof SourceIndexLimitError) {
      log("write_failed: source index limit");
      return c.json({ ok: false, error: "write_failed" }, 500);
    }
    if (error instanceof ScrubFailedError) {
      log("scrub_failed");
      return c.json({ ok: false, error: "scrub_failed" }, 500);
    }
    if (error instanceof ConfigInvalidError) {
      log(configInvalidLogLine(error));
      return c.json(
        { ok: false, error: "config_invalid", file: error.file, keyPath: error.keyPath },
        503,
      );
    }
    if (error instanceof NoteExistsError) {
      return c.json({ ok: false, error: "note_exists" }, 409);
    }
    if (error instanceof ImmutableBodyError) {
      log("immutable_body rejected");
      return c.json({ ok: false, error: "immutable_body" }, 409);
    }
    if (error instanceof AlreadyArchivedError) {
      log("already_archived rejected");
      return c.json({ ok: false, error: "already_archived" }, 409);
    }
    if (error instanceof ArchiveTargetExistsError) {
      log("archive_target_exists rejected");
      return c.json({ ok: false, error: "archive_target_exists" }, 409);
    }
    if (error instanceof NoteNotFoundError) {
      log("note_not_found");
      return c.json({ ok: false, error: "note_not_found" }, 404);
    }
    if (error instanceof UnsafePathError) {
      log("unsafe_path rejected");
      return c.json({ ok: false, error: "unsafe_path" }, 400);
    }
    if (error instanceof InvalidFrontmatterError) {
      log("invalid_frontmatter rejected");
      return c.json(
        {
          ok: false,
          error: "invalid_frontmatter",
          missing: error.missing,
          invalid: error.invalid,
        },
        400,
      );
    }
    if (error instanceof WrongFolderError) {
      log("wrong_folder rejected");
      return c.json({ ok: false, error: "wrong_folder", expected: error.expected }, 400);
    }
    if (error instanceof PushPendingError) {
      log(`push_pending: git push exit ${error.exitCode ?? "unknown"}`);
      return c.json(
        { ok: false, error: "push_pending", path: error.path, commit: error.commit },
        502,
      );
    }
    if (error instanceof GitError) {
      log(`write_failed: git ${error.subcommand} exit ${error.exitCode ?? "unknown"}`);
      return c.json({ ok: false, error: "write_failed" }, 500);
    }
    log("write_failed: unexpected error");
    return c.json({ ok: false, error: "write_failed" }, 500);
  }

  // First registration: nothing below runs for a request that fails the token check.
  app.use("*", ingestTokenAuth(ingestToken));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/notes", limit, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = NoteInput.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_body", issues: issuesOf(parsed.error) }, 400);
    }
    try {
      return okResponse(c, await writer.write(parsed.data), 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/notes", limit, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = NotePatch.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_body", issues: issuesOf(parsed.error) }, 400);
    }
    try {
      return okResponse(c, await writer.patch(parsed.data), 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/notes/archive", limit, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = NoteArchive.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_body", issues: issuesOf(parsed.error) }, 400);
    }
    try {
      return okResponse(c, await writer.archive(parsed.data), 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}
