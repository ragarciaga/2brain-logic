import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROGRESS_HEADER } from "../../plugin/scripts/lib/progress.mjs";
import { makePluginFixture } from "../helpers/plugin-fixture.js";

type Fixture = ReturnType<typeof makePluginFixture>;
let fx: Fixture;

afterEach(async () => {
  await fx?.cleanup();
});

function endState(f: Fixture, sessionId: string, exitedAt: number) {
  const runs = f.runs();
  expect(runs).toHaveLength(1);
  const run = runs[0];
  expect(run.start).toBeGreaterThan(exitedAt);
  expect(run.end ?? 0).toBeGreaterThan(exitedAt);
  expect(f.state().sessions[sessionId]).toBeDefined();
  expect(f.queueJobs()).toEqual([]);
  return run;
}

describe.skipIf(process.platform === "win32")("hook and worker (real hook, fake claude)", () => {
  it("detached capture: the hook returns at once and the worker finishes alone", async () => {
    fx = makePluginFixture();
    const before = fx.snapshot(fx.cwd);
    const p = fx.runParent(fx.event);

    expect(p.exit).toBe(0);
    expect(p.elapsedMs).toBeLessThan(1000);
    expect(p.stdout).toBe("");
    expect(p.stderr).toBe("");
    expect(p.jobs).toHaveLength(1);

    expect(await fx.waitFor(() => / saved notes=/.test(fx.logLines().at(-1) ?? ""), 15000)).toBe(
      true,
    );
    const run = endState(fx, "e2e-session-01", p.exitedAt);
    expect(fx.pidGone(p.parentPid)).toBe(true);
    expect(fx.pidGone(p.hookPid)).toBe(true);
    expect(fx.snapshot(fx.cwd)).toEqual(before);
    expect(run.stdin).toContain(PROGRESS_HEADER);
  }, 40000);

  it("nested hook: the capture run does not queue another capture", async () => {
    fx = makePluginFixture();
    const hook = resolve("plugin", "scripts", "session-end.mjs");
    const fire = join(fx.root, "fire.json");
    writeFileSync(
      fire,
      JSON.stringify({ hook, event: { ...fx.event, session_id: "nested-session-02" } }),
    );
    const before = fx.snapshot(fx.cwd);
    const p = fx.runParent(fx.event, { FAKE_CLAUDE_FIRE_HOOK: fire });
    expect(p.exit).toBe(0);
    expect(p.jobs).toHaveLength(1);

    expect(await fx.waitFor(() => / saved/.test(fx.logLines().at(-1) ?? ""), 15000)).toBe(true);
    expect(
      await fx.waitFor(() => fx.runs().length === 1 && fx.pidGone(fx.runs()[0].ppid), 15000),
    ).toBe(true);
    const run = endState(fx, "e2e-session-01", p.exitedAt);
    expect(run.env.TWOBRAIN_CAPTURE).toBe("1");
    expect(run.firedHook?.exit).toBe(0);
    expect(run.firedHook?.stdout).toBe("");
    expect(run.firedHook?.stderr).toBe("");
    expect(run.firedHook?.queue).toEqual(p.jobs);
    expect(fx.logLines()).toHaveLength(1);
    expect(fx.state().sessions["nested-session-02"]).toBeUndefined();
    expect(fx.snapshot(fx.cwd)).toEqual(before);
    expect(run.stdin).toContain(PROGRESS_HEADER);
  }, 40000);
});
