import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeNode, runCodeNode } from "./helpers/n8n-code-node.js";
import {
  loadTemplate,
  type N8nTemplate,
  nodeByName,
  nodesByType,
  paths,
  pathsAvoiding,
} from "./helpers/n8n-template.js";

const FILE = join(import.meta.dirname, "..", "n8n", "templates", "meetings-fireflies.json");
const t = loadTemplate(FILE);
const CODE = codeNode(t, "Poll state");
const NOW = "2026-11-01T12:00:00.000Z";
const TODAY = "2026-11-01";
const HOUR = 3_600_000;

interface Poll {
  next: string;
  id?: string;
  attempt?: number;
  queue?: string[];
}
interface Out {
  poll: Poll;
  transcript?: { id: string };
}
type Resp = { statusCode: number; body: unknown } | { error: string };
type State = Record<string, unknown>;

const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
const okList = (ids: string[]): Resp => ({
  statusCode: 200,
  body: { data: { transcripts: ids.map((id) => ({ id, date: 1 })) } },
});
const okFetch = (id: string): Resp => ({
  statusCode: 200,
  body: { data: { transcript: { id, title: "Weekly sync", date: 1, duration: 10 } } },
});
const serverError: Resp = { statusCode: 500, body: { errors: [{ message: "boom" }] } };
const tooMany: Resp = { statusCode: 429, body: {} };
const fresh = (over: State = {}): State => ({
  day: TODAY,
  used: 0,
  posted: {},
  pending: {},
  ...over,
});
const settings = (budget: unknown) => ({
  poll_interval_minutes: 60,
  daily_budget: budget,
  calendar_id: "primary",
});

interface Scenario {
  state?: State;
  budget?: unknown;
  /** Webhook body; omitted means a poll start. */
  webhook?: unknown;
  list?: Resp;
  fetch?: (id: string, tryNo: number) => Resp;
}

/** Plays `Poll state` -> `Poll route` -> List/Fetch -> `Poll state` until nothing more is emitted. */
async function simulate(sc: Scenario) {
  const state = sc.state ?? fresh();
  const cfg = settings("budget" in sc ? sc.budget : 40);
  let input: unknown[] = [
    "webhook" in sc ? { ...cfg, headers: {}, body: sc.webhook } : { ...cfg, timestamp: NOW },
  ];
  let matching: unknown[] = [];
  const log = {
    state,
    listCalls: 0,
    fetchCalls: [] as string[],
    posts: [] as string[],
    failed: [] as string[],
    retries: 0,
    rounds: 0,
  };
  const tries = new Map<string, number>();
  for (let round = 0; round < 60; round++) {
    log.rounds = round + 1;
    const out = (await runCodeNode(CODE, {
      staticData: state,
      input,
      settings: cfg,
      matching,
    })) as Out[];
    const nextInput: unknown[] = [];
    const nextMatching: unknown[] = [];
    for (const item of out) {
      const { next, id } = item.poll;
      if (next === "post") log.posts.push(id as string);
      else if (next === "failed") log.failed.push(id as string);
      else if (next === "list") {
        log.listCalls++;
        nextInput.push(sc.list ?? okList([]));
        nextMatching.push(item);
      } else if (next === "fetch" || next === "retry") {
        const n = (tries.get(id as string) ?? 0) + 1;
        tries.set(id as string, n);
        if (next === "retry") log.retries++;
        log.fetchCalls.push(id as string);
        nextInput.push((sc.fetch ?? okFetch)(id as string, n) ?? okFetch(id as string));
        nextMatching.push(item);
      } else throw new Error(`unknown next ${next}`);
    }
    if (nextInput.length === 0) return log;
    input = nextInput;
    matching = nextMatching;
  }
  throw new Error("no fixpoint in 60 rounds");
}

