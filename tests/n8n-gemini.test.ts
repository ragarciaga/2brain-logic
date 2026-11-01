import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEMINI_FINISHED_STATE } from "../src/meetings/schema.js";
import {
  evalN8n,
  loadTemplate,
  type N8nTemplate,
  nodeByName,
  nodesByType,
  pathsAvoiding,
  reachable,
} from "./helpers/n8n-template.js";

const FILE = join(import.meta.dirname, "..", "n8n", "templates", "meetings-gemini.json");
const t = loadTemplate(FILE);
const POST = "Post meeting";
const CALENDAR = "Calendar events";
const FAILED = "Meet or calendar failed";
const MEET_NODES = [
  "List conference records",
  "List transcripts",
  "Participants",
  "Transcript entries",
];
const RETRY_NODES = [...MEET_NODES, CALENDAR];

interface Condition {
  leftValue: string;
  rightValue: unknown;
  operator: { type: string; operation: string };
}
interface IfParams {
  conditions: { combinator: string; conditions: Condition[] };
}
interface HttpParams {
  url: string;
  queryParameters: { parameters: { name: string; value: string }[] };
  options: { pagination?: unknown };
  jsonBody?: string;
}

const params = (name: string) => nodeByName(t, name).parameters as unknown as HttpParams;
const query = (name: string) =>
  Object.fromEntries(params(name).queryParameters.parameters.map((q) => [q.name, q.value]));
const condition = (name: string): Condition => {
  const p = nodeByName(t, name).parameters as unknown as IfParams;
  expect(p.conditions.combinator).toBe("and");
  expect(p.conditions.conditions).toHaveLength(1);
  return p.conditions.conditions[0];
};

