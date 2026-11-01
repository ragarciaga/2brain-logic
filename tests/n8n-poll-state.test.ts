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
  reachable,
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
  stop?: { next: string; id: string };
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
const answer = (statusCode: number, body: unknown = {}): Resp => ({ statusCode, body });
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
  /**
   * The ingest answer to a post, by id and post try (1 is the first post).
   * The default is a 500: not posted, no retry, so the selection and budget cases
   * keep their meaning without caring about the ingest answer.
   */
  post?: (id: string, tryNo: number) => Resp;
}

/**
 * Plays `Poll state` -> `Poll route` -> List/Fetch/Post -> `Poll state` until nothing more is
 * emitted. A round is serial: it must emit at most one item.
 */
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
    postCalls: [] as string[],
    reposts: 0,
    failed: [] as string[],
    rejected: [] as string[],
    events: [] as string[],
    retries: 0,
    rounds: 0,
  };
  const tries = new Map<string, number>();
  const postTries = new Map<string, number>();
  for (let round = 0; round < 200; round++) {
    log.rounds = round + 1;
    const out = (await runCodeNode(CODE, {
      staticData: state,
      input,
      settings: cfg,
      matching,
    })) as Out[];
    if (out.length > 1) throw new Error(`round ${round} emitted ${out.length} items`);
    const nextInput: unknown[] = [];
    const nextMatching: unknown[] = [];
    for (const item of out) {
      const { next, id } = item.poll;
      log.events.push(`${next}:${id ?? ""}`);
      if (next === "post" || next === "repost") {
        if (next === "post") log.posts.push(id as string);
        else log.reposts++;
        log.postCalls.push(id as string);
        const n = (postTries.get(id as string) ?? 0) + 1;
        postTries.set(id as string, n);
        nextInput.push((sc.post ?? (() => serverError))(id as string, n));
        nextMatching.push(item);
      } else if (next === "failed") log.failed.push(id as string);
      else if (next === "rejected") log.rejected.push(id as string);
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
  throw new Error("no fixpoint in 200 rounds");
}

const sortedKeys = (o: unknown) => Object.keys(o as object).sort();
const fetchFn = (f: (id: string, n: number) => Resp) => f;

const TRIGGER = /Trigger$|webhook$/i;
/** Breaks of the rule "Poll state is the last node on every path" in a template. */
function graphProblems(tpl: N8nTemplate): string[] {
  const problems: string[] = [];
  const stops = new Set(nodesByType(tpl, "n8n-nodes-base.stopAndError").map((n) => n.name));
  const outputs = (name: string) => (tpl.connections[name]?.main ?? []).flat().map((c) => c.node);
  for (const trigger of tpl.nodes.filter((n) => TRIGGER.test(n.type))) {
    const seen = new Set([trigger.name, ...reachable(tpl, trigger.name)]);
    for (const name of seen) {
      if (stops.has(name)) continue;
      if (outputs(name).length === 0) problems.push(`sink ${name} is not a stop`);
      if (name !== "Poll state" && !reachable(tpl, name).has("Poll state")) {
        problems.push(`${name} does not reach Poll state`);
      }
    }
  }
  const post = tpl.connections["Post meeting"]?.main ?? [];
  if (post.length !== 2 || post.some((o) => o.map((c) => c.node).join() !== "Poll state")) {
    problems.push("Post meeting outputs do not both go to Poll state");
  }
  return problems;
}

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

  it("a permanently failing id does not starve the ones behind it", async () => {
    const nullTranscript: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const fetch = (id: string): Resp => (id === "BAD" ? nullTranscript : okFetch(id));
    const first = await simulate({ list: okList(["BAD", "GOOD"]), fetch });
    expect(first.fetchCalls).toEqual(["BAD", "BAD", "BAD", "GOOD"]);
    expect(first.failed).toEqual(["BAD"]);
    expect(first.posts).toEqual(["GOOD"]);
    // The failed id moves behind the others and keeps its first-seen time.
    expect(Object.keys(first.state.pending as object)).toEqual(["GOOD", "BAD"]);
    const seen = (first.state.pending as Record<string, string>).BAD;
    expect(seen).toBe(NOW);

    vi.setSystemTime(new Date(Date.parse(NOW) + HOUR));
    const second = await simulate({ state: first.state, list: okList(["BAD", "GOOD"]), fetch });
    expect(second.fetchCalls.slice(0, 1)).toEqual(["GOOD"]);
    expect(second.posts).toEqual(["GOOD"]);
    expect(Object.keys(second.state.pending as object)).toEqual(["GOOD", "BAD"]);
    expect((second.state.pending as Record<string, string>).BAD).toBe(seen);
  });

  it("a failed id with no budget left for the next one keeps the rest pending", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      budget: 4,
      list: okList(["BAD", "GOOD"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
    });
    expect(r.fetchCalls).toEqual(["BAD", "BAD", "BAD"]);
    expect(r.state.used).toBe(4);
    expect(sortedKeys(r.state.pending)).toEqual(["BAD", "GOOD"]);
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
    expect(out.map((o) => `${o.poll.next}:${o.poll.id}`)).toEqual(["post:A", "post:B"]);
    expect(out[1].transcript?.id).toBe("B");
    expect(out[0].poll.queue).toEqual([]);
    expect(out[1].poll.queue).toEqual(["Q1", "Q2"]);
  });

  it("each post answer uses its own paired context", async () => {
    const state = fresh({ pending: { A: ago(1), B: ago(1) } });
    const out = (await runCodeNode(CODE, {
      staticData: state,
      settings: settings(40),
      input: [answer(500), answer(201)],
      matching: [
        { poll: { next: "post", id: "A", queue: [] }, transcript: { id: "A" } },
        { poll: { next: "post", id: "B", queue: ["Q1"] }, transcript: { id: "B" } },
      ],
    })) as Out[];
    expect(sortedKeys(state.posted)).toEqual(["B"]);
    expect(sortedKeys(state.pending)).toEqual(["A"]);
    expect(out.map((o) => o.poll)).toEqual([{ next: "fetch", id: "Q1", attempt: 1, queue: [] }]);
  });

  it("a repost keeps its own transcript, attempt and carry", async () => {
    const state = fresh({ pending: { A: ago(1), B: ago(1) } });
    const stop = { next: "failed", id: "Z" };
    const out = (await runCodeNode(CODE, {
      staticData: state,
      settings: settings(40),
      input: [answer(201), answer(503)],
      matching: [
        { poll: { next: "post", id: "A", queue: [] }, transcript: { id: "A" } },
        { poll: { next: "post", id: "B", queue: ["Q"], stop }, transcript: { id: "B" } },
      ],
    })) as Out[];
    expect(out).toEqual([
      {
        poll: { next: "repost", id: "B", attempt: 2, queue: ["Q"], stop },
        transcript: { id: "B" },
      },
    ]);
    expect(state.used).toBe(0);
  });

  it("a repost at the last attempt ends the round and keeps the id pending", async () => {
    const state = fresh({ pending: { A: ago(1), Q: ago(1) } });
    for (const next of ["repost", "post"]) {
      const out = await runCodeNode(CODE, {
        staticData: state,
        settings: settings(40),
        input: [answer(502)],
        matching: [{ poll: { next, id: "A", attempt: 4, queue: ["Q"] }, transcript: { id: "A" } }],
      });
      // A first post has no attempt of its own: it is attempt 1 and is retried.
      expect(out).toHaveLength(next === "post" ? 1 : 0);
    }
    expect(sortedKeys(state.pending)).toEqual(["A", "Q"]);
    expect(state.posted).toEqual({});
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
      { next: "post", id: "A", queue: [] },
      { next: "retry", id: "B", attempt: 2, queue: ["Q"] },
      { next: "failed", id: "C" },
    ]);
  });
});

