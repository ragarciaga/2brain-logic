import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meetingBodySchema, parseMeetingBody } from "../src/meetings/schema.js";
import { mapGeminiDoc } from "../src/sources/gemini/doc.js";
import { scrub } from "../src/vault/scrub/index.js";
import { codeNode } from "./helpers/n8n-code-node.js";
import { loadTemplate, nodeByName } from "./helpers/n8n-template.js";

const FILE = join(import.meta.dirname, "..", "n8n", "templates", "meetings-import.json");
const t = loadTemplate(FILE);
const text = readFileSync(FILE, "utf8");

/** Runs one Code node with fake `$` nodes (each a list of json values) and `$input`. */
async function run(name: string, input: unknown[], nodes: Record<string, unknown[]> = {}) {
  const dollar = (node: string) => {
    const values = nodes[node];
    if (values === undefined) throw new Error(`unexpected node ${node}`);
    return { first: () => ({ json: values[0] }), all: () => values.map((json) => ({ json })) };
  };
  const $input = { first: () => ({ json: input[0] }), all: () => input.map((json) => ({ json })) };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<{ json: unknown }[]>;
  const out = await new AsyncFunction("$", "$input", codeNode(t, name))(dollar, $input);
  return out.map((item) => item.json as Record<string, unknown>);
}

/** What the MCP Client node returns for one COMPOSIO_MULTI_EXECUTE_TOOL call. */
const composio = (data: unknown, successful = true) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        successful: true,
        data: { results: [{ response: { successful, data } }] },
      }),
    },
  ],
});

const targets = (from: string, output: number) =>
  (t.connections[from]?.main?.[output] ?? []).map((c) => c.node);

const settings = { days: 1, calendar_id: "primary" };

describe("meetings-import.json: shape", () => {
  it("starts from the import webhook and a daily schedule, both into Settings", () => {
    expect(nodeByName(t, "Import request").parameters).toMatchObject({
      httpMethod: "POST",
      authentication: "headerAuth",
      responseMode: "responseNode",
    });
    expect(nodeByName(t, "Import request").credentials?.httpHeaderAuth?.name).toBe("2brain ingest");
    expect(nodeByName(t, "Daily sweep").type).toBe("n8n-nodes-base.scheduleTrigger");
    expect(targets("Import request", 0)).toEqual(["Settings"]);
    expect(targets("Daily sweep", 0)).toEqual(["Settings"]);
  });

  it("names its credentials and never holds a credential id", () => {
    const names = new Set<string>();
    for (const node of t.nodes) {
      for (const cred of Object.values(node.credentials ?? {})) {
        expect(cred.id === undefined || cred.id === "").toBe(true);
        names.add(String(cred.name));
      }
    }
    expect([...names].sort()).toEqual(["2brain ingest", "Composio MCP", "Fireflies API"]);
  });

  it("reaches Fireflies, the service and Composio only (Composio from Settings)", () => {
    const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.:-]+)/gi)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual(
      ["api.fireflies.ai", "brain:3000", "docs.google.com"].filter((h) => text.includes(h)).sort(),
    );
    for (const node of t.nodes.filter((n) => n.type === "@n8n/n8n-nodes-langchain.mcpClient")) {
      expect(node.parameters?.endpointUrl).toBe(
        "={{ $('Settings').first().json.composio_mcp_url }}",
      );
    }
  });

  it("keeps owner values as placeholders in Settings", () => {
    const fields = Object.fromEntries(
      (
        nodeByName(t, "Settings").parameters as {
          assignments: { assignments: { name: string; value: unknown }[] };
        }
      ).assignments.assignments.map((a) => [a.name, a.value]),
    );
    expect(fields.composio_mcp_url).toBe("REPLACE-WITH-COMPOSIO-MCP-URL");
    expect(fields.drive_account).toBe("REPLACE-WITH-DRIVE-ACCOUNT-ID");
    expect(fields.calendar_account).toBe("REPLACE-WITH-CALENDAR-ACCOUNT-ID");
    expect(fields.calendar_id).toBe("primary");
  });

  it("loops one meeting at a time and answers the webhook only after the loop", () => {
    expect(targets("Loop", 0)).toEqual(["Summary"]);
    expect(targets("Loop", 1)).toEqual(["Kind"]);
    for (const back of ["Post meeting"]) expect(targets(back, 0)).toEqual(["Loop"]);
    expect(targets("Has body", 1)).toEqual(["Loop"]);
    expect(targets("Ready", 1)).toEqual(["Loop"]);
    expect(targets("Summary", 0)).toEqual(["From request"]);
    expect(targets("From request", 0)).toEqual(["Answer"]);
  });

  it("posts to the internal service and does not let n8n retry", () => {
    const post = nodeByName(t, "Post meeting");
    expect(post.parameters?.url).toBe("http://brain:3000/meetings");
    expect(post.retryOnFail).toBeUndefined();
  });

  it("has no secret, foreign email or em dash", () => {
    expect(scrub(text).hits.size).toBe(0);
    expect(text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).toEqual(
      ["gemini-notes@google.com"].filter((e) => text.includes(e)),
    );
    expect(text).not.toContain(String.fromCodePoint(0x2014));
  });
});

