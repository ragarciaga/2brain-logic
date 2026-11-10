import { z } from "zod";

// On-demand meeting import (docs/adr/0021-meetings-on-demand.md). The service asks the n8n
// import workflow, over the internal network, to fetch the meetings of the last `days` days and
// post each one to `POST /meetings`. The service holds no Fireflies, Google or Composio
// credential: n8n does the fetching, the service only waits for its summary.

export const MIN_IMPORT_DAYS = 1;
export const MAX_IMPORT_DAYS = 7;
/** Under the 60 s MCP request deadline. n8n keeps running after the service stops waiting. */
export const IMPORT_WAIT_MS = 50_000;
/** Most paths passed back to the client from one summary. */
const MAX_PATHS = 100;

const path = z.string().max(1024);
const paths = z.array(path).max(1000).optional();
const count = z.number().int().min(0).max(100_000).optional();
/** Step names from the workflow, such as `calendar` or `ingest_400`. Never free text. */
const failure = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/** The summary the n8n import workflow answers with. Unknown keys are dropped. */
const SummarySchema = z.object({
  stored: paths,
  already_stored: paths,
  skipped: count,
  failed: count,
  failures: z.array(failure).max(1000).optional(),
});

export type ImportOutcome =
  | {
      ok: true;
      stored: string[];
      already_stored: string[];
      skipped: number;
      failed: number;
      /** The workflow step where each failed meeting stopped, one entry per failure. */
      failures: string[];
    }
  | { ok: true; pending: true }
  | { ok: false; error: "import_not_configured" | "import_failed" | "import_refused" };

export interface MeetingsImporter {
  run(days: number): Promise<ImportOutcome>;
}

export interface ImporterOptions {
  /** `MEETINGS_IMPORT_URL`: the n8n webhook of the import workflow. */
  url: string;
  /** Shared secret, sent as `Authorization: Bearer <token>`. The ingest token. */
  token: string;
  waitMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Clamp to 1..7 whole days. */
export function importDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return MIN_IMPORT_DAYS;
  return Math.min(MAX_IMPORT_DAYS, Math.max(MIN_IMPORT_DAYS, Math.trunc(days)));
}

export function createMeetingsImporter(options: ImporterOptions): MeetingsImporter {
  const doFetch = options.fetch ?? globalThis.fetch;
  const waitMs = options.waitMs ?? IMPORT_WAIT_MS;
  return {
    async run(days: number): Promise<ImportOutcome> {
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify({ days: importDays(days) }),
          redirect: "error",
          signal: AbortSignal.timeout(waitMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") return { ok: true, pending: true };
        return { ok: false, error: "import_failed" };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "import_refused" };
      }
      if (!response.ok) return { ok: false, error: "import_failed" };
      let parsed: z.infer<typeof SummarySchema>;
      try {
        parsed = SummarySchema.parse(await response.json());
      } catch {
        return { ok: false, error: "import_failed" };
      }
      return {
        ok: true,
        stored: (parsed.stored ?? []).slice(0, MAX_PATHS),
        already_stored: (parsed.already_stored ?? []).slice(0, MAX_PATHS),
        skipped: parsed.skipped ?? 0,
        failed: parsed.failed ?? 0,
        failures: (parsed.failures ?? []).slice(0, MAX_PATHS),
      };
    },
  };
}
