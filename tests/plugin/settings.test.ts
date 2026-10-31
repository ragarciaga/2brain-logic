import { describe, expect, it } from "vitest";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";

const P = "CLAUDE_PLUGIN_OPTION_";

describe("readSettings", () => {
  it("returns the defaults for an empty env", () => {
    expect(readSettings({})).toStrictEqual({
      area: "",
      server_name: "brain",
      model: "sonnet",
      min_user_prompts: 3,
      note_language: "en",
      enabled: true,
    });
  });

  it.each([
    ["AREA", "work", "area"],
    ["SERVER_NAME", "vault", "server_name"],
    ["MODEL", "opus", "model"],
    ["MIN_USER_PROMPTS", "5", "min_user_prompts"],
    ["NOTE_LANGUAGE", "es", "note_language"],
    ["ENABLED", "false", "enabled"],
  ])("reads %s", (key, value, field) => {
    const expected = { min_user_prompts: 5, enabled: false } as Record<string, unknown>;
    const got = readSettings({ [P + key]: value }) as Record<string, unknown>;
    expect(got[field]).toBe(field in expected ? expected[field] : value);
  });

  it("ignores lower-case keys", () => {
    expect(readSettings({ [`${P}model`]: "opus", [`${P}area`]: "work" })).toStrictEqual(
      readSettings({}),
    );
  });

  it.each(["false", "FALSE", "False", "0"])("enabled is false for %s", (v) => {
    expect(readSettings({ [`${P}ENABLED`]: v }).enabled).toBe(false);
  });

  it.each([undefined, "", "true", "1", "no"])("enabled is true for %s", (v) => {
    expect(readSettings({ [`${P}ENABLED`]: v }).enabled).toBe(true);
  });

  it.each([
    ["0", 0],
    ["7", 7],
    ["", 3],
    ["abc", 3],
    ["-1", 3],
    ["2.5", 3],
    ["3.0", 3],
    ["7.0", 3],
    ["+5", 3],
    [" 5", 3],
    ["1e2", 3],
    ["99999999999999999999", 3],
  ])("min_user_prompts %j gives %d", (v, n) => {
    expect(readSettings({ [`${P}MIN_USER_PROMPTS`]: v }).min_user_prompts).toBe(n);
  });

  it("empty strings give the defaults and area stays empty", () => {
    const env = {
      [`${P}AREA`]: "",
      [`${P}SERVER_NAME`]: "",
      [`${P}MODEL`]: "",
      [`${P}NOTE_LANGUAGE`]: "",
    };
    expect(readSettings(env)).toStrictEqual(readSettings({}));
    expect(readSettings(env).area).toBe("");
  });

  it("keeps strings as given, without trimming", () => {
    expect(readSettings({ [`${P}MODEL`]: " opus " }).model).toBe(" opus ");
  });

  it("ignores unknown keys, TWOBRAIN_AREA and PATH", () => {
    const got = readSettings({
      [`${P}UNKNOWN`]: "x",
      TWOBRAIN_AREA: "work",
      PATH: "/bin",
    });
    expect(got).toStrictEqual(readSettings({}));
    expect(Object.keys(got).sort()).toStrictEqual([
      "area",
      "enabled",
      "min_user_prompts",
      "model",
      "note_language",
      "server_name",
    ]);
  });

  it("does not change env", () => {
    const env = { [`${P}AREA`]: "work", [`${P}ENABLED`]: "0", TWOBRAIN_AREA: "x" };
    const copy = { ...env };
    readSettings(env);
    expect(env).toStrictEqual(copy);
  });
});
