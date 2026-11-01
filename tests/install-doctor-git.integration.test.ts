import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneInto, GitError } from "../src/git/index.js";
import { CHECK_IDS, type CheckId, type DoctorCheck, runDoctor } from "../src/install/doctor.js";
import {
  createGitChecks,
  FIX_NO_BRANCH,
  FIX_NO_CLONE,
  FIX_REMOTE_AUTH,
  FIX_REMOTE_TIMEOUT,
  FIX_REMOTE_UNREACHABLE,
  FIX_WRITE_ACCESS,
} from "../src/install/doctor-git.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const win32 = process.platform === "win32";
const MARKER = "stderr-marker-7f3a";

let fixture: GitFixture;

beforeEach(() => {
  fixture = createGitFixture();
});

afterEach(() => {
  vi.useRealTimers();
  fixture.cleanup();
});

function checks(deps = {}) {
  const list = createGitChecks({ vaultDir: fixture.vaultDir, deps });
  const byId = (id: CheckId) => list.find((c) => c.id === id) as DoctorCheck;
  return { list, byId };
}

async function cloned() {
  await cloneInto(fixture.remote, fixture.vaultDir);
}

function refuseReceivePack(): void {
  const script = join(fixture.root, "refuse.sh");
  writeFileSync(script, `#!/bin/sh\necho ${MARKER} >&2\nexit 1\n`);
  chmodSync(script, 0o755);
  git(fixture.vaultDir, ["config", "remote.origin.receivepack", script]);
}

function snapshot(
  root: string,
  out: Record<string, string> = {},
  rel = "",
): Record<string, string> {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  const head = `${(st.mode & 0o7777).toString(8)}:${st.mtimeMs}`;
  if (st.isDirectory()) {
    out[rel || "."] = head;
    for (const name of readdirSync(abs).sort()) snapshot(root, out, join(rel, name));
  } else if (st.isFile()) {
    out[rel] = `${head}:${readFileSync(abs).toString("base64")}`;
  } else {
    out[rel] = head;
  }
  return out;
}

describe("remote_reachable", () => {
  it("passes on a live remote", async () => {
    await cloned();
    expect(await checks().byId("remote_reachable").run()).toStrictEqual({ status: "pass" });
  });

  it("fails when the remote path is missing", async () => {
    await cloned();
    git(fixture.vaultDir, ["remote", "set-url", "origin", join(fixture.root, "nowhere.git")]);
    expect(await checks().byId("remote_reachable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_REMOTE_UNREACHABLE,
    });
  });

  it("fails without a clone", async () => {
    expect(await checks().byId("remote_reachable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_NO_CLONE,
    });
  });

  it("fails with the deploy key fix when the remote refuses the key", async () => {
    await cloned();
    const lsRemote = async () => {
      throw new GitError("ls-remote", 128, true);
    };
    expect(await checks({ lsRemote }).byId("remote_reachable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_REMOTE_AUTH,
    });
  });

  it("fails without a clone when the directory exists but holds no repository", async () => {
    mkdirSync(fixture.vaultDir);
    for (const id of ["remote_reachable", "remote_pushable", "vault_config"] as const) {
      expect(await checks().byId(id).run()).toStrictEqual({ status: "fail", fix: FIX_NO_CLONE });
    }
  });

  it("fails with the timeout fix when git reports its own timeout", async () => {
    await cloned();
    const lsRemote = async () => {
      throw new GitError("ls-remote", null);
    };
    expect(await checks({ lsRemote }).byId("remote_reachable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_REMOTE_TIMEOUT,
    });
  });

  it("times out at 15 s with a hanging runner", async () => {
    await cloned();
    vi.useFakeTimers();
    const { byId } = checks({
      hasClone: async () => true,
      lsRemote: () => new Promise<string[]>(() => {}),
    });
    let outcome: unknown;
    const pending = byId("remote_reachable")
      .run()
      .then((o) => {
        outcome = o;
      });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toStrictEqual({ status: "fail", fix: FIX_REMOTE_TIMEOUT });
  });
});