const sortedKeys = (o: unknown) => Object.keys(o as object).sort();
const fetchFn = (f: (id: string, n: number) => Resp) => f;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Poll state: selection", () => {
  it("new versus posted", async () => {
    const r = await simulate({
      state: fresh({ posted: { A: ago(1) }, pending: { C: ago(2) } }),
      list: okList(["A", "B", "B"]),
    });
    expect(r.listCalls).toBe(1);
    expect(r.fetchCalls).toEqual(["B", "C"]);
    expect(r.posts).toEqual(["B", "C"]);
    expect(sortedKeys(r.state.pending)).toEqual(["B", "C"]);
    expect(r.state.used).toBe(3);
  });

  it("48 h expiry", async () => {
    const r = await simulate({
      state: fresh({ posted: { OLD: ago(49), NEW: ago(47) } }),
      list: okList(["OLD", "NEW"]),
    });
    expect(r.fetchCalls).toEqual(["OLD"]);
    expect(sortedKeys(r.state.posted)).toEqual(["NEW"]);
  });

  it("pending past the window", async () => {
    const r = await simulate({
      state: fresh({ pending: { X: ago(100) } }),
      list: okList([]),
    });
    expect(r.fetchCalls).toEqual(["X"]);
    expect(r.posts).toEqual(["X"]);
  });

  it("one list per poll", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5"];
    const r = await simulate({ list: okList(ids) });
    expect(r.listCalls).toBe(1);
    expect(r.fetchCalls).toEqual(ids);
    const direct = (await runCodeNode(CODE, {
      staticData: fresh(),
      input: [okList(ids)],
      settings: settings(40),
      matching: [{ poll: { next: "list" } }],
    })) as Out[];
    expect(direct.map((o) => o.poll.next)).toEqual(["fetch"]);
    expect(direct[0].poll).toEqual({ next: "fetch", id: "a1", attempt: 1, queue: ids.slice(1) });
  });

  it("a list that is not ok emits nothing and adds nothing", async () => {
    for (const list of [
      serverError,
      { statusCode: 200, body: { data: null } },
      { error: "x" },
    ] as Resp[]) {
      const r = await simulate({ state: fresh({ pending: {} }), list });
      expect(r.fetchCalls).toEqual([]);
      expect(r.state.pending).toEqual({});
    }
  });

  it("a non-2xx status is a failure even when the body looks good", async () => {
    const goodList = okList(["A"]) as { statusCode: number; body: unknown };
    const listed = await simulate({ list: { ...goodList, statusCode: 500 } });
    expect(listed.fetchCalls).toEqual([]);
    expect(listed.state.pending).toEqual({});
    const goodFetch = okFetch("A") as { statusCode: number; body: unknown };
    for (const statusCode of [199, 300, 404, 500]) {
      const r = await simulate({
        list: okList(["A"]),
        fetch: () => ({ ...goodFetch, statusCode }),
      });
      expect(r.posts).toEqual([]);
      expect(r.failed).toEqual(["A"]);
    }
  });

  it("a response paired with an invalid id emits nothing", async () => {
    const out = await runCodeNode(CODE, {
      staticData: fresh(),
      settings: settings(40),
      input: [okFetch("__proto__")],
      matching: [{ poll: { next: "fetch", id: "__proto__", attempt: 1, queue: [] } }],
    });
    expect(out).toEqual([]);
  });

  it("invalid listed ids are skipped", async () => {
    const r = await simulate({ list: okList(["__proto__", "ok1", "bad id", "constructor"]) });
    expect(r.fetchCalls).toEqual(["ok1"]);
    expect(sortedKeys(r.state.pending)).toEqual(["ok1"]);
  });
});