describe("meetings-gemini template", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses as workflow export", () => {
    expect(Array.isArray(t.nodes)).toBe(true);
    const names = t.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    expect(t.active).toBe(false);
    expect(t.settings).toEqual({ executionOrder: "v1" });
    for (const key of ["pinData", "id", "versionId", "meta"]) expect(key in t).toBe(false);
    const known = new Set(names);
    for (const [source, outs] of Object.entries(t.connections)) {
      expect(known.has(source)).toBe(true);
      for (const target of Object.values(outs).flat(2)) expect(known.has(target.node)).toBe(true);
    }
  });

  it("schedule only", () => {
    const triggers = t.nodes.filter((n) => /Trigger$|webhook$/i.test(n.type));
    expect(triggers.map((n) => n.name)).toEqual(["Poll schedule"]);
    const poll = nodeByName(t, "Poll schedule");
    expect(poll.disabled).not.toBe(true);
    expect(poll.parameters).toEqual({
      rule: { interval: [{ field: "minutes", minutesInterval: 60 }] },
    });
  });

  it("end-time filter", () => {
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const q = query("List conference records");
    expect(params("List conference records").url).toBe(
      "https://meet.googleapis.com/v2/conferenceRecords",
    );
    expect(q.pageSize).toBe("100");
    expect(evalN8n(q.filter)).toBe('end_time>="2026-10-31T12:00:00.000Z"');
  });

  it.each(MEET_NODES)("pagination: %s", (name) => {
    expect(params(name).options).toEqual({
      pagination: {
        pagination: {
          paginationMode: "updateAParameterInEachRequest",
          parameters: {
            parameters: [
              { type: "qs", name: "pageToken", value: "={{ $response.body.nextPageToken }}" },
            ],
          },
          paginationCompleteWhen: "other",
          completeExpression: "={{ !$response.body.nextPageToken }}",
        },
      },
    });
  });

  /** Simulates the pager from the node's own expressions; returns the tokens it requested. */
  function simulate(name: string, pages: { nextPageToken?: string }[]): string[] {
    const cfg = (
      params(name).options.pagination as {
        pagination: {
          parameters: { parameters: { value: string }[] };
          completeExpression: string;
        };
      }
    ).pagination;
    const requested: (string | undefined)[] = [];
    let token: string | undefined;
    for (let i = 0; i < 10; i++) {
      requested.push(token);
      const response = { body: pages[i] };
      if (evalN8n(cfg.completeExpression, { response }) === true) break;
      token = evalN8n(cfg.parameters.parameters[0].value, { response }) as string;
    }
    return requested as string[];
  }

  it.each(MEET_NODES)("pager follows nextPageToken until none: %s", (name) => {
    expect(simulate(name, [{}])).toEqual([undefined]);
    expect(simulate(name, [{ nextPageToken: "t1" }, { nextPageToken: "t2" }, {}])).toEqual([
      undefined,
      "t1",
      "t2",
    ]);
    expect(simulate(name, [{ nextPageToken: "" }, { nextPageToken: "x" }])).toEqual([undefined]);
  });

  const rec0 = {
    name: "conferenceRecords/r0",
    startTime: "2026-11-01T09:00:00.000000000Z",
    endTime: "2026-11-01T09:30:00Z",
  };
  const rec1 = {
    name: "conferenceRecords/r1",
    startTime: "2026-11-01T10:00:00.123456789Z",
    endTime: "2026-11-01T11:00:00.987654321Z",
  };
  const baseNodes = {
    "Split records": [rec0, rec1],
    "Loop transcripts": [
      { name: "conferenceRecords/r0/transcripts/x0", state: "FILE_GENERATED" },
      { name: "conferenceRecords/r1/transcripts/x1", state: "FILE_GENERATED" },
    ],
    Settings: { calendar_id: "team@example.com" },
    Participants: [{}],
    "Transcript entries": [{}],
  };

  it("entries from every page", () => {
    const body = params(POST).jsonBody as string;
    const out = JSON.parse(
      evalN8n(body, {
        json: { items: [] },
        index: 1,
        nodes: {
          ...baseNodes,
          Participants: [
            { participants: [{ name: "p1" }] },
            { participants: [{ name: "p2" }, { name: "p3" }] },
            {},
          ],
          "Transcript entries": [
            { transcriptEntries: [{ text: "a" }, { text: "b" }] },
            { transcriptEntries: [{ text: "c" }] },
            { transcriptEntries: [{ text: "d" }] },
          ],
        },
      }) as string,
    );
    expect(out.entries.map((e: { text: string }) => e.text)).toEqual(["a", "b", "c", "d"]);
    expect(out.participants.map((p: { name: string }) => p.name)).toEqual(["p1", "p2", "p3"]);
    const empty = JSON.parse(evalN8n(body, { json: {}, index: 1, nodes: baseNodes }) as string);
    expect(empty.entries).toEqual([]);
    expect(empty.participants).toEqual([]);
    expect(empty.calendar_events).toEqual([]);
  });

  it("finished only", () => {
    const c = condition("Finished only");
    expect(c.leftValue).toBe("={{ $json.state }}");
    expect(c.rightValue).toBe(GEMINI_FINISHED_STATE);
    expect(c.operator).toEqual({ type: "string", operation: "equals" });
    const passes = (state?: string) => evalN8n(c.leftValue, { json: { state } }) === c.rightValue;
    expect(passes("FILE_GENERATED")).toBe(true);
    expect(passes("ENDED")).toBe(false);
    expect(passes("STARTED")).toBe(false);
    expect(passes(undefined)).toBe(false);
    expect(t.connections["Finished only"].main).toHaveLength(1);
    expect(reachable(t, "Finished only", 1).size).toBe(0);
    expect(reachable(t, "Finished only", 0).has(POST)).toBe(true);
    expect(pathsAvoiding(t, "Poll schedule", POST, "Finished only")).toEqual([]);
  });

  it.each(["Has records", "Has transcripts"])("empty lists: %s", (name) => {
    const c = condition(name);
    expect(c.operator).toEqual({ type: "number", operation: "gt" });
    expect(c.rightValue).toBe(0);
    const key = name === "Has records" ? "conferenceRecords" : "transcripts";
    const count = (json: unknown) => evalN8n(c.leftValue, { json }) as number;
    const passes = (json: unknown) => count(json) > (c.rightValue as number);
    expect(passes({})).toBe(false);
    expect(passes({ [key]: [] })).toBe(false);
    expect(passes({ [key]: [{}] })).toBe(true);
    expect(passes({ [key]: [{}, {}] })).toBe(true);
    expect(t.connections[name].main).toHaveLength(1);
    expect(reachable(t, name, 1).size).toBe(0);
  });

  it("loop", () => {
    const loop = t.connections["Loop transcripts"].main;
    expect(loop[0]).toEqual([]);
    expect(loop[1]).toEqual([{ node: "Participants", type: "main", index: 0 }]);
    expect(nodeByName(t, "Loop transcripts").parameters).toMatchObject({ batchSize: 1 });
    expect(t.connections[POST].main[0]).toEqual([
      { node: "Loop transcripts", type: "main", index: 0 },
    ]);
    expect(nodeByName(t, "Transcript entries").executeOnce).toBe(true);
    expect(nodeByName(t, CALENDAR).executeOnce).toBe(true);
  });

  it.each(RETRY_NODES)("retries: %s", (name) => {
    const node = nodeByName(t, name);
    expect(node.retryOnFail).toBe(true);
    expect(node.maxTries).toBe(3);
    expect(node.onError).toBe("continueErrorOutput");
  });

  it("gemini no post without calendar", () => {
    for (const name of RETRY_NODES) {
      const errorReach = reachable(t, name, 1);
      expect(errorReach.has(POST)).toBe(false);
      expect(errorReach.has(FAILED)).toBe(true);
    }
    expect(pathsAvoiding(t, "Poll schedule", POST, CALENDAR)).toEqual([]);
    expect(nodesByType(t, "n8n-nodes-base.stopAndError")).toHaveLength(1);
    expect(reachable(t, FAILED).size).toBe(0);
    const bad: N8nTemplate = structuredClone(t);
    bad.connections.Participants.main[1] = [{ node: POST, type: "main", index: 0 }];
    expect(reachable(bad, "Participants", 1).has(POST)).toBe(true);
    const skip: N8nTemplate = structuredClone(t);
    skip.connections["Transcript entries"].main[0] = [{ node: POST, type: "main", index: 0 }];
    expect(pathsAvoiding(skip, "Poll schedule", POST, CALENDAR).length).toBeGreaterThan(0);
  });

  it("paired items", () => {
    const q = query(CALENDAR);
    const nodes = baseNodes;
    expect(evalN8n(q.timeMin, { nodes, index: 1 })).toBe("2026-11-01T09:30:00.123Z");
    expect(evalN8n(q.timeMax, { nodes, index: 1 })).toBe("2026-11-01T11:30:00.987Z");
    expect(evalN8n(q.timeMin, { nodes, index: 0 })).toBe("2026-11-01T08:30:00.000Z");
    const post = JSON.parse(
      evalN8n(params(POST).jsonBody as string, { json: {}, nodes, index: 1 }) as string,
    );
    expect(post.source).toBe("gemini");
    expect(post.conference).toEqual(rec1);
    expect(post.transcript).toEqual(baseNodes["Loop transcripts"][1]);
  });

  it("calendar events keep fields and use Settings", () => {
    const out = JSON.parse(
      evalN8n(params(POST).jsonBody as string, {
        json: { items: [{ id: "e1", summary: "Sync", status: "confirmed" }] },
        index: 1,
        nodes: baseNodes,
      }) as string,
    );
    expect(out.calendar_events).toEqual([
      {
        id: "e1",
        summary: "Sync",
        status: "confirmed",
        title: "Sync",
        calendar_id: "team@example.com",
      },
    ]);
  });

  it("page sizes and event cap", () => {
    expect(query("List conference records").pageSize).toBe("100");
    expect(query("List transcripts").pageSize).toBe("100");
    expect(query("Participants").pageSize).toBe("250");
    expect(query("Transcript entries").pageSize).toBe("100");
    const items = Array.from({ length: 51 }, (_v, i) => ({ id: `e${i}`, summary: "s" }));
    const out = JSON.parse(
      evalN8n(params(POST).jsonBody as string, {
        json: { items },
        index: 1,
        nodes: baseNodes,
      }) as string,
    );
    expect(out.calendar_events).toHaveLength(50);
  });

  it("credentials", () => {
    for (const name of MEET_NODES) {
      expect(Object.keys(nodeByName(t, name).credentials ?? {})).toEqual(["googleOAuth2Api"]);
      expect(Object.values(nodeByName(t, name).credentials ?? {})).toEqual([
        { name: "Google Meet" },
      ]);
      expect(nodeByName(t, name).parameters?.nodeCredentialType).toBe("googleOAuth2Api");
    }
    expect(Object.values(nodeByName(t, CALENDAR).credentials ?? {})).toEqual([
      { name: "Google Calendar" },
    ]);
  });
});
