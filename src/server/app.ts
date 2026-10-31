import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ingestTokenAuth } from "../auth/ingest-token.js";
import { NoteArchive, NoteInput, NotePatch } from "../vault/note-schema.js";
import type { NoteWriter, WriteResult } from "../vault/write-note.js";
import { issuesOf, mapWriteError, redactedLogLine } from "./errors.js";

// Re-exported so src/index.ts keeps importing it from here.
export { configInvalidLogLine } from "./errors.js";

export interface AppOptions {
  writer: NoteWriter;
  /** Secret every request except GET /health must present as `Authorization: Bearer <token>`. */
  ingestToken: string;
  /** Where failures are logged. Defaults to console.error. */
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

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
      log(redactedLogLine(redactions));
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
    const mapped = mapWriteError(error);
    if (mapped.log !== undefined) log(mapped.log);
    return c.json(mapped.body, mapped.status);
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