describe("Poll state: budget", () => {
  it("budget reserve: 40 of 40 sends nothing", async () => {
    const r = await simulate({ state: fresh({ used: 40 }), list: okList(["A"]) });
    expect(r.listCalls).toBe(0);
    expect(r.fetchCalls).toEqual([]);
    expect(r.state.used).toBe(40);
  });

  it("budget reserve: 39 of 40 sends only the list", async () => {
    const r = await simulate({ state: fresh({ used: 39 }), list: okList(["A", "B"]) });
    expect(r.listCalls).toBe(1);
    expect(r.fetchCalls).toEqual([]);
    expect(r.state.used).toBe(40);
    expect(sortedKeys(r.state.pending)).toEqual(["A", "B"]);
  });

  it("budget reserve: 3 of 3 stops after two fetches", async () => {
    const r = await simulate({ budget: 3, list: okList(["A", "B", "C"]) });
    expect(r.fetchCalls).toEqual(["A", "B"]);
    expect(r.state.used).toBe(3);
    expect(sortedKeys(r.state.pending)).toEqual(["A", "B", "C"]);
  });

  it("budget reserve: a budget that is not a usable number allows nothing", async () => {
    for (const budget of [undefined, "abc", -1, Number.NaN, null, Number.POSITIVE_INFINITY]) {
      const r = await simulate({ budget, list: okList(["A"]) });
      expect(r.listCalls + r.fetchCalls.length).toBe(0);
    }
  });

  it("UTC day reset", async () => {
    const r = await simulate({ state: fresh({ day: "2026-10-31", used: 40 }), list: okList([]) });
    expect(r.listCalls).toBe(1);
    expect(r.state.day).toBe(TODAY);
    expect(r.state.used).toBe(1);
    const same = await simulate({ state: fresh({ used: 5 }), list: okList([]) });
    expect(same.state.used).toBe(6);
  });

  it("UTC day reset follows the clock across midnight", async () => {
    vi.setSystemTime(new Date("2026-11-01T23:59:59.000Z"));
    const before = await simulate({ state: fresh({ used: 10 }), list: okList([]) });
    expect(before.state.used).toBe(11);
    vi.setSystemTime(new Date("2026-11-02T00:00:01.000Z"));
    const after = await simulate({ state: before.state, list: okList([]) });
    expect(after.state.day).toBe("2026-11-02");
    expect(after.state.used).toBe(1);
  });

  it("retries counted", async () => {
    const failing = await simulate({ list: okList(["X"]), fetch: () => serverError });
    expect(failing.fetchCalls).toEqual(["X", "X", "X"]);
    expect(failing.state.used).toBe(4);
    expect(failing.failed).toEqual(["X"]);
    expect(failing.posts).toEqual([]);
    expect(sortedKeys(failing.state.pending)).toEqual(["X"]);

    const flaky = await simulate({
      list: okList(["X"]),
      fetch: fetchFn((id, n) => (n < 3 ? serverError : okFetch(id))),
    });
    expect(flaky.fetchCalls).toHaveLength(3);
    expect(flaky.retries).toBe(2);
    expect(flaky.state.used).toBe(4);
    expect(flaky.posts).toEqual(["X"]);
    expect(flaky.failed).toEqual([]);

    const blocked = await simulate({ budget: 2, list: okList(["X"]), fetch: () => serverError });
    expect(blocked.fetchCalls).toEqual(["X"]);
    expect(blocked.state.used).toBe(2);
    expect(blocked.failed).toEqual([]);
    expect(blocked.posts).toEqual([]);
  });

  it("an error output item counts as a failed try", async () => {
    const r = await simulate({ list: okList(["X"]), fetch: () => ({ error: "socket hang up" }) });
    expect(r.fetchCalls).toHaveLength(3);
    expect(r.failed).toEqual(["X"]);
  });

  it("id mismatch is a failure", async () => {
    const r = await simulate({ list: okList(["X"]), fetch: () => okFetch("other") });
    expect(r.fetchCalls).toHaveLength(3);
    expect(r.posts).toEqual([]);
    expect(r.failed).toEqual(["X"]);
  });
});