describe("remote_pushable", () => {
  it("passes on a writable remote", async () => {
    await cloned();
    expect(await checks().byId("remote_pushable").run()).toStrictEqual({ status: "pass" });
  });

  it.skipIf(win32)("fails with the write access fix when the remote refuses", async () => {
    await cloned();
    refuseReceivePack();
    const outcome = await checks().byId("remote_pushable").run();
    expect(outcome).toStrictEqual({ status: "fail", fix: FIX_WRITE_ACCESS });
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
  });

  it("fails on a detached HEAD without running push", async () => {
    await cloned();
    git(fixture.vaultDir, ["checkout", "--detach"]);
    const pushDryRun = vi.fn(async () => {});
    expect(await checks({ pushDryRun }).byId("remote_pushable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_NO_BRANCH,
    });
    expect(pushDryRun).not.toHaveBeenCalled();
  });

  it("fails on a hostile branch name without running push", async () => {
    await cloned();
    const pushDryRun = vi.fn(async () => {});
    const currentBranch = async () => "-x";
    expect(await checks({ pushDryRun, currentBranch }).byId("remote_pushable").run()).toStrictEqual(
      { status: "fail", fix: FIX_NO_BRANCH },
    );
    expect(pushDryRun).not.toHaveBeenCalled();
  });

  it("fails with the timeout fix when git push reports its own timeout", async () => {
    await cloned();
    const pushDryRun = async () => {
      throw new GitError("push", null);
    };
    expect(await checks({ pushDryRun }).byId("remote_pushable").run()).toStrictEqual({
      status: "fail",
      fix: FIX_REMOTE_TIMEOUT,
    });
  });

  it("times out at 15 s with a hanging push", async () => {
    await cloned();
    vi.useFakeTimers();
    const { byId } = checks({
      hasClone: async () => true,
      currentBranch: async () => "main",
      pushDryRun: () => new Promise<void>(() => {}),
    });
    let outcome: unknown;
    const pending = byId("remote_pushable")
      .run()
      .then((o) => {
        outcome = o;
      });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toStrictEqual({ status: "fail", fix: FIX_REMOTE_TIMEOUT });
  });
});

describe("vault_config", () => {
  const run = () => checks().byId("vault_config").run();

  it("fails for a missing clone", async () => {
    expect(await run()).toStrictEqual({ status: "fail", fix: FIX_NO_CLONE });
  });

  it("fails for an invalid key and names the file and key path", async () => {
    await cloned();
    mkdirSync(join(fixture.vaultDir, ".2brain"));
    writeFileSync(join(fixture.vaultDir, ".2brain", "config.yaml"), "areas: 5\n");
    expect(await run()).toStrictEqual({
      status: "fail",
      fix: ".2brain/config.yaml is invalid at areas: correct it or re-run setup",
    });
  });

  it("fails for bad YAML", async () => {
    await cloned();
    mkdirSync(join(fixture.vaultDir, ".2brain"));
    writeFileSync(join(fixture.vaultDir, ".2brain", "config.yaml"), "areas: [unclosed\n");
    expect(await run()).toStrictEqual({
      status: "fail",
      fix: ".2brain/config.yaml is not valid YAML: correct it or re-run setup",
    });
  });

  it("passes for a valid config and for a clone without one", async () => {
    await cloned();
    expect(await run()).toStrictEqual({ status: "pass" });
    mkdirSync(join(fixture.vaultDir, ".2brain"));
    writeFileSync(join(fixture.vaultDir, ".2brain", "config.yaml"), "areas:\n  - work\n");
    expect(await run()).toStrictEqual({ status: "pass" });
  });
});

describe("read-only guarantee", () => {
  const state = () => ({
    tree: snapshot(fixture.root),
    refs: git(fixture.remote, ["for-each-ref"]),
  });

  async function runAll(): Promise<void> {
    for (const c of checks().list) await c.run();
  }

  it("git checks change nothing when everything passes", async () => {
    await cloned();
    mkdirSync(join(fixture.root, "secrets"));
    writeFileSync(join(fixture.root, "secrets", "known_hosts"), "x\n");
    const before = state();
    await new Promise((r) => setTimeout(r, 20));
    await runAll();
    expect(state()).toStrictEqual(before);
  });

  it.skipIf(win32)("git checks change nothing when the push is refused", async () => {
    await cloned();
    refuseReceivePack();
    const before = state();
    await new Promise((r) => setTimeout(r, 20));
    await runAll();
    expect(state()).toStrictEqual(before);
  });
});

describe("fix lines survive redaction", () => {
  it.skipIf(win32)("prints the exact fixed lines and no remote host or stderr marker", async () => {
    await cloned();
    refuseReceivePack();
    const [reachable, pushable, config] = checks().list as [DoctorCheck, DoctorCheck, DoctorCheck];
    const unreachable = createGitChecks({
      vaultDir: fixture.vaultDir,
      deps: {
        lsRemote: async () => {
          throw new GitError("ls-remote", 128);
        },
      },
    })[0] as DoctorCheck;
    expect(await reachable.run()).toStrictEqual({ status: "pass" });
    const all: DoctorCheck[] = CHECK_IDS.map((id) => {
      if (id === "remote_reachable") return unreachable;
      if (id === "remote_pushable") return pushable;
      if (id === "vault_config") return config;
      return { id, run: async () => ({ status: "pass" as const }) };
    });
    const lines: string[] = [];
    await runDoctor(all, {
      env: { VAULT_REMOTE: "ssh://git@git.example.com/owner/vault.git" },
      out: (l) => lines.push(l),
    });
    const text = lines.join("\n");
    expect(lines).toContain(`      fix: ${FIX_REMOTE_UNREACHABLE}`);
    expect(lines).toContain(`      fix: ${FIX_WRITE_ACCESS}`);
    expect(text).not.toContain("git.example.com");
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("<redacted>");
  });
});
