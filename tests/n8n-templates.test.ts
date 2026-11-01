import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meetingBodySchema } from "../src/meetings/schema.js";
import { scrub } from "../src/vault/scrub/index.js";
import { evalN8n, loadTemplate, type N8nTemplate, nodeByName } from "./helpers/n8n-template.js";

const DIR = join(import.meta.dirname, "..", "n8n", "templates");
const FILES = ["meetings-fireflies.json", "meetings-gemini.json"];
const POST = "Post meeting";
const CALENDAR = "Calendar events";
const MIN30 = 30 * 60_000;
const ALLOWED_HOSTS = new Set([
  "api.fireflies.ai",
  "www.googleapis.com",
  "meet.googleapis.com",
  "brain:3000",
]);
const PLANTED_OWNERS = ["Marta Quintero", "Quintero Holdings"];

interface HttpParams {
  method: string;
  url: string;
  jsonBody: string;
  queryParameters: { parameters: { name: string; value: string }[] };
}
const params = (t: N8nTemplate, name: string) =>
  nodeByName(t, name).parameters as unknown as HttpParams;

const positive = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "scrub", "positive.json"), "utf8"),
) as Record<string, { rule: string; parts: string[] }[]>;
const fromParts = (rule: string): string => {
  const entry = Object.values(positive)
    .flat()
    .find((e) => e.rule === rule);
  if (!entry) throw new Error(`no fixture for ${rule}`);
  return entry.parts.join("");
};

function credentialIds(t: N8nTemplate): number {
  return t.nodes.filter((n) =>
    Object.values(n.credentials ?? {}).some((c) => typeof c === "object" && "id" in c),
  ).length;
}
const scrubHits = (text: string): number => scrub(text).hits.size;
const foreignEmails = (text: string): string[] =>
  (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter(
    (e) => e.slice(e.indexOf("@") + 1) !== "example.com",
  );
const ownerNames = (text: string): string[] =>
  PLANTED_OWNERS.filter((n) => text.toLowerCase().includes(n.toLowerCase()));

// A fake delivered event: every key must reach the post body unchanged.
const event = {
  id: "ev1",
  summary: "Weekly sync",
  status: "confirmed",
  start: { dateTime: "2026-11-01T10:00:00Z" },
  end: { dateTime: "2026-11-01T11:00:00Z" },
  organizer: { email: "owner@example.com" },
  attendees: [
    { email: "guest@example.com", displayName: "Guest Person", responseStatus: "accepted" },
  ],
};

// Per-template fake upstream nodes. Fireflies date is epoch ms and duration minutes.
const SCENARIOS = {
  "meetings-fireflies.json": {
    start: 3_600_000,
    end: 3_600_000 + 10 * 60_000,
    nodes: {
      "Fetch transcript": {
        data: {
          transcript: {
            id: "ff1",
            title: "Weekly sync",
            date: 3_600_000,
            duration: 10,
            sentences: [{ speaker_name: "Guest Person", text: "Hello", start_time: 1 }],
          },
        },
      },
      Settings: { calendar_id: "team@example.com" },
    },
  },
  "meetings-gemini.json": {
    start: Date.parse("2026-11-01T10:00:00.123Z"),
    end: Date.parse("2026-11-01T10:30:00.987Z"),
    nodes: {
      "Split records": {
        name: "conferenceRecords/r1",
        startTime: "2026-11-01T10:00:00.123456789Z",
        endTime: "2026-11-01T10:30:00.987654321Z",
      },
      "Loop transcripts": { name: "conferenceRecords/r1/transcripts/x", state: "FILE_GENERATED" },
      Participants: [{ participants: [{ name: "conferenceRecords/r1/participants/p1" }] }],
      "Transcript entries": [
        {
          transcriptEntries: [
            {
              participant: "conferenceRecords/r1/participants/p1",
              text: "Hello",
              startTime: "2026-11-01T10:01:00Z",
            },
          ],
        },
      ],
      Settings: { calendar_id: "team@example.com" },
    },
  },
} as const;

describe.each(FILES)("n8n template %s", (file) => {
  const t = loadTemplate(join(DIR, file));
  const text = readFileSync(join(DIR, file), "utf8");
  const scenario = SCENARIOS[file as keyof typeof SCENARIOS];

  it("post target", () => {
    const posts = t.nodes.filter((n) => String(n.parameters?.url ?? "").includes("/meetings"));
    expect(posts.map((n) => n.name)).toEqual([POST]);
    const post = posts[0];
    expect(post.parameters?.url).toBe("http://brain:3000/meetings");
    expect(post.parameters?.method).toBe("POST");
    expect(post.parameters?.authentication).toBe("genericCredentialType");
    expect(post.parameters?.genericAuthType).toBe("httpHeaderAuth");
    expect(post.credentials).toEqual({ httpHeaderAuth: { name: "2brain ingest" } });
  });

  it("calendar window", () => {
    const q = Object.fromEntries(
      params(t, CALENDAR).queryParameters.parameters.map((x) => [x.name, x.value]),
    );
    const nodes = scenario.nodes;
    expect(evalN8n(q.timeMin, { nodes })).toBe(new Date(scenario.start - MIN30).toISOString());
    expect(evalN8n(q.timeMax, { nodes })).toBe(new Date(scenario.end + MIN30).toISOString());
  });

  it("events as delivered", () => {
    expect(t.connections[CALENDAR].main[0]).toEqual([{ node: POST, type: "main", index: 0 }]);
    const out = JSON.parse(
      evalN8n(params(t, POST).jsonBody, {
        json: { items: [event] },
        nodes: scenario.nodes,
      }) as string,
    );
    expect(out.calendar_events).toEqual([
      { ...event, title: event.summary, calendar_id: "team@example.com" },
    ]);
  });

  it("post body parses", () => {
    const out = JSON.parse(
      evalN8n(params(t, POST).jsonBody, {
        json: { items: [event] },
        nodes: scenario.nodes,
      }) as string,
    );
    const parsed = meetingBodySchema.safeParse(out);
    expect(parsed.success).toBe(true);
    const bad = meetingBodySchema.safeParse({ ...out, source: "other" });
    expect(bad.success).toBe(false);
  });

  it("hosts", () => {
    const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.:-]+)/gi)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(ALLOWED_HOSTS.has(host)).toBe(true);
  });

  it("no secrets", () => {
    expect(credentialIds(t)).toBe(0);
    expect(scrubHits(text)).toBe(0);
    expect(foreignEmails(text)).toEqual([]);
    expect(ownerNames(text)).toEqual([]);
    expect(text).not.toContain(String.fromCodePoint(0x2014));
  });

  it("scan catches planted values", () => {
    const planted: N8nTemplate = structuredClone(t);
    const node = planted.nodes[0];
    node.credentials = { httpHeaderAuth: { id: "123", name: "2brain ingest" } };
    expect(credentialIds(planted)).toBe(1);
    const bearer = JSON.stringify({ note: fromParts("bearer") });
    expect(scrubHits(bearer)).toBeGreaterThan(0);
    const key = JSON.stringify({ note: fromParts("google_api_key") });
    expect(scrubHits(key)).toBeGreaterThan(0);
    expect(foreignEmails(JSON.stringify({ note: "who@acme.test" }))).toEqual(["who@acme.test"]);
    expect(foreignEmails(JSON.stringify({ note: "who@example.com.evil.test" })).length).toBe(1);
    expect(ownerNames(JSON.stringify({ note: "ask marta quintero" }))).toEqual(["Marta Quintero"]);
  });
});