describe("Poll state: rate limit stop", () => {
  const ids = ["A", "B", "C"];
  const expectStopped = (r: Awaited<ReturnType<typeof simulate>>, calls: string[]) => {
    expect(r.fetchCalls).toEqual(calls);
    expect(r.retries).toBe(0);
    expect(r.failed).toEqual([]);
    expect(sortedKeys(r.state.pending)).toEqual(ids);
  };

  it("fetch 429", async () => {
    expectStopped(await simulate({ list: okList(ids), fetch: () => tooMany }), ["A"]);
  });

  it("fetch 200 with extensions.code", async () => {
    const limited: Resp = {
      statusCode: 200,
      body: { errors: [{ message: "slow down", extensions: { code: "too_many_requests" } }] },
    };
    expectStopped(await simulate({ list: okList(ids), fetch: () => limited }), ["A"]);
  });

  it("fetch 200 with top-level code", async () => {
    const limited: Resp = {
      statusCode: 200,
      body: { errors: [{ message: "slow down", code: "too_many_requests" }] },
    };
    expectStopped(await simulate({ list: okList(ids), fetch: () => limited }), ["A"]);
  });

  it("a rate limit on the second try stops there", async () => {
    const r = await simulate({
      list: okList(ids),
      fetch: fetchFn((_id, n) => (n === 1 ? serverError : tooMany)),
    });
    expect(r.fetchCalls).toEqual(["A", "A"]);
    expect(r.failed).toEqual([]);
    expect(r.posts).toEqual([]);
  });

  it("a rate limit after a good fetch stops the rest", async () => {
    const r = await simulate({
      list: okList(ids),
      fetch: fetchFn((id) => (id === "A" ? okFetch(id) : tooMany)),
    });
    expect(r.posts).toEqual(["A"]);
    expect(r.fetchCalls).toEqual(["A", "B"]);
  });

  it("list 429", async () => {
    const r = await simulate({
      state: fresh({ pending: { P: ago(1) } }),
      list: tooMany,
    });
    expect(r.listCalls).toBe(1);
    expect(r.fetchCalls).toEqual([]);
    expect(sortedKeys(r.state.pending)).toEqual(["P"]);
  });

  it("an unrelated error code is not a rate limit", async () => {
    const other: Resp = {
      statusCode: 200,
      body: { errors: [{ message: "x", extensions: { code: "object_not_found" } }] },
    };
    const r = await simulate({ list: okList(["A"]), fetch: () => other });
    expect(r.fetchCalls).toHaveLength(3);
    expect(r.failed).toEqual(["A"]);
  });
});

describe("Poll state: webhook", () => {
  it("new id: one fetch, no list, not kept pending", async () => {
    const r = await simulate({ webhook: { meetingId: "hook1" } });
    expect(r.listCalls).toBe(0);
    expect(r.fetchCalls).toEqual(["hook1"]);
    expect(r.posts).toEqual(["hook1"]);
    expect(r.state.pending).toEqual({});
    expect(r.state.used).toBe(1);
  });

  it("a failing webhook id gets 3 counted tries and is not kept", async () => {
    const r = await simulate({ webhook: { meetingId: "hook1" }, fetch: () => serverError });
    expect(r.fetchCalls).toEqual(["hook1", "hook1", "hook1"]);
    expect(r.state.used).toBe(3);
    expect(r.failed).toEqual(["hook1"]);
    expect(r.state.pending).toEqual({});
  });

  it("posted id: no request", async () => {
    const r = await simulate({
      state: fresh({ posted: { hook1: ago(1) } }),
      webhook: { meetingId: "hook1" },
    });
    expect(r.fetchCalls).toEqual([]);
    expect(r.state.used).toBe(0);
  });

  it("a posted id older than 48 h is fetched again", async () => {
    const r = await simulate({
      state: fresh({ posted: { hook1: ago(49) } }),
      webhook: { meetingId: "hook1" },
    });
    expect(r.fetchCalls).toEqual(["hook1"]);
  });

  it("budget spent: no request", async () => {
    const r = await simulate({ state: fresh({ used: 40 }), webhook: { meetingId: "hook1" } });
    expect(r.fetchCalls).toEqual([]);
    expect(r.state.used).toBe(40);
    expect(r.state.pending).toEqual({});
  });

  it("webhook retry stops when the budget runs out", async () => {
    const r = await simulate({
      state: fresh({ used: 38 }),
      webhook: { meetingId: "hook1" },
      fetch: () => serverError,
    });
    expect(r.fetchCalls).toHaveLength(2);
    expect(r.state.used).toBe(40);
  });

  it("invalid ids: no request, state unchanged", async () => {
    const bodies: unknown[] = [
      { meetingId: "__proto__" },
      { meetingId: "constructor" },
      { meetingId: "prototype" },
      { meetingId: "" },
      { meetingId: "a".repeat(65) },
      { meetingId: 123 },
      { meetingId: { x: 1 } },
      { meetingId: "a b" },
      { meetingId: "../etc" },
      {},
      "a string body",
      null,
      ["x"],
    ];
    for (const webhook of bodies) {
      const r = await simulate({ webhook });
      expect(r.listCalls).toBe(0);
      expect(r.fetchCalls).toEqual([]);
      expect(r.state).toEqual(fresh());
    }
    expect(({} as Record<string, unknown>).meetingId).toBeUndefined();
  });

  it("a valid id of 64 characters is accepted", async () => {
    const r = await simulate({ webhook: { meetingId: "a".repeat(64) } });
    expect(r.fetchCalls).toEqual(["a".repeat(64)]);
  });
});

