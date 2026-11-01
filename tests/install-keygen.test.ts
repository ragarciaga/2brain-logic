import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDeployKey, execFileRunner, type Runner } from "../src/install/ssh.js";

const POSIX = process.platform !== "win32";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keygen-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[]; opts: { timeoutMs: number } };

function fakeRunner(
  behavior: (path: string) => number | Promise<number>,
): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const path = args[args.length - 1] as string;
    return { code: await behavior(path) };
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

const writesStubs = (path: string): number => {
  writeFileSync(path, "stub-private");
  writeFileSync(`${path}.pub`, "stub-public");
  // Modes the installer must correct whatever the umask is.
  chmodSync(path, 0o644);
  chmodSync(`${path}.pub`, 0o600);
  return 0;
};

const secrets = () => join(dir, "secrets");

describe("ensureDeployKey: existing key", () => {
  it("keeps existing key", async () => {
    mkdirSync(secrets(), { mode: 0o700 });
    writeFileSync(join(secrets(), "deploy_key"), "old-private");
    writeFileSync(join(secrets(), "deploy_key.pub"), "old-public");
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toEqual({ ok: true, created: false });
    expect(run.calls).toHaveLength(0);
    expect(readFileSync(join(secrets(), "deploy_key"), "utf8")).toBe("old-private");
    expect(readFileSync(join(secrets(), "deploy_key.pub"), "utf8")).toBe("old-public");
  });

  it("keeps existing key without pub", async () => {
    mkdirSync(secrets(), { mode: 0o700 });
    writeFileSync(join(secrets(), "deploy_key"), "old-private");
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toEqual({ ok: true, created: false });
    expect(run.calls).toHaveLength(0);
    expect(existsSync(join(secrets(), "deploy_key.pub"))).toBe(false);
  });
});

describe("ensureDeployKey: creation", () => {
  it("creates", async () => {
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toEqual({ ok: true, created: true });
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0] as Call;
    expect(call.cmd).toBe("ssh-keygen");
    const f = call.args[call.args.length - 1] as string;
    expect(call.args).toEqual([
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "2brain deploy key",
      "-f",
      f,
    ]);
    expect(f.startsWith(`${secrets()}/`)).toBe(true);
    expect(f.endsWith("/deploy_key")).toBe(true);
    expect(dirname(dirname(f))).toBe(secrets());
    expect(readFileSync(join(secrets(), "deploy_key"), "utf8")).toBe("stub-private");
    expect(readFileSync(join(secrets(), "deploy_key.pub"), "utf8")).toBe("stub-public");
    expect(readdirSync(secrets()).sort()).toEqual(["deploy_key", "deploy_key.pub"]);
    if (POSIX) {
      expect(statSync(secrets()).mode & 0o777).toBe(0o700);
      expect(statSync(join(secrets(), "deploy_key")).mode & 0o777).toBe(0o600);
      expect(statSync(join(secrets(), "deploy_key.pub")).mode & 0o777).toBe(0o644);
    }
  });

  it.skipIf(!POSIX)("chmods an existing wide secrets dir", async () => {
    mkdirSync(secrets());
    chmodSync(secrets(), 0o755);
    await ensureDeployKey(dir, fakeRunner(writesStubs));
    expect(statSync(secrets()).mode & 0o777).toBe(0o700);
  });
});

describe("ensureDeployKey: failures", () => {
  it("cleans partial key when the runner throws", async () => {
    const run = fakeRunner((path) => {
      writeFileSync(path, "partial-private");
      throw new Error("boom: runner-output-marker");
    });
    const result = await ensureDeployKey(dir, run);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("keygen_failed");
    expect(result.message).not.toContain("runner-output-marker");
    expect(readdirSync(secrets())).toEqual([]);
  });

  it("cleans partial key when the runner exits non-zero", async () => {
    const run = fakeRunner((path) => {
      writesStubs(path);
      return 1;
    });
    const result = await ensureDeployKey(dir, run);
    expect(result).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(readdirSync(secrets())).toEqual([]);
  });

  it("runner reports success but writes nothing", async () => {
    const result = await ensureDeployKey(
      dir,
      fakeRunner(() => 0),
    );
    expect(result).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(readdirSync(secrets())).toEqual([]);
  });

  it("runner reports success but writes only the private key", async () => {
    const result = await ensureDeployKey(
      dir,
      fakeRunner((path) => {
        writeFileSync(path, "x");
        return 0;
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(readdirSync(secrets())).toEqual([]);
  });
});

describe.skipIf(!POSIX)("ensureDeployKey: rename failure", () => {
  it("removes the moved pub when the private rename fails", async () => {
    const run = fakeRunner((path) => {
      writesStubs(path);
      // A directory appears at the final name after the first check, so the rename fails.
      mkdirSync(join(secrets(), "deploy_key"));
      writeFileSync(join(secrets(), "deploy_key", "keep"), "x");
      return 0;
    });
    expect(await ensureDeployKey(dir, run)).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(readdirSync(secrets())).toEqual(["deploy_key"]);
    expect(readFileSync(join(secrets(), "deploy_key", "keep"), "utf8")).toBe("x");
  });
});

describe.skipIf(!POSIX)("ensureDeployKey: refuses non-regular paths", () => {
  it("symlinked deploy_key", async () => {
    mkdirSync(secrets());
    const target = join(dir, "target");
    writeFileSync(target, "target-bytes");
    symlinkSync(target, join(secrets(), "deploy_key"));
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(run.calls).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe("target-bytes");
  });

  it("dangling symlink deploy_key", async () => {
    mkdirSync(secrets());
    const target = join(dir, "missing");
    symlinkSync(target, join(secrets(), "deploy_key"));
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(run.calls).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
  });

  it("symlinked secrets dir", async () => {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, secrets());
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(run.calls).toHaveLength(0);
    expect(readdirSync(real)).toEqual([]);
  });

  it("deploy_key is a directory", async () => {
    mkdirSync(join(secrets(), "deploy_key"), { recursive: true });
    const run = fakeRunner(writesStubs);
    expect(await ensureDeployKey(dir, run)).toMatchObject({ ok: false, code: "keygen_failed" });
    expect(run.calls).toHaveLength(0);
  });
});

describe("execFileRunner", () => {
  it("maps exit codes and failures to a code", async () => {
    const opts = { timeoutMs: 10000 };
    expect(await execFileRunner(process.execPath, ["-e", "process.exit(0)"], opts)).toEqual({
      code: 0,
    });
    expect(await execFileRunner(process.execPath, ["-e", "process.exit(3)"], opts)).toEqual({
      code: 3,
    });
    const missing = await execFileRunner("2brain-no-such-binary", [], opts);
    expect(missing.code).not.toBe(0);
  });

  it("does not expose child output", async () => {
    const result = await execFileRunner(
      process.execPath,
      ["-e", "console.error('child-output-marker'); process.exit(2)"],
      { timeoutMs: 10000 },
    );
    expect(result).toEqual({ code: 2 });
  });
});
