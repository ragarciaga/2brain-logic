import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meetingBodySchema } from "../src/meetings/schema.js";
import { scrub } from "../src/vault/scrub/index.js";
import {
  evalN8n,
  loadTemplate,
  type N8nTemplate,
  nodeByName,
  paths,
  pathsAvoiding,
} from "./helpers/n8n-template.js";

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
      "Poll route": {
        transcript: {
          id: "ff1",
          title: "Weekly sync",
          date: 3_600_000,
          duration: 10,
          sentences: [{ speaker_name: "Guest Person", text: "Hello", start_time: 1 }],
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

  it("the post answer is read by the workflow, not retried by n8n", () => {
    const post = nodeByName(t, POST);
    expect(post.retryOnFail).toBeUndefined();
    expect(post.maxTries).toBeUndefined();
    expect(post.waitBetweenTries).toBeUndefined();
    expect(post.parameters?.options).toEqual({
      response: { response: { fullResponse: true, neverError: true, responseFormat: "json" } },
    });
  });

  it("the post retry waits at least 60 s and goes back through the calendar", () => {
    const wait = nodeByName(t, "Post wait");
    expect(wait.type).toBe("n8n-nodes-base.wait");
    const p = wait.parameters as { resume: string; amount: number; unit: string };
    expect(p.resume).toBe("timeInterval");
    const seconds = p.amount * { seconds: 1, minutes: 60, hours: 3600 }[p.unit as "seconds"];
    expect(seconds).toBeGreaterThanOrEqual(60);
    expect(paths(t, "Post wait", POST).length).toBeGreaterThan(0);
    expect(pathsAvoiding(t, "Post wait", POST, CALENDAR)).toEqual([]);
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

describe("n8n template meetings-gemini.json: ingest answer", () => {
  const t = loadTemplate(join(DIR, "meetings-gemini.json"));

  interface Cond {
    leftValue: string;
    rightValue: number;
    operator: { type: string; operation: string };
  }
  const cond = (name: string): Cond => {
    const p = nodeByName(t, name).parameters as unknown as {
      conditions: { combinator: string; conditions: Cond[] };
    };
    expect(p.conditions.combinator).toBe("and");
    expect(p.conditions.conditions).toHaveLength(1);
    expect(p.conditions.conditions[0].operator).toEqual({ type: "number", operation: "gt" });
    expect(p.conditions.conditions[0].rightValue).toBe(0);
    return p.conditions.conditions[0];
  };
  const setValue = (name: string): string => {
    const p = nodeByName(t, name).parameters as unknown as {
      assignments: { assignments: { name: string; value: string; type: string }[] };
    };
    expect(p.assignments.assignments).toHaveLength(1);
    expect(p.assignments.assignments[0].name).toBe("post_try");
    expect(p.assignments.assignments[0].type).toBe("number");
    return p.assignments.assignments[0].value;
  };

  /** Runs the retry loop from the nodes' own expressions; returns how many posts it made. */
  function posts(status: (post: number) => number | undefined): number {
    const retry = cond("Retry post");
    let tryNo = evalN8n(setValue("Post try"), { json: {} }) as number;
    for (let n = 1; n <= 20; n++) {
      const json = { statusCode: status(n) };
      const nodes = { "Post try": { post_try: tryNo } };
      if (!((evalN8n(retry.leftValue, { json, nodes }) as number) > retry.rightValue)) return n;
      const next = evalN8n(setValue("Next post try"), { json, nodes }) as number;
      tryNo = evalN8n(setValue("Post try"), { json: { post_try: next } }) as number;
    }
    throw new Error("the retry loop did not end");
  }

  it("a first pass starts at try 1 and keeps the try it is given", () => {
    expect(evalN8n(setValue("Post try"), { json: {} })).toBe(1);
    expect(evalN8n(setValue("Post try"), { json: { post_try: 3 } })).toBe(3);
  });

  it.each([502, 503])("%i is retried 3 times, 4 posts in all", (code) => {
    expect(posts(() => code)).toBe(4);
  });

  it("502 then 201 posts twice, 503 then 502 then 200 three times", () => {
    expect(posts((n) => (n === 1 ? 502 : 201))).toBe(2);
    expect(posts((n) => (n === 1 ? 503 : n === 2 ? 502 : 200))).toBe(3);
  });

  it.each([400, 404, 409, 422, 429, 500, 200, 201, undefined])("%s is not retried", (code) => {
    expect(posts(() => code)).toBe(1);
  });

  it("the retry waits 60 s through Post wait and a retry never skips the post", () => {
    const main = (name: string) => t.connections[name].main.map((o) => o.map((c) => c.node));
    expect(main("Retry post")).toEqual([["Next post try"], ["Loop transcripts"]]);
    expect(main("Next post try")).toEqual([["Post wait"]]);
    expect(main("Post wait")).toEqual([["Post try"]]);
    expect(main("Post try")).toEqual([[CALENDAR]]);
    expect(main("Transcript entries")[0]).toEqual(["Post try"]);
  });

  it("Refused flags 4xx answers only", () => {
    const c = cond("Refused");
    const refused = (statusCode?: number) =>
      (evalN8n(c.leftValue, { json: { statusCode } }) as number) > c.rightValue;
    for (const code of [400, 409, 499]) expect(refused(code)).toBe(true);
    for (const code of [200, 201, 399, 500, 502, 503, undefined]) expect(refused(code)).toBe(false);
  });

  it("Refused runs when the loop is done and leads to a stop", () => {
    const main = (name: string) => t.connections[name].main.map((o) => o.map((c) => c.node));
    expect(main("Loop transcripts")[0]).toEqual(["Refused"]);
    expect(main("Refused")[0]).toEqual(["Ingest refused"]);
    expect(nodeByName(t, "Ingest refused").type).toBe("n8n-nodes-base.stopAndError");
    expect(t.connections["Ingest refused"]).toBeUndefined();
  });
});