describe("Poll state: static data", () => {
  it("static data shape after runs", async () => {
    const runs = [
      await simulate({ list: okList(["A", "B"]) }),
      await simulate({ list: okList(["A"]), fetch: () => serverError }),
      await simulate({ webhook: { meetingId: "w1" } }),
      await simulate({ state: fresh({ used: 40 }) }),
    ];
    for (const r of runs) {
      expect(sortedKeys(r.state)).toEqual(["day", "pending", "posted", "used"]);
      expect(typeof r.state.day).toBe("string");
      expect(Number.isInteger(r.state.used)).toBe(true);
      for (const field of ["posted", "pending"]) {
        const map = r.state[field] as Record<string, unknown>;
        for (const [k, v] of Object.entries(map)) {
          expect(/^[A-Za-z0-9_-]{1,64}$/.test(k)).toBe(true);
          expect(new Date(v as string).toISOString()).toBe(v);
        }
      }
    }
  });

  it("normalizes a corrupt state", async () => {
    const polluted = JSON.parse(
      `{"__proto__": "${ago(1)}", "ok": "${ago(1)}", "bad id": "${ago(1)}", "x": "not a date", "n": 5}`,
    );
    const polluted2 = JSON.parse(`{"__proto__": "${ago(1)}", "keep": "${ago(2)}"}`);
    const dates = JSON.parse(
      `{"calendar": "2026-13-45T00:00:00Z", "garbage": "2026-11-01Tgarbage", "real": "${ago(1)}"}`,
    );
    const viaDates = await simulate({ state: fresh({ posted: dates }), list: okList([]) });
    expect(sortedKeys(viaDates.state.posted)).toEqual(["real"]);
    const state: State = {
      day: 5,
      used: -3,
      extra: "secret",
      posted: polluted,
      pending: polluted2,
    };
    const r = await simulate({ state, list: okList([]) });
    expect(sortedKeys(r.state)).toEqual(["day", "pending", "posted", "used"]);
    expect(r.state.day).toBe(TODAY);
    expect(sortedKeys(r.state.posted)).toEqual(["ok"]);
    expect(Object.keys(r.state.pending as object)).toEqual(["keep"]);
    expect(r.fetchCalls).toEqual(["keep"]);
    const bad = await simulate({ state: { posted: [], pending: "x", used: 1.5 } });
    expect(bad.state.posted).toEqual({});
    expect(bad.state.pending).toEqual({});
    expect(bad.state.used).toBe(1);
  });
});

describe("Poll state: paired items", () => {
  it("each response uses its own paired context", async () => {
    const out = (await runCodeNode(CODE, {
      staticData: fresh(),
      settings: settings(40),
      input: [okFetch("A"), okFetch("B")],
      matching: [
        { poll: { next: "fetch", id: "A", attempt: 1, queue: [] } },
        { poll: { next: "fetch", id: "B", attempt: 1, queue: ["Q1", "Q2"] } },
      ],
    })) as Out[];
    expect(out.map((o) => `${o.poll.next}:${o.poll.id}`)).toEqual(["post:A", "post:B", "fetch:Q1"]);
    expect(out[1].transcript?.id).toBe("B");
    expect(out[2].poll.queue).toEqual(["Q2"]);
  });

  it("a failure at index 1 retries its own id with its own attempt", async () => {
    const out = (await runCodeNode(CODE, {
      staticData: fresh(),
      settings: settings(40),
      input: [okFetch("A"), serverError, serverError],
      matching: [
        { poll: { next: "fetch", id: "A", attempt: 1, queue: [] } },
        { poll: { next: "fetch", id: "B", attempt: 1, queue: ["Q"] } },
        { poll: { next: "retry", id: "C", attempt: 3, queue: [] } },
      ],
    })) as Out[];
    expect(out.map((o) => o.poll)).toEqual([
      { next: "post", id: "A" },
      { next: "retry", id: "B", attempt: 2, queue: ["Q"] },
      { next: "failed", id: "C" },
    ]);
  });
});

