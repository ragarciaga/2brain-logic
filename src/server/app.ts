import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { GitError } from "../git/index.js";
import { NoteInput } from "../vault/note-schema.js";
import { NoteExistsError, type NoteWriter, UnsafePathError } from "../vault/write-note.js";

export interface AppOptions {
  writer: NoteWriter;
  /** Where failures are logged. Defaults to console.error. */
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

export function createApp({ writer, log = console.error }: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post(
    "/notes",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
    }),
    async (c) => {
      const mediaType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return c.json({ ok: false, error: "unsupported_media_type" }, 415);
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "invalid_json" }, 400);
      }

      const parsed = NoteInput.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        return c.json({ ok: false, error: "invalid_body", issues }, 400);
      }

      try {
        const result = await writer.write(parsed.data);
        return c.json({ ok: true, path: result.path, commit: result.commit }, 201);
      } catch (error) {
        if (error instanceof NoteExistsError) {
          return c.json({ ok: false, error: "note_exists" }, 409);
        }
        if (error instanceof UnsafePathError) {
          log("unsafe_path rejected");
          return c.json({ ok: false, error: "unsafe_path" }, 400);
        }
        if (error instanceof GitError) {
          log(`write_failed: git ${error.subcommand} exit ${error.exitCode ?? "unknown"}`);
          return c.json({ ok: false, error: "write_failed" }, 500);
        }
        log("write_failed: unexpected error");
        return c.json({ ok: false, error: "write_failed" }, 500);
      }
    },
  );

  return app;
}