describe("Poll state: ingest answer", () => {
  const posted = (r: Awaited<ReturnType<typeof simulate>>) =>
    r.state.posted as Record<string, string>;

  it("201 counts as posted", async () => {
    const r = await simulate({ list: okList(["A"]), post: () => answer(201) });
    expect(r.postCalls).toEqual(["A"]);
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.state.pending).toEqual({});
    expect(r.reposts).toBe(0);
    expect(r.rejected).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("already stored counts as posted", async () => {
    const r = await simulate({
      list: okList(["A"]),
      post: () => answer(200, { already_stored: true }),
    });
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.state.pending).toEqual({});
  });

  it("skipped 200 counts as posted", async () => {
    const r = await simulate({ list: okList(["A"]), post: () => answer(200, { skipped: true }) });
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.state.pending).toEqual({});
  });

  it("a posted id is not fetched on the next poll", async () => {
    const first = await simulate({ list: okList(["A"]), post: () => answer(201) });
    const second = await simulate({ state: first.state, list: okList(["A"]) });
    expect(second.fetchCalls).toEqual([]);
  });

  it.each([400, 409, 404, 422, 429])("%i from the ingest is a drop, not a retry", async (code) => {
    const r = await simulate({ list: okList(["A"]), post: () => answer(code) });
    expect(r.state.pending).toEqual({});
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.reposts).toBe(0);
    expect(r.postCalls).toEqual(["A"]);
    expect(r.rejected).toEqual(["A"]);
    expect(r.failed).toEqual([]);
    expect(r.events.at(-1)).toBe("rejected:A");
  });

  it("4xx drop past the window", async () => {
    const r = await simulate({
      state: fresh({ pending: { A: ago(30) } }),
      list: okList([]),
      post: () => answer(400),
    });
    expect(r.state.pending).toEqual({});
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.rejected).toEqual(["A"]);
  });

  it("a refused id that is still listed is not fetched again for 48 h", async () => {
    const first = await simulate({ list: okList(["A"]), post: () => answer(409) });
    expect(first.fetchCalls).toEqual(["A"]);
    vi.setSystemTime(new Date(Date.parse(NOW) + 47 * HOUR));
    const again = await simulate({ state: first.state, list: okList(["A"]) });
    expect(again.fetchCalls).toEqual([]);
    // A new UTC day: only the list call is counted.
    expect(again.state.used).toBe(1);
    vi.setSystemTime(new Date(Date.parse(NOW) + 49 * HOUR));
    const later = await simulate({ state: again.state, list: okList(["A"]) });
    expect(later.fetchCalls).toEqual(["A"]);
  });

  it.each([502, 503])("%i is retried 3 times, then the id stays pending", async (code) => {
    const r = await simulate({ list: okList(["A", "B"]), post: () => answer(code) });
    expect(r.postCalls).toEqual(["A", "A", "A", "A"]);
    expect(r.reposts).toBe(3);
    expect(r.state.used).toBe(2);
    expect(r.fetchCalls).toEqual(["A"]);
    expect(sortedKeys(r.state.pending)).toEqual(["A", "B"]);
    expect(r.state.posted).toEqual({});
    expect(r.failed).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("502 then 201", async () => {
    const r = await simulate({
      list: okList(["A"]),
      post: (_id, n) => (n < 2 ? answer(502) : answer(201)),
    });
    expect(r.reposts).toBe(1);
    expect(r.postCalls).toEqual(["A", "A"]);
    expect(posted(r)).toEqual({ A: NOW });
    expect(r.state.pending).toEqual({});
  });

  it("502 then 503 then 201 posts on the third try", async () => {
    const r = await simulate({
      list: okList(["A"]),
      post: (_id, n) => (n === 1 ? answer(502) : n === 2 ? answer(503) : answer(201)),
    });
    expect(r.postCalls).toHaveLength(3);
    expect(posted(r)).toEqual({ A: NOW });
  });

  it("502 then 400 stops retrying and drops the id", async () => {
    const r = await simulate({
      list: okList(["A"]),
      post: (_id, n) => (n === 1 ? answer(502) : answer(400)),
    });
    expect(r.postCalls).toEqual(["A", "A"]);
    expect(r.rejected).toEqual(["A"]);
    expect(r.state.pending).toEqual({});
  });

  it("ingest retries spend no budget", async () => {
    const r = await simulate({ budget: 2, list: okList(["A"]), post: () => answer(503) });
    expect(r.reposts).toBe(3);
    expect(r.state.used).toBe(2);
  });

  it("500 keeps the id pending, retries nothing and the round continues", async () => {
    const r = await simulate({ list: okList(["A", "B"]), post: () => answer(500) });
    expect(r.postCalls).toEqual(["A", "B"]);
    expect(r.reposts).toBe(0);
    expect(sortedKeys(r.state.pending)).toEqual(["A", "B"]);
    expect(r.state.posted).toEqual({});
    expect(r.rejected).toEqual([]);
  });

  it("a 2xx other than 200 and 201 keeps the id pending", async () => {
    const r = await simulate({ list: okList(["A"]), post: () => answer(204) });
    expect(sortedKeys(r.state.pending)).toEqual(["A"]);
    expect(r.state.posted).toEqual({});
  });

  it("a post error item keeps the id pending and the round continues", async () => {
    const r = await simulate({ list: okList(["A", "B"]), post: () => ({ error: "socket" }) });
    expect(r.postCalls).toEqual(["A", "B"]);
    expect(r.reposts).toBe(0);
    expect(sortedKeys(r.state.pending)).toEqual(["A", "B"]);
    expect(r.rejected).toEqual([]);
  });

  it("an ingest 429 is a drop, not a Fireflies rate limit", async () => {
    const r = await simulate({
      list: okList(["A", "B"]),
      post: (id) => (id === "A" ? answer(429) : answer(201)),
    });
    expect(r.fetchCalls).toEqual(["A", "B"]);
    expect(r.rejected).toEqual(["A"]);
    expect(sortedKeys(posted(r))).toEqual(["A", "B"]);
  });

  it("an ingest body that looks like a Fireflies rate limit is read as the ingest answer", async () => {
    const body = { errors: [{ code: "too_many_requests" }] };
    const r = await simulate({ list: okList(["A", "B"]), post: () => answer(201, body) });
    expect(r.fetchCalls).toEqual(["A", "B"]);
    expect(sortedKeys(posted(r))).toEqual(["A", "B"]);
  });

  it("a stop never cuts pending work", async () => {
    const r = await simulate({
      list: okList(["A", "B", "C"]),
      post: (id) => (id === "B" ? answer(400) : answer(201)),
    });
    expect(r.postCalls).toEqual(["A", "B", "C"]);
    expect(r.events.at(-1)).toBe("rejected:B");
    expect(r.events.filter((e) => e.startsWith("rejected"))).toHaveLength(1);
    expect(sortedKeys(posted(r))).toEqual(["A", "B", "C"]);
    expect(r.state.pending).toEqual({});
  });

  it("a fetch failure stop is emitted after the later posts", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      list: okList(["BAD", "GOOD"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
      post: () => answer(201),
    });
    expect(r.postCalls).toEqual(["GOOD"]);
    expect(r.events.at(-1)).toBe("failed:BAD");
    expect(r.failed).toEqual(["BAD"]);
  });

  it("the first stop of a round wins", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      list: okList(["A", "BAD", "C"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
      post: (id) => (id === "A" ? answer(400) : answer(201)),
    });
    expect(r.rejected).toEqual(["A"]);
    expect(r.failed).toEqual([]);
    expect(r.events.at(-1)).toBe("rejected:A");
    expect(sortedKeys(r.state.pending)).toEqual(["BAD"]);
  });

  it("a fetch failure before a refusal keeps the failure as the stop", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      list: okList(["BAD", "A"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
      post: () => answer(400),
    });
    expect(r.failed).toEqual(["BAD"]);
    expect(r.rejected).toEqual([]);
    expect(r.events.at(-1)).toBe("failed:BAD");
    expect(r.state.pending).toEqual({ BAD: NOW });
  });

  it("a stop is still emitted when exhausted retries end the round", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      list: okList(["BAD", "B", "C"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
      post: () => answer(502),
    });
    expect(r.fetchCalls).toEqual(["BAD", "BAD", "BAD", "B"]);
    expect(r.postCalls).toHaveLength(4);
    expect(r.events.at(-1)).toBe("failed:BAD");
    expect(sortedKeys(r.state.pending)).toEqual(["B", "BAD", "C"]);
  });

  it("a stop is still emitted when the budget ends the round", async () => {
    const bad: Resp = { statusCode: 200, body: { data: { transcript: null } } };
    const r = await simulate({
      budget: 4,
      list: okList(["BAD", "GOOD"]),
      fetch: (id) => (id === "BAD" ? bad : okFetch(id)),
    });
    expect(r.events.at(-1)).toBe("failed:BAD");
    expect(sortedKeys(r.state.pending)).toEqual(["BAD", "GOOD"]);
  });

  it("webhook: a 201 is posted", async () => {
    const r = await simulate({ webhook: { meetingId: "hook1" }, post: () => answer(201) });
    expect(posted(r)).toEqual({ hook1: NOW });
    expect(r.state.pending).toEqual({});
  });

  it("webhook: a 400 is rejected", async () => {
    const r = await simulate({ webhook: { meetingId: "hook1" }, post: () => answer(400) });
    expect(r.rejected).toEqual(["hook1"]);
    expect(r.state.pending).toEqual({});
    expect(posted(r)).toEqual({ hook1: NOW });
  });

  it("a forged stop or queue in the carry is ignored", async () => {
    const state = fresh({ pending: { A: ago(1) } });
    const out = (await runCodeNode(CODE, {
      staticData: state,
      settings: settings(40),
      input: [answer(201)],
      matching: [
        {
          poll: {
            next: "post",
            id: "A",
            queue: ["__proto__", "bad id", "Q"],
            stop: { next: "post", id: "A" },
          },
          transcript: { id: "A" },
        },
      ],
    })) as Out[];
    expect(out.map((o) => o.poll)).toEqual([{ next: "fetch", id: "Q", attempt: 1, queue: [] }]);
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
      repost: "Post wait",
      rejected: "Ingest refused",
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
    expect(t.connections["Post wait"].main.map((o) => o.map((x) => x.node))).toEqual([
      ["Calendar events"],
    ]);
    expect(nodeByName(t, "Post wait").type).toBe("n8n-nodes-base.wait");
    expect(nodeByName(t, "Post wait").parameters).toEqual({
      resume: "timeInterval",
      amount: 60,
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

  it("Poll state is the last node on every path", () => {
    const problems = graphProblems(t);
    expect(problems).toEqual([]);
    const postOutputs = t.connections["Post meeting"].main.map((o) => o.map((x) => x.node));
    expect(postOutputs).toEqual([["Poll state"], ["Poll state"]]);
  });

  it("the graph check catches a post that does not come back", () => {
    const noError: N8nTemplate = structuredClone(t);
    noError.connections["Post meeting"].main[1] = [];
    expect(graphProblems(noError)).not.toEqual([]);
    const toStop: N8nTemplate = structuredClone(t);
    toStop.connections["Post meeting"].main[0] = [
      { node: "Source or calendar failed", type: "main", index: 0 },
    ];
    expect(graphProblems(toStop)).not.toEqual([]);
    const loose: N8nTemplate = structuredClone(t);
    loose.connections["Post wait"].main[0] = [];
    expect(graphProblems(loose)).not.toEqual([]);
  });

  it("an ingest refusal ends in Ingest refused and a retry goes through the calendar", () => {
    const stop = nodeByName(t, "Ingest refused");
    expect(stop.type).toBe("n8n-nodes-base.stopAndError");
    expect(reachable(t, "Ingest refused").size).toBe(0);
    expect(pathsAvoiding(t, "Post wait", "Post meeting", "Calendar events")).toEqual([]);
    expect(paths(t, "Post wait", "Post meeting").length).toBeGreaterThan(0);
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