const NAME = "Pilot review - Ana / Bo - 2026/11/09 12:59 CET - Notes by Gemini";

describe("meetings-import.json: Jobs", () => {
  const ffList = (ids: string[]) => ({
    statusCode: 200,
    body: { data: { transcripts: ids.map((id) => ({ id, date: 1 })) } },
  });
  it("makes one job per Fireflies id and per Gemini meeting, one doc per language pair", async () => {
    const out = await run("Jobs", [], {
      "List Fireflies": [ffList(["ff1", "ff2"])],
      "Find Gemini docs": [
        composio({
          files: [
            { id: "d1", name: NAME, createdTime: "2026-11-09T12:39:48Z" },
            { id: "d2", name: `${NAME} (Spanish)`, createdTime: "2026-11-09T12:39:50Z" },
            {
              id: "d3",
              name: "Other - 2026/11/09 15:00 CET - Notes by Gemini (English)",
              createdTime: "2026-11-09T15:40:00Z",
            },
          ],
        }),
      ],
    });
    expect(out).toEqual([
      { kind: "fireflies", id: "ff1" },
      { kind: "fireflies", id: "ff2" },
      { kind: "gemini", doc: { id: "d1", name: NAME, createdTime: "2026-11-09T12:39:48Z" } },
      {
        kind: "gemini",
        doc: {
          id: "d3",
          name: "Other - 2026/11/09 15:00 CET - Notes by Gemini (English)",
          createdTime: "2026-11-09T15:40:00Z",
        },
      },
    ]);
  });

  it("turns a failed listing into a failed job and never returns nothing", async () => {
    const failed = await run("Jobs", [], {
      "List Fireflies": [{ statusCode: 401, body: {} }],
      "Find Gemini docs": [composio({}, false)],
    });
    expect(failed).toEqual([
      { failed: true, what: "fireflies_list" },
      { failed: true, what: "gemini_list" },
    ]);
    const empty = await run("Jobs", [], {
      "List Fireflies": [ffList([])],
      "Find Gemini docs": [composio({ files: [] })],
    });
    expect(empty).toEqual([{ noop: true }]);
  });
});

