import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInvocation, checkApiHelper } from "../../plugin/scripts/lib/headless.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";

const root = mkdtempSync(join(tmpdir(), "headless-env-"));
const paths = { pluginRoot: root, dataDir: join(root, "data") };
const settings = readSettings({});
const STRIPPED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

type Env = Record<string, string | undefined>;

function run(env: Env, platform?: string): { argv: string[]; env: Env; cwd: string } {
  const out = buildInvocation(settings, env, paths, platform ? { platform } : {});
  if ("error" in out) throw new Error("unexpected error");
  return out;
}

describe("buildInvocation env", () => {
  it.each(STRIPPED)("removes %s on linux and keeps the rest", (name) => {
    const env: Env = { [name]: "marker-1", PATH: "marker-2", EMPTY: undefined };
    const snapshot = { ...env };
    const out = run(env, "linux");
    expect(out.env).toStrictEqual({ PATH: "marker-2", EMPTY: undefined, TWOBRAIN_CAPTURE: "1" });
    expect(env).toStrictEqual(snapshot);
    expect(out.env).not.toBe(env);
  });

  it("keeps lowercase and mixed-case variants on linux", () => {
    const env: Env = { anthropic_api_key: "marker-1", Claude_Code_Use_Vertex: "marker-2" };
    expect(run(env, "linux").env).toStrictEqual({ ...env, TWOBRAIN_CAPTURE: "1" });
  });

  it("removes every case variant on win32", () => {
    const env: Env = { PATH: "marker-0" };
    STRIPPED.forEach((name, i) => {
      env[name.toLowerCase()] = `marker-l${i}`;
      env[name.replace(/_(.)/g, (_m, c: string) => `_${c.toLowerCase()}`)] = `marker-m${i}`;
      env[name] = `marker-u${i}`;
    });
    expect(run(env, "win32").env).toStrictEqual({ PATH: "marker-0", TWOBRAIN_CAPTURE: "1" });
  });

  it.each([undefined, "0", ""])("forces TWOBRAIN_CAPTURE=1 from %j", (value) => {
    const env: Env = value === undefined ? {} : { TWOBRAIN_CAPTURE: value };
    expect(run(env, "linux").env.TWOBRAIN_CAPTURE).toBe("1");
  });

  it("leaves one TWOBRAIN_CAPTURE key on win32 whatever the input case", () => {
    const out = run({ twobrain_capture: "0", Twobrain_Capture: "2" }, "win32");
    expect(out.env).toStrictEqual({ TWOBRAIN_CAPTURE: "1" });
  });

  it("returns the data dir as cwd and --setting-sources user once", () => {
    const out = run({});
    expect(out.cwd).toBe(paths.dataDir);
    expect(out.cwd).not.toBe(process.cwd());
    expect(out.argv.filter((a) => a === "--setting-sources")).toHaveLength(1);
    expect(out.argv[out.argv.indexOf("--setting-sources") + 1]).toBe("user");
  });

  it("still rejects an invalid server_name without an env", () => {
    const out = buildInvocation({ ...settings, server_name: "a b" }, { A: "1" }, paths);
    expect(out).toStrictEqual({ error: "not_configured" });
  });
});

describe("checkApiHelper", () => {
  function dirWith(content: string | null): string {
    const dir = mkdtempSync(join(root, "cfg-"));
    if (content !== null) writeFileSync(join(dir, "settings.json"), content);
    return dir;
  }
  function homeWith(content: string): string {
    const home = mkdtempSync(join(root, "home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), content);
    return home;
  }
  const helper = JSON.stringify({ apiKeyHelper: "marker-helper" });
  const call = (home: string, env: Env) => {
    expect(() => checkApiHelper({ home, env })).not.toThrow();
    return checkApiHelper({ home, env });
  };

  it("reads CLAUDE_CONFIG_DIR first", () => {
    expect(call(root, { CLAUDE_CONFIG_DIR: dirWith(helper) })).toBe("api_helper_present");
  });

  it("ignores home/.claude when CLAUDE_CONFIG_DIR is set", () => {
    expect(call(homeWith(helper), { CLAUDE_CONFIG_DIR: dirWith("{}") })).toBe("ok");
  });

  it.each([undefined, ""])("falls back to home/.claude when CLAUDE_CONFIG_DIR is %j", (v) => {
    expect(call(homeWith(helper), { CLAUDE_CONFIG_DIR: v })).toBe("api_helper_present");
  });

  it("counts a whitespace-only helper as present", () => {
    expect(call(homeWith('{"apiKeyHelper":" "}'), {})).toBe("api_helper_present");
  });

  it.each(["{}", '{"apiKeyHelper":""}', '{"apiKeyHelper":1}', "null", "[]", "not json"])(
    "gives ok for %s",
    (content) => {
      expect(call(homeWith(content), {})).toBe("ok");
    },
  );

  it("gives ok when the file is missing", () => {
    expect(call(root, { CLAUDE_CONFIG_DIR: dirWith(null) })).toBe("ok");
  });

  it("gives ok when settings.json is a directory", () => {
    const dir = mkdtempSync(join(root, "cfg-"));
    mkdirSync(join(dir, "settings.json"));
    expect(call(root, { CLAUDE_CONFIG_DIR: dir })).toBe("ok");
  });
});