describe("Poll state: graph", () => {
  it("both triggers reach Fetch only through Settings and Poll state", () => {
    for (const trigger of ["Poll schedule", "Fireflies webhook"]) {
      expect(paths(t, trigger, "Fetch transcript").length).toBeGreaterThan(0);
      expect(pathsAvoiding(t, trigger, "Fetch transcript", "Poll state")).toEqual([]);
      expect(pathsAvoiding(t, trigger, "Fetch transcript", "Settings")).toEqual([]);
    }
  });

  it("Settings is on every webhook path to Calendar events", () => {
    expect(paths(t, "Fireflies webhook", "Calendar events").length).toBeGreaterThan(0);
    expect(pathsAvoiding(t, "Fireflies webhook", "Calendar events", "Settings")).toEqual([]);
  });

  it("the helper catches a path around Poll state", () => {
    const bad: N8nTemplate = structuredClone(t);
    bad.connections["Completed only"].main[0] = [
      { node: "Fetch transcript", type: "main", index: 0 },
    ];
    expect(pathsAvoiding(bad, "Fireflies webhook", "Fetch transcript", "Poll state")).not.toEqual(
      [],
    );
  });

  it("Settings passes the webhook body on", () => {
    expect(nodeByName(t, "Settings").parameters?.includeOtherFields).toBe(true);
  });

  it("each Switch rule key maps to its target node", () => {
    const rules = (
      nodeByName(t, "Poll route").parameters as {
        rules: {
          values: {
            outputKey: string;
            conditions: { conditions: { leftValue: string; rightValue: string }[] };
          }[];
        };
      }
    ).rules.values;
    const targets: Record<string, string> = {
      list: "List transcripts",
      fetch: "Fetch transcript",
      retry: "Retry wait",
      post: "Calendar events",
      failed: "Source or calendar failed",
    };
    expect(rules.map((r) => r.outputKey)).toEqual(Object.keys(targets));
    const main = t.connections["Poll route"].main;
    expect(main).toHaveLength(rules.length);
    rules.forEach((rule, i) => {
      const [c] = rule.conditions.conditions;
      expect(c.leftValue).toBe("={{ $json.poll.next }}");
      expect(c.rightValue).toBe(rule.outputKey);
      expect(main[i].map((x) => x.node)).toEqual([targets[rule.outputKey]]);
    });
    expect(t.connections["Retry wait"].main[0].map((x) => x.node)).toEqual(["Fetch transcript"]);
    expect(nodeByName(t, "Retry wait").parameters).toEqual({
      resume: "timeInterval",
      amount: 5,
      unit: "seconds",
    });
  });

  it("Fireflies requests always come back to Poll state", () => {
    for (const name of ["List transcripts", "Fetch transcript"]) {
      const node = nodeByName(t, name);
      expect(node.onError).toBe("continueErrorOutput");
      expect(t.connections[name].main.map((o) => o.map((x) => x.node))).toEqual([
        ["Poll state"],
        ["Poll state"],
      ]);
    }
  });

  it("the Code node is the only one and makes no request", () => {
    expect(nodesByType(t, "n8n-nodes-base.code").map((n) => n.name)).toEqual(["Poll state"]);
    for (const bad of ["http", "fetch(", "require(", "helpers", "@", "import"]) {
      expect(CODE).not.toContain(bad);
    }
    expect(nodeByName(t, "Poll state").credentials).toBeUndefined();
    expect(Object.keys(nodeByName(t, "Poll state").parameters ?? {})).toEqual(["jsCode"]);
  });

  it("per-recording data never uses first()", () => {
    const firsts = CODE.match(/\$\('[^']+'\)\.first\(\)/g) ?? [];
    expect(firsts).toEqual(["$('Settings').first()"]);
  });
});
