import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVaultConfig } from "../src/config/vault-config.js";
import {
  defaultGit,
  ensureClone,
  type GitApi,
  GitError,
  logChangedPaths,
} from "../src/git/index.js";
import { createMcpServer, type McpServerDeps } from "../src/mcp/server.js";
import { createReadTools, type ReadToolOptions, searchVault } from "../src/mcp/tools/read.js";
import { stringifyNote } from "../src/vault/frontmatter.js";
import { createNoteWriter, type VaultWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";

const RESOURCE = "https://brain.example.com/mcp";
const DAY = 86_400_000;
const HOUR = 3_600_000;
// Derived from the real clock (rounded down to the hour) so fixture commits are in the past, as in
// production; a fixed future date made git's --since behave differently across git versions.
const NOW = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const dayPrefix = (n: number) => new RegExp(`^${daysAgo(n).slice(0, 10)}`);

const rgAvailable = spawnSync("rg", ["--version"]).status === 0;
if (!rgAvailable) {
  console.warn("rg is not installed: the ripgrep-backed search tests are skipped");
}

let fixture: GitFixture;
let logs: string[];
let counter = 0;
const clients: Client[] = [];
const extraDirs: string[] = [];

beforeEach(async () => {
  // The seed commit is older than any window the tests ask for, so it never shows up in `recent`.
  fixture = createGitFixture(daysAgo(200));
  logs = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  fixture.cleanup();
});

function makeWriter(overrides: Partial<GitApi> = {}, vaultDir = fixture.vaultDir): VaultWriter {
  return createNoteWriter({
    vaultDir,
    author: TEST_AUTHOR,
    git: { ...defaultGit, ...overrides },
    log: (m) => logs.push(m),
    sleep: () => Promise.resolve(),
  });
}

interface Reply {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

/** An SDK client wired to a fresh server and transport per request, as the endpoint does. */
async function connect(
  seams: ReadToolOptions = {},
  writer: VaultWriter = makeWriter(),
  vaultDir = fixture.vaultDir,
) {
  const deps: McpServerDeps = { writer, config: { vaultDir } };
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const incoming = new Request(input, init);
    if (incoming.method !== "POST") return new Response(null, { status: 405 });
    const text = await incoming.text();
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const server = createMcpServer(deps, createReadTools({ now: () => NOW, ...seams }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(
        new Request(RESOURCE, { method: "POST", headers, body: text }),
        { parsedBody: JSON.parse(text) },
      );
      return new Response(await res.text(), { status: res.status, headers: res.headers });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
  const client = new Client({ name: "test-client", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch: fetchLike }));
  return {
    client,
    async call(name: string, args: Record<string, unknown>): Promise<Reply> {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.map((c) => c.text ?? "").join("\n");
      return { isError: res.isError === true, data: res.structuredContent ?? {}, text };
    },
  };
}

/** Commit `files` (and removals) from a second clone and push; dates are committer and author. */
function push(files: Record<string, string>, date?: string, removes: string[] = []): void {
  counter += 1;
  const dir = fixture.cloneElsewhere(`seed-${counter}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
  for (const path of removes) git(dir, ["rm", "-q", path]);
  const env: Record<string, string> = date
    ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
    : {};
  git(dir, ["commit", "-m", `seed ${counter}`], env);
  git(dir, ["push", "origin", "main"]);
}

const FM = { type: "idea", area: "personal", date: "2026-10-31", source: "manual" };
const note = (body: string, extra: Record<string, unknown> = {}) =>
  stringifyNote({ ...FM, ...extra }, body);

const results = (r: Reply) => r.data.results as Array<Record<string, unknown>>;
const paths = (r: Reply) => results(r).map((x) => x.path);

describe.skipIf(!rgAvailable)("search (R8.1)", () => {
  it("finds a phrase regardless of case and returns path, title, line and snippet", async () => {
    push({
      "inbox/a.md": note("first line\nThe Quarterly Budget is set\n", { title: "Budget plan" }),
    });
    const { call } = await connect();
    const r = await call("search", { query: "quarterly BUDGET" });
    expect(r.isError).toBe(false);
    expect(r.data.ok).toBe(true);
    expect(results(r)).toEqual([
      {
        path: "inbox/a.md",
        title: "Budget plan",
        line: expect.any(Number),
        snippet: "The Quarterly Budget is set",
      },
    ]);
    const line = results(r)[0]?.line as number;
    // the matched line is the 2nd body line; frontmatter lines come first
    expect(line).toBeGreaterThan(2);
    expect(r.data.stale).toBeUndefined();
  });

  it("treats .* as literal text", async () => {
    push({
      "inbox/lit.md": note("pattern a.*b here\n"),
      "inbox/other.md": note("aXXb only\n"),
    });
    const { call } = await connect();
    expect(paths(await call("search", { query: "a.*b" }))).toEqual(["inbox/lit.md"]);
  });

  it("treats -e as literal text and not as an rg option", async () => {
    push({ "inbox/flag.md": note("use the -e flag\n") });
    const { call } = await connect();
    const r = await call("search", { query: "-e" });
    expect(r.isError).toBe(false);
    expect(paths(r)).toEqual(["inbox/flag.md"]);
  });

  it("skips .git, dot folders and the archive folder", async () => {
    push({
      "inbox/in.md": note("needle visible\n"),
      "archive/old.md": note("needle archived\n"),
      ".2brain/x.md": note("needle config\n"),
      ".obsidian/x.md": note("needle app\n"),
    });
    writeFileSync(join(fixture.vaultDir, ".git", "x.md"), "needle in git\n");
    const { call } = await connect();
    expect(paths(await call("search", { query: "needle" }))).toEqual(["inbox/in.md"]);
  });

  it("follows the configured archive folder", async () => {
    push({
      ".2brain/config.yaml": "version: 1\nvault:\n  archive_folder: old\n",
      "old/a.md": note("needle old\n"),
      "archive/b.md": note("needle archive\n"),
    });
    const { call } = await connect();
    expect(paths(await call("search", { query: "needle" }))).toEqual(["archive/b.md"]);
  });

  it("returns one result per note, at the first matching line", async () => {
    push({ "inbox/two.md": note("needle one\nfiller\nneedle two\n") });
    const { call } = await connect();
    const r = await call("search", { query: "needle" });
    expect(results(r)).toHaveLength(1);
    expect(results(r)[0]?.snippet).toBe("needle one");
  });

  it("uses the file stem when the frontmatter has no title", async () => {
    push({ "inbox/no-title.md": note("needle\n") });
    const { call } = await connect();
    expect((await call("search", { query: "needle" })).data.results).toEqual([
      expect.objectContaining({ title: "no-title" }),
    ]);
  });

  it("cuts a long line to a window around the match without splitting a character", async () => {
    const long = `${"é".repeat(150)}needle${"ü".repeat(150)}`;
    push({ "inbox/long.md": note(`${long}\n`) });
    const { call } = await connect();
    const snippet = results(await call("search", { query: "needle" }))[0]?.snippet as string;
    expect(snippet).toContain("needle");
    expect(Buffer.byteLength(snippet)).toBeLessThanOrEqual(200);
    expect(snippet).not.toContain("�");
  });

  it("caps results: default 20, explicit limit, and at most 50", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 55; i += 1) {
      files[`inbox/n${String(i).padStart(2, "0")}.md`] = note("needle\n");
    }
    push(files);
    const { call } = await connect();
    expect(results(await call("search", { query: "needle" }))).toHaveLength(20);
    expect(results(await call("search", { query: "needle", limit: 3 }))).toHaveLength(3);
    expect(results(await call("search", { query: "needle", limit: 60 }))).toHaveLength(50);
  });

  it("accepts a 200 character query and rejects 201 or an empty one without echoing it", async () => {
    push({ "inbox/a.md": note("x\n") });
    const { call } = await connect();
    expect((await call("search", { query: "q".repeat(200) })).isError).toBe(false);
    const secret = "sentinel-".padEnd(201, "s");
    const tooLong = await call("search", { query: secret });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).not.toContain(secret);
    const empty = await call("search", { query: "" });
    expect(empty.isError).toBe(true);
    const multiline = await call("search", { query: "a\nb" });
    expect(multiline.isError).toBe(true);
  });

  it("returns search_timeout when rg is killed by its deadline", async () => {
    push({ "inbox/a.md": note("needle\n") });
    const dir = mkdtempSync(join(tmpdir(), "2brain-fake-rg-"));
    extraDirs.push(dir);
    const { exe, pidFile } = fakeSlowExe(dir, "rg");
    const { call } = await connect({ searchTimeoutMs: 500, rgPath: exe });
    const started = performance.now();
    const r = await call("search", { query: "needle" });
    // The fake rg sleeps far beyond the deadline: answering before it could
    // have finished proves the deadline killed it, whatever the machine load.
    expect(performance.now() - started).toBeLessThan(FAKE_SLEEP_MS / 2);
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ ok: false, error: "search_timeout" });
    // Under heavy load the kill can land before the fake wrote its pid file.
    if (existsSync(pidFile)) await expectGone(pidFile);
  });
});

/** How long the fake rg or git sleeps; far longer than any bound the tests wait for. */
const FAKE_SLEEP_MS = 30_000;

/** Waits until the fake child has written its pid file, i.e. it is really running. */
async function waitForStart(pidFile: string): Promise<void> {
  for (let i = 0; i < 1500; i += 1) {
    if (existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "") return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("the fake child never started");
}

/** A node script that records its pid and sleeps, standing in for rg or git. */
function fakeSlowExe(dir: string, name: string): { exe: string; pidFile: string } {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, name);
  const pidFile = join(dir, `${name}.pid`);
  writeFileSync(
    exe,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, ${FAKE_SLEEP_MS});\n`,
  );
  chmodSync(exe, 0o755);
  return { exe, pidFile };
}

async function expectGone(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  process.kill(pid, "SIGKILL");
  throw new Error("the child process is still running");
}

describe("abort signal reaches the child processes", () => {
  it("aborting a running search stops rg and answers search_timeout quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "2brain-fake-rg-"));
    extraDirs.push(dir);
    const { exe, pidFile } = fakeSlowExe(dir, "rg");
    const config = await loadVaultConfig(fixture.vaultDir);
    const controller = new AbortController();
    let abortedAt = 0;
    void waitForStart(pidFile).then(() => {
      abortedAt = performance.now();
      controller.abort();
    });
    const outcome = await searchVault(fixture.vaultDir, config, {
      query: "x",
      limit: 5,
      signal: controller.signal,
      timeoutMs: 120_000,
      rgPath: exe,
    });
    const answeredAt = performance.now();
    expect(outcome).toEqual({ ok: false, error: "search_timeout" });
    // Answered long before the fake rg would have finished on its own.
    expect(abortedAt).toBeGreaterThan(0);
    expect(answeredAt - abortedAt).toBeLessThan(FAKE_SLEEP_MS / 2);
    await expectGone(pidFile);
  });

  it("aborting git log stops git and rejects with GitError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "2brain-fake-git-"));
    extraDirs.push(dir);
    const { pidFile } = fakeSlowExe(dir, "git");
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
    try {
      const controller = new AbortController();
      let abortedAt = 0;
      void waitForStart(pidFile).then(() => {
        abortedAt = performance.now();
        controller.abort();
      });
      await expect(
        logChangedPaths(fixture.vaultDir, NOW, controller.signal),
      ).rejects.toBeInstanceOf(GitError);
      const answeredAt = performance.now();
      expect(abortedAt).toBeGreaterThan(0);
      expect(answeredAt - abortedAt).toBeLessThan(FAKE_SLEEP_MS / 2);
      await expectGone(pidFile);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe("search failures that need no rg", () => {
  it("an already aborted signal gives search_timeout", async () => {
    const config = await loadVaultConfig(fixture.vaultDir);
    const controller = new AbortController();
    controller.abort();
    const outcome = await searchVault(fixture.vaultDir, config, {
      query: "x",
      limit: 5,
      signal: controller.signal,
      timeoutMs: 2000,
      rgPath: "rg",
    });
    expect(outcome).toEqual({ ok: false, error: "search_timeout" });
  });

  it("a missing rg binary gives search_failed", async () => {
    const { call } = await connect({ rgPath: "rg-does-not-exist-xyz" });
    const r = await call("search", { query: "x" });
    expect(r.data).toEqual({ ok: false, error: "search_failed" });
    expect(r.text).not.toContain(fixture.root);
  });
});

describe.skipIf(!rgAvailable)("search over 10,000 notes (R8.4)", () => {
  const big = mkdtempSync(join(tmpdir(), "2brain-big-"));
  let ready = false;
  function build(): void {
    if (ready) return;
    git(big, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(join(big, "inbox"));
    for (let i = 0; i < 10_000; i += 1) {
      const last = i === 9_999;
      writeFileSync(
        join(big, "inbox", `n${String(i).padStart(5, "0")}.md`),
        note(`generated note ${i} about topic ${i % 97}\n${last ? "unique-last-phrase\n" : ""}`),
      );
    }
    ready = true;
  }
  afterAll(() => rmSync(big, { recursive: true, force: true }));

  it("answers in under 2 s and finds the last note", async () => {
    build();
    const writer = makeWriter({ pullRebase: async () => undefined }, big);
    const { call } = await connect({}, writer, big);
    const started = performance.now();
    const r = await call("search", { query: "unique-last-phrase" });
    const elapsed = performance.now() - started;
    expect(paths(r)).toEqual(["inbox/n09999.md"]);
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);

  it("a 1 ms deadline over the same notes gives search_timeout", async () => {
    build();
    const writer = makeWriter({ pullRebase: async () => undefined }, big);
    const { call } = await connect({ searchTimeoutMs: 1 }, writer, big);
    expect((await call("search", { query: "unique-last-phrase" })).data).toEqual({
      ok: false,
      error: "search_timeout",
    });
  }, 60_000);
});

describe("read (R8.2)", () => {
  it("returns the path, the frontmatter and the exact body", async () => {
    const body = "\nLine one\r\nLine two \n\n  indented\n";
    push({ "inbox/a.md": note(body, { title: "alpha" }) });
    const { call } = await connect();
    const r = await call("read", { path: "inbox/a.md" });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      ok: true,
      path: "inbox/a.md",
      frontmatter: { ...FM, title: "alpha" },
      body,
    });
    expect(typeof (r.data.frontmatter as Record<string, unknown>).date).toBe("string");
    expect((r.data.frontmatter as Record<string, unknown>).date).toMatch(/^2026-10-31/);
  });

  it("returns frontmatter null and the raw text when the frontmatter cannot be parsed", async () => {
    const raw = "---\nkey: [unclosed\n---\nbody text\n";
    push({ "inbox/bad.md": raw });
    const { call } = await connect();
    const r = await call("read", { path: "inbox/bad.md" });
    expect(r.data).toEqual({ ok: true, path: "inbox/bad.md", frontmatter: null, body: raw });
  });

  it("refuses a file over 1 MiB with note_too_large", async () => {
    push({ "inbox/big.md": note("x".repeat(1024 * 1024 + 1)) });
    const { call } = await connect();
    const r = await call("read", { path: "inbox/big.md" });
    expect(r.data).toEqual({ ok: false, error: "note_too_large" });
  });

  for (const path of ["../x.md", ".git/config", ".git/x.md", "/etc/passwd.md", "a\\b.md"]) {
    it(`gives unsafe_path for ${path}`, async () => {
      const { call } = await connect();
      const r = await call("read", { path });
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({ ok: false, error: "unsafe_path" });
      expect(r.text).not.toContain(fixture.root);
    });
  }

  it("gives unsafe_path for symlinks out of the vault or into .git, never leaking content", async () => {
    push({ "inbox/seed.md": note("x\n") });
    const outside = join(fixture.root, "outside.md");
    writeFileSync(outside, "outside secret content\n");
    const { call } = await connect();
    await call("read", { path: "inbox/seed.md" }); // pulls inbox/ into the clone
    symlinkSync(outside, join(fixture.vaultDir, "inbox", "out.md"));
    symlinkSync("../.git/config", join(fixture.vaultDir, "inbox", "g.md"));
    symlinkSync(fixture.root, join(fixture.vaultDir, "linkdir"));
    for (const path of ["inbox/out.md", "inbox/g.md", "linkdir/missing.md"]) {
      const r = await call("read", { path });
      expect(r.data, path).toEqual({ ok: false, error: "unsafe_path" });
      expect(r.text).not.toContain("outside secret");
      expect(r.text).not.toContain(fixture.root);
    }
  });

  it("allows a symlink that stays inside the vault", async () => {
    push({ "inbox/seed.md": note("inner body\n") });
    const { call } = await connect();
    await call("read", { path: "inbox/seed.md" });
    symlinkSync("seed.md", join(fixture.vaultDir, "inbox", "alias.md"));
    const r = await call("read", { path: "inbox/alias.md" });
    expect(r.data.ok).toBe(true);
  });

  it("gives note_not_found for a missing path and for a directory", async () => {
    push({ "inbox/x.md/inner.md": note("a\n") });
    const { call } = await connect();
    expect((await call("read", { path: "inbox/missing.md" })).data).toEqual({
      ok: false,
      error: "note_not_found",
    });
    expect((await call("read", { path: "inbox/x.md" })).data).toEqual({
      ok: false,
      error: "note_not_found",
    });
    expect((await call("read", { path: "inbox/seed.md/deeper.md" })).data).toEqual({
      ok: false,
      error: "note_not_found",
    });
  });

  it("still reads when the vault config is invalid", async () => {
    push({ ".2brain/config.yaml": "version: 2\n", "inbox/a.md": note("ok\n") });
    const { call } = await connect();
    expect((await call("read", { path: "inbox/a.md" })).data.ok).toBe(true);
  });
});

describe("recent (R8.3)", () => {
  const list = (r: Reply) => r.data.notes as Array<Record<string, unknown>>;

  it("lists only notes committed within 7 days by default", async () => {
    push({ "inbox/eight.md": note("b\n") }, daysAgo(8));
    push({ "inbox/six.md": note("a\n", { title: "Six" }) }, daysAgo(6));
    const { call } = await connect();
    const r = await call("recent", {});
    expect(list(r)).toEqual([
      {
        path: "inbox/six.md",
        title: "Six",
        type: "idea",
        date: expect.stringMatching(dayPrefix(6)),
      },
    ]);
  });

  it("caps days at 90", async () => {
    push({ "inbox/n100.md": note("b\n") }, daysAgo(100));
    push({ "inbox/n89.md": note("a\n") }, daysAgo(89));
    const { call } = await connect();
    const r = await call("recent", { days: 365 });
    expect(list(r).map((n) => n.path)).toEqual(["inbox/n89.md"]);
  });

  it("lists a path committed twice once with its newest date, newest first", async () => {
    push({ "inbox/old.md": note("v1\n"), "inbox/twice.md": note("v1\n") }, daysAgo(5));
    push({ "inbox/mid.md": note("m\n") }, daysAgo(3));
    push({ "inbox/twice.md": note("v2\n") }, daysAgo(1));
    const { call } = await connect();
    const r = await call("recent", {});
    expect(list(r).map((n) => n.path)).toEqual(["inbox/twice.md", "inbox/mid.md", "inbox/old.md"]);
    expect(list(r)[0]?.date).toMatch(dayPrefix(1));
  });

  it("reports the newest commit date of a path when the history has clock skew", async () => {
    push({ "inbox/skew.md": note("v1\n") }, daysAgo(2));
    push({ "inbox/skew.md": note("v2\n") }, daysAgo(3));
    const { call } = await connect();
    expect(list(await call("recent", {}))).toEqual([
      expect.objectContaining({
        path: "inbox/skew.md",
        date: expect.stringMatching(dayPrefix(2)),
      }),
    ]);
  });

  it("orders different paths by commit date even when the history is skewed", async () => {
    push({ "inbox/a.md": note("a\n") }, daysAgo(2));
    push({ "inbox/b.md": note("b\n") }, daysAgo(3));
    const { call } = await connect();
    expect(list(await call("recent", {})).map((n) => n.path)).toEqual(["inbox/a.md", "inbox/b.md"]);
  });

  it("ignores a committed file name that imitates a log record header", async () => {
    const evil = "inbox/a\u001e2099-01-01T00:00:00+00:00";
    try {
      push({ [evil]: "x\n", "inbox/z.md": note("z\n") }, daysAgo(5));
    } catch {
      return; // the filesystem refuses the name
    }
    const { call } = await connect();
    const r = await call("recent", {});
    expect(list(r)).toEqual([
      expect.objectContaining({ path: "inbox/z.md", date: expect.stringMatching(dayPrefix(5)) }),
    ]);
  });

  it("does not read a title or type through a directory swapped for a symlink", async () => {
    push({ "linked/leak.md": note("needle\n", { title: "Inside title" }) }, daysAgo(1));
    git(fixture.vaultDir, ["pull", "--ff-only"]);
    const outside = join(fixture.root, "outside-dir");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "leak.md"),
      stringifyNote({ ...FM, title: "OUTSIDE TITLE", type: "outside-type" }, "needle\n"),
    );
    rmSync(join(fixture.vaultDir, "linked"), { recursive: true });
    symlinkSync(outside, join(fixture.vaultDir, "linked"));
    const writer = makeWriter({ pullRebase: async () => undefined });
    const { call } = await connect({}, writer);
    const r = await call("recent", {});
    expect(list(r)).toEqual([]);
    expect(r.text).not.toContain("OUTSIDE");
    if (rgAvailable) {
      const found = await call("search", { query: "needle" });
      expect(found.text).not.toContain("OUTSIDE");
    }
  });

  it("defaults to 20 results and caps limit at 50", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 55; i += 1) files[`inbox/n${String(i).padStart(2, "0")}.md`] = note("x\n");
    push(files, daysAgo(2));
    const { call } = await connect();
    expect(list(await call("recent", {}))).toHaveLength(20);
    expect(list(await call("recent", { limit: 60 }))).toHaveLength(50);
    expect(list(await call("recent", { limit: 2 }))).toHaveLength(2);
  });

  it("reads type and title from the frontmatter, and skips archived and deleted notes", async () => {
    push(
      {
        "inbox/keep.md": note("a\n", { title: "Kept", type: "idea" }),
        "inbox/gone.md": note("b\n"),
        "archive/old.md": note("c\n"),
        "inbox/plain.txt": "not a note\n",
      },
      daysAgo(2),
    );
    push({}, daysAgo(1), ["inbox/gone.md"]);
    const { call } = await connect();
    const r = await call("recent", {});
    expect(list(r).map((n) => n.path)).toEqual(["inbox/keep.md"]);
    expect(list(r)[0]).toMatchObject({ title: "Kept", type: "idea" });
  });

  it("gives git_failed when the vault is not a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "2brain-plain-"));
    extraDirs.push(plain);
    const { call } = await connect({}, makeWriter({}, plain), plain);
    const r = await call("recent", {});
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ ok: false, error: "git_failed" });
    expect(r.text).not.toContain(plain);
  });
});

