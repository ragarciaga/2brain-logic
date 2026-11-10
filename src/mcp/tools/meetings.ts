import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ImportOutcome, importDays, MAX_IMPORT_DAYS } from "../../meetings/import.js";
// Types only: server.ts imports MEETING_TOOLS from this module.
import type { McpServerDeps, McpToolDefinition } from "../server.js";

/**
 * The `import_meetings` tool: asks n8n to bring the meetings of the last `days` days (Fireflies
 * and Gemini) into the vault, then returns what was stored.
 *
 * - It does not run on the writer queue: n8n posts each meeting to `POST /meetings`, which needs
 *   that queue, so holding it here would deadlock.
 * - Without `MEETINGS_IMPORT_URL` it answers `import_not_configured` and calls nothing.
 * - The answer carries vault paths and counts only: no transcript text, no names, no URL.
 */
function toResult(body: ImportOutcome) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body as unknown as Record<string, unknown>,
    isError: !body.ok,
  };
}

export function createMeetingTools(): McpToolDefinition[] {
  const importMeetings: McpToolDefinition = {
    name: "import_meetings",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "import_meetings",
        {
          description:
            "Bring the owner's recorded meetings (Fireflies and Gemini) of the last `days` days into the vault, then list the stored notes. Use it before analyzing a recent meeting that `search` does not find. Answers `pending: true` when the import is still running; call `recent` a minute later.",
          inputSchema: z.object({
            days: z
              .number({ message: "days must be a number" })
              .int({ message: "days must be an integer" })
              .min(1, { message: "days must be at least 1" })
              .max(MAX_IMPORT_DAYS, { message: `days must be at most ${MAX_IMPORT_DAYS}` })
              .optional(),
          }),
        },
        async (args) => {
          if (deps.meetingsImporter === undefined) {
            return toResult({ ok: false, error: "import_not_configured" });
          }
          try {
            return toResult(await deps.meetingsImporter.run(importDays(args.days)));
          } catch {
            return toResult({ ok: false, error: "import_failed" });
          }
        },
      );
    },
  };
  return [importMeetings];
}

export const MEETING_TOOLS: readonly McpToolDefinition[] = Object.freeze(createMeetingTools());
