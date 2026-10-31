import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInvocation } from "../../plugin/scripts/lib/headless.mjs";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";

const schemaText = readFileSync("plugin/prompts/result.schema.json", "utf8");
const root = mkdtempSync(join(tmpdir(), "headless-"));
const paths = { pluginRoot: root, dataDir: join(root, "data") };

function expectedArgv(server: string, model: string): string[] {
  const tools = ["vault_info", "search", "read", "save_note", "save_recipe", "update_properties"]
    .map((t) => `mcp__${server}__${t}`)
    .join(",");
  return [
    "-p",
    "--tools",
    "",
    "--allowedTools",
    tools,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--model",
    model,
    "--max-turns",
    "20",
    "--output-format",
    "json",
    "--json-schema",
    schemaText,
    "--append-system-prompt-file",
    join(root, "prompts", "capture.md"),
    "--setting-sources",
    "user",
    "--no-session-persistence",
  ];
}

function argvOf(server: string, model: string): string[] {
  const out = buildInvocation({ ...readSettings({}), server_name: server, model }, {}, paths);
  if ("error" in out) throw new Error("unexpected error");
  return out.argv;
}

describe("buildInvocation", () => {
  it("builds the exact argv for the defaults", () => {
    const out = buildInvocation(readSettings({}), { A: "1" }, paths);
    if ("error" in out) throw new Error("unexpected error");
    expect(out.argv).toStrictEqual(expectedArgv("brain", "sonnet"));
    expect(out.argv[2]).toBe("");
    expect(out.argv).toHaveLength(22);
    expect(out.argv.at(-1)).toBe("--no-session-persistence");
    expect(out.argv).not.toContain("--bare");
    expect(out.cwd).toBe(paths.dataDir);
  });

  it("uses a custom server name only in the allowed tools", () => {
    expect(argvOf("vault2", "sonnet")).toStrictEqual(expectedArgv("vault2", "sonnet"));
  });

  it("uses a custom model only in the model value", () => {
    const argv = argvOf("brain", "haiku");
    expect(argv).toStrictEqual(expectedArgv("brain", "haiku"));
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  });

  it("passes the schema file text verbatim", () => {
    const argv = argvOf("brain", "sonnet");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(schemaText);
  });

  it("does not mutate the input env", () => {
    const env = { A: "1", B: undefined };
    const copy = { ...env };
    const out = buildInvocation(readSettings({}), env, paths);
    expect(env).toStrictEqual(copy);
    if ("error" in out) throw new Error("unexpected error");
    expect(out.env).toStrictEqual(copy);
    expect(out.env).not.toBe(env);
  });

  it.each(["", "x,mcp__other", "brain*", "a b"])("rejects server_name %j", (name) => {
    const out = buildInvocation({ ...readSettings({}), server_name: name }, {}, paths);
    expect(out).toStrictEqual({ error: "not_configured" });
  });

  it.each(["", "-x", "a b", "a\tb", "a,b"])("rejects model %j", (model) => {
    const out = buildInvocation({ ...readSettings({}), model }, {}, paths);
    expect(out).toStrictEqual({ error: "not_configured" });
  });
});

describe("result.schema.json", () => {
  const schema = JSON.parse(schemaText);

  it("is a closed object with the six required fields", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toStrictEqual([
      "status",
      "session_note",
      "recipes",
      "people_updated",
      "already_saved",
      "detail",
    ]);
    expect(Object.keys(schema.properties)).toStrictEqual(schema.required);
  });

  it("types each field", () => {
    const p = schema.properties;
    expect(p.status.type).toBe("string");
    expect(p.status.enum).toStrictEqual([
      "saved",
      "nothing_to_save",
      "mcp_unavailable",
      "session_type_missing",
      "failed",
    ]);
    expect(p.session_note.type).toStrictEqual(["string", "null"]);
    expect(p.recipes).toStrictEqual({ type: "array", items: { type: "string" } });
    expect(p.people_updated).toStrictEqual({ type: "array", items: { type: "string" } });
    expect(p.already_saved.type).toBe("boolean");
    expect(p.detail).toStrictEqual({ type: "string", maxLength: 120 });
  });

  it("has no em dash", () => {
    expect(schemaText).not.toContain(String.fromCharCode(0x2014));
  });
});
