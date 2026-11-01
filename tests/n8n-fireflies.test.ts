import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTemplate,
  type N8nTemplate,
  nodeByName,
  nodesByType,
  paths,
  pathsAvoiding,
  reachable,
} from "./helpers/n8n-template.js";

const FILE = join(import.meta.dirname, "..", "n8n", "templates", "meetings-fireflies.json");
const t = loadTemplate(FILE);
const POST = "Post meeting";
const FETCH = "Fetch transcript";
const CALENDAR = "Calendar events";

function str(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** Evaluates an n8n `={{ ... }}` expression with a fake `$` and `$json`. */
function evalExpr(expr: string, json: unknown, nodes: Record<string, unknown>): unknown {
  const m = /^=\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expr);
  if (!m) throw new Error("not an expression");
  const dollar = (name: string) => ({
    isExecuted: name in nodes,
    first: () => ({ json: nodes[name] }),
  });
  return new Function("$", "$json", `return (${m[1]});`)(dollar, json);
}

describe("meetings-fireflies template", () => {
  it("parses as workflow export", () => {
    expect(Array.isArray(t.nodes)).toBe(true);
    expect(typeof t.connections).toBe("object");
    const names = t.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    expect(t.active).toBe(false);
    for (const key of ["pinData", "id", "versionId", "meta"]) expect(key in t).toBe(false);
  });

  it("connections name existing nodes", () => {
    const names = new Set(t.nodes.map((n) => n.name));
    for (const [source, outs] of Object.entries(t.connections)) {
      expect(names.has(source)).toBe(true);
      for (const target of Object.values(outs).flat(2)) expect(names.has(target.node)).toBe(true);
    }
  });

  it("poll enabled, webhook disabled", () => {
    expect(nodeByName(t, "Poll schedule").disabled).not.toBe(true);
    expect(nodeByName(t, "Fireflies webhook").disabled).toBe(true);
  });

  it("interval from Settings", () => {
    const interval = (
      nodeByName(t, "Poll schedule").parameters as { rule: { interval: unknown[] } }
    ).rule.interval;
    expect(interval).toHaveLength(1);
    const first = interval[0] as { field: string; minutesInterval: number };
    expect(first.field).toBe("minutes");
    const assignments = (
      nodeByName(t, "Settings").parameters as {
        assignments: { assignments: { name: string; value: unknown }[] };
      }
    ).assignments.assignments;
    const setting = assignments.find((a) => a.name === "poll_interval_minutes");
    expect(setting?.value).toBe(60);
    expect(first.minutesInterval).toBe(setting?.value);
    expect(assignments.find((a) => a.name === "daily_budget")?.value).toBe(40);
  });

  it("one list request per poll path", () => {
    const poll = paths(t, "Poll schedule", FETCH);
    expect(poll.length).toBeGreaterThan(0);
    const isList = (name: string) =>
      str(nodeByName(t, name).parameters?.jsonBody).includes("transcripts(");
    for (const p of poll) expect(p.filter(isList)).toHaveLength(1);
    const body = str(nodeByName(t, "List transcripts").parameters?.jsonBody);
    expect(body).toContain("transcripts(fromDate:");
    expect(body).toContain("limit: 50");
    expect(body).toContain("minus({ hours: 24 })");
    expect(paths(t, "Fireflies webhook", FETCH).flat().some(isList)).toBe(false);
  });

  it("webhook passes only Transcription completed", () => {
    const cond = JSON.stringify(nodeByName(t, "Completed only").parameters);
    expect(cond).toContain('"rightValue":"Transcription completed"');
    expect(cond).toContain("$json.body.eventType");
    expect(t.connections["Completed only"].main).toHaveLength(1);
    expect(reachable(t, "Completed only", 0).has(FETCH)).toBe(true);
    expect(reachable(t, "Completed only", 1).size).toBe(0);
    expect(paths(t, "Fireflies webhook", FETCH).every((p) => p.includes("Completed only"))).toBe(
      true,
    );
  });

  it("webhook path placeholder", () => {
    expect(nodeByName(t, "Fireflies webhook").parameters?.path).toBe("REPLACE-WITH-RANDOM-PATH");
  });

  it("fetch by id", () => {
    const body = str(nodeByName(t, FETCH).parameters?.jsonBody);
    expect(body).toContain("transcript(id");
    for (const f of [
      "transcript_url",
      "organizer_email",
      "participants",
      "meeting_attendees",
      "sentences",
      "speaker_name",
      "start_time",
    ]) {
      expect(body).toContain(f);
    }
    const raw = nodeByName(t, FETCH).parameters?.jsonBody as string;
    const polled = JSON.parse(evalExpr(raw, { id: "poll1" }, {}) as string);
    expect(polled.variables.id).toBe("poll1");
    const hooked = JSON.parse(evalExpr(raw, { body: { meetingId: "hook1" } }, {}) as string);
    expect(hooked.variables.id).toBe("hook1");
  });

  it.each([FETCH, CALENDAR])("retries: %s", (name) => {
    const node = nodeByName(t, name);
    expect(node.retryOnFail).toBe(true);
    expect(node.maxTries).toBe(3);
    expect(node.onError).toBe("continueErrorOutput");
  });

  it("no post without calendar", () => {
    for (const name of [FETCH, CALENDAR]) {
      const errorReach = reachable(t, name, 1);
      expect(errorReach.has(POST)).toBe(false);
      expect(errorReach.has("Source or calendar failed")).toBe(true);
    }
    expect(paths(t, "Poll schedule", POST).length).toBeGreaterThan(0);
    expect(paths(t, "Fireflies webhook", POST).length).toBeGreaterThan(0);
    for (const trigger of ["Poll schedule", "Fireflies webhook"]) {
      expect(pathsAvoiding(t, trigger, POST, CALENDAR)).toEqual([]);
    }
    expect(nodesByType(t, "n8n-nodes-base.stopAndError")).toHaveLength(1);
    expect(reachable(t, "Source or calendar failed").size).toBe(0);
  });

  it("the helper catches an error edge to the post", () => {
    const bad: N8nTemplate = structuredClone(t);
    bad.connections[FETCH].main[1] = [{ node: POST, type: "main", index: 0 }];
    expect(reachable(bad, FETCH, 1).has(POST)).toBe(true);
    expect(pathsAvoiding(bad, "Poll schedule", POST, CALENDAR).length).toBeGreaterThan(0);
  });

  it("post maps summary to title and Settings calendar_id", () => {
    const body = nodeByName(t, POST).parameters?.jsonBody as string;
    const transcript = { id: "ff1", date: 1, duration: 2, sentences: [] };
    const nodes = {
      [FETCH]: { data: { transcript } },
      Settings: { calendar_id: "team@example.com" },
    };
    const out = JSON.parse(
      evalExpr(
        body,
        { items: [{ id: "e1", summary: "Weekly sync", start: {}, end: {} }] },
        nodes,
      ) as string,
    );
    expect(out.source).toBe("fireflies");
    expect(out.transcript).toEqual(transcript);
    expect(out.calendar_events).toEqual([
      {
        id: "e1",
        summary: "Weekly sync",
        start: {},
        end: {},
        title: "Weekly sync",
        calendar_id: "team@example.com",
      },
    ]);
    const poll = JSON.parse(
      evalExpr(body, { items: [{ id: "e1", summary: "x" }] }, { [FETCH]: nodes[FETCH] }) as string,
    );
    expect(poll.calendar_events[0].calendar_id).toBe("primary");
    expect(JSON.parse(evalExpr(body, {}, nodes) as string).calendar_events).toEqual([]);
  });

  it("calendar window and URL", () => {
    const p = nodeByName(t, CALENDAR).parameters as {
      url: string;
      queryParameters: { parameters: { name: string; value: string }[] };
    };
    const q = Object.fromEntries(p.queryParameters.parameters.map((x) => [x.name, x.value]));
    expect(q.singleEvents).toBe("true");
    expect(q.maxResults).toBe("50");
    const nodes = { [FETCH]: { data: { transcript: { date: 3_600_000, duration: 10 } } } };
    expect(evalExpr(q.timeMin, {}, nodes)).toBe(new Date(3_600_000 - 1_800_000).toISOString());
    expect(evalExpr(q.timeMax, {}, nodes)).toBe(
      new Date(3_600_000 + 600_000 + 1_800_000).toISOString(),
    );
    expect(evalExpr(p.url, {}, { ...nodes, Settings: { calendar_id: "a@example.com" } })).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%40example.com/events",
    );
  });

  it("credentials by name only", () => {
    const expected: Record<string, string> = {
      "List transcripts": "Fireflies API",
      [FETCH]: "Fireflies API",
      [CALENDAR]: "Google Calendar",
      [POST]: "2brain ingest",
    };
    for (const [node, name] of Object.entries(expected)) {
      const creds = Object.values(nodeByName(t, node).credentials ?? {});
      expect(creds).toEqual([{ name }]);
    }
    for (const n of t.nodes) {
      for (const cred of Object.values(n.credentials ?? {})) expect("id" in cred).toBe(false);
    }
    const text = JSON.stringify(t);
    expect(text).not.toContain(String.fromCodePoint(0x2014));
    expect(
      text.match(/[\w.+-]+@[\w.-]+/g)?.filter((e) => !e.endsWith("example.com")) ?? [],
    ).toEqual([]);
  });
});