describe("meetings-import.json: building posts", () => {
  it("Fireflies job: body plus a window of the recording +/- 30 minutes", async () => {
    const transcript = {
      id: "ff1",
      date: Date.parse("2026-11-09T10:00:00Z"),
      duration: 45,
      sentences: [],
    };
    const [out] = await run("Fireflies job", [{ statusCode: 200, body: { data: { transcript } } }]);
    expect(out).toEqual({
      body: { source: "fireflies", transcript },
      window: { min: "2026-11-09T09:30:00.000Z", max: "2026-11-09T11:15:00.000Z" },
    });
    expect(await run("Fireflies job", [{ statusCode: 500, body: {} }])).toEqual([
      { failed: true, what: "fireflies_fetch" },
    ]);
  });

  it("Export link: only an https download link passes", async () => {
    const ok = await run("Export link", [
      composio({ file: { s3url: "https://files.example.com/a.txt" } }),
    ]);
    expect(ok).toEqual([{ url: "https://files.example.com/a.txt" }]);
    expect(await run("Export link", [composio({ file: { s3url: "http://x" } })])).toEqual([
      { failed: true, what: "gemini_export" },
    ]);
    expect(await run("Export link", [{ error: { message: "boom" } }])).toEqual([
      { failed: true, what: "gemini_export" },
    ]);
  });

  it("Gemini job: a body the service accepts and maps, with a window ending after the doc", async () => {
    const doc = { id: "d1", name: NAME, createdTime: "2026-11-09T12:39:48Z" };
    const textDoc = "Notes\nPilot review - Ana / Bo - Transcript\n00:00:16\nAna Ruiz: Hello.\n";
    const [out] = await run("Gemini job", [{ data: textDoc }], { Loop: [{ kind: "gemini", doc }] });
    expect(out?.window).toEqual({
      min: "2026-11-09T06:39:48.000Z",
      max: "2026-11-09T13:09:48.000Z",
    });
    const body = parseMeetingBody({ ...(out?.body as object), calendar_events: [] });
    expect(body.source).toBe("gemini_doc");
    expect(mapGeminiDoc(body as never).segments).toEqual([
      { speaker: "Ana Ruiz", offsetSeconds: 16, text: "Hello." },
    ]);
    expect(
      await run("Gemini job", [{ failed: true }], { Loop: [{ kind: "gemini", doc }] }),
    ).toEqual([{ failed: true, what: "gemini_download" }]);
  });

  it("Build post: adds the events with title and calendar id; a failed calendar fails the meeting", async () => {
    const event = {
      id: "ev1",
      summary: "Pilot review",
      start: { dateTime: "2026-11-09T12:00:00Z" },
      end: { dateTime: "2026-11-09T12:45:00Z" },
    };
    const job = {
      body: { source: "fireflies", transcript: { id: "ff1", date: 1, duration: 1, sentences: [] } },
    };
    const [out] = await run("Build post", [composio({ items: [event] })], {
      "Has body": [job],
      Settings: [settings],
    });
    const post = out?.post as Record<string, unknown>;
    expect(post.calendar_events).toEqual([
      { ...event, title: "Pilot review", calendar_id: "primary" },
    ]);
    expect(meetingBodySchema.safeParse(post).success).toBe(true);
    expect(
      await run("Build post", [{ error: { message: "x" } }], {
        "Has body": [job],
        Settings: [settings],
      }),
    ).toEqual([{ failed: true, what: "calendar" }]);
  });
});

describe("meetings-import.json: Summary", () => {
  it("sorts the answers into stored, already stored, skipped and failed", async () => {
    const out = await run("Summary", [
      { statusCode: 201, body: { ok: true, path: "bfa/reuniones/a.md", commit: "c" } },
      {
        statusCode: 200,
        body: { ok: true, path: "bfa/reuniones/b.md", commit: null, already_stored: true },
      },
      { statusCode: 200, body: { ok: true, commit: null, skipped: "too_short" } },
      { statusCode: 400, body: { ok: false, error: "invalid_body" } },
      { failed: true, what: "calendar" },
      { noop: true },
    ]);
    expect(out).toEqual([
      {
        stored: ["bfa/reuniones/a.md"],
        already_stored: ["bfa/reuniones/b.md"],
        skipped: 1,
        failed: 2,
      },
    ]);
  });
});