describe("config_invalid", () => {
  it("search and recent answer config_invalid", async () => {
    push({ ".2brain/config.yaml": "version: 2\n", "inbox/a.md": note("needle\n") });
    const { call } = await connect();
    expect((await call("search", { query: "needle" })).data).toEqual({
      ok: false,
      error: "config_invalid",
    });
    expect((await call("recent", {})).data).toEqual({ ok: false, error: "config_invalid" });
  });
});

describe("pull behavior (D1)", () => {
  it("finds a note pushed from another clone after the first call, without a restart", async () => {
    push({ "inbox/a.md": note("first\n") });
    const { call } = await connect();
    expect((await call("read", { path: "inbox/a.md" })).data.ok).toBe(true);
    expect((await call("read", { path: "inbox/b.md" })).data.error).toBe("note_not_found");
    push({ "inbox/b.md": note("second\n") });
    expect((await call("read", { path: "inbox/b.md" })).data.ok).toBe(true);
  });

  it("a failed pull still returns each result, with stale true", async () => {
    push({ "inbox/a.md": note("needle\n") });
    const warm = await connect();
    await warm.call("read", { path: "inbox/a.md" });
    const failing = makeWriter({
      pullRebase: async () => {
        throw new GitError("pull", 1);
      },
    });
    const { call } = await connect({}, failing);
    const read = await call("read", { path: "inbox/a.md" });
    expect(read.data).toMatchObject({ ok: true, stale: true });
    const recent = await call("recent", {});
    expect(recent.data).toMatchObject({ ok: true, stale: true });
    expect(logs.filter((l) => l === "read_pull_failed")).toHaveLength(2);
    if (rgAvailable) {
      expect((await call("search", { query: "needle" })).data).toMatchObject({
        ok: true,
        stale: true,
      });
    }
  });
});

describe("error text hygiene (D3) and tools never write", () => {
  it("leaves the working tree and HEAD untouched", async () => {
    push({ "inbox/a.md": note("needle\n") });
    const { call } = await connect();
    await call("read", { path: "inbox/a.md" });
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    await call("recent", {});
    await call("read", { path: "inbox/a.md" });
    if (rgAvailable) await call("search", { query: "needle" });
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });
});
