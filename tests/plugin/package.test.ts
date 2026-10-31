import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../plugin/scripts/lib/settings.mjs";
import {
  FIXTURE_AREAS_AND_FOLDERS,
  importSpecifiers,
  listPluginFiles,
  PLUGIN_ROOT,
  readPluginFile,
  scanImports,
  scanNetwork,
  scanOwnerData,
} from "./helpers/plugin-scan.js";

// Built from parts so the literal placeholder is not written in a plain string.
const PLUGIN_ROOT_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const manifest = JSON.parse(readPluginFile(".claude-plugin/plugin.json"));
const hooks = JSON.parse(readPluginFile("hooks/hooks.json"));

describe("plugin.json", () => {
  it("has the allowed keys and a semver version", () => {
    expect(manifest.name).toBe("2brain");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest).sort()).toStrictEqual([
      "description",
      "name",
      "userConfig",
      "version",
    ]);
    for (const key of ["author", "homepage", "repository"])
      expect(manifest).not.toHaveProperty(key);
  });

  it("declares exactly the six options with title and description", () => {
    const options = manifest.userConfig;
    expect(Object.keys(options).sort()).toStrictEqual([
      "area",
      "enabled",
      "min_user_prompts",
      "model",
      "note_language",
      "server_name",
    ]);
    const types: Record<string, string> = {
      area: "string",
      server_name: "string",
      model: "string",
      min_user_prompts: "number",
      note_language: "string",
      enabled: "boolean",
    };
    for (const [key, option] of Object.entries<Record<string, unknown>>(options)) {
      expect(option.type).toBe(types[key]);
      expect(typeof option.title === "string" && option.title.length > 0).toBe(true);
      expect(typeof option.description === "string" && option.description.length > 0).toBe(true);
      for (const k of Object.keys(option)) {
        expect(["type", "title", "description", "default"]).toContain(k);
      }
    }
    expect(options.area).not.toHaveProperty("default");
    expect(options.area).not.toHaveProperty("required");
  });

  it("defaults equal what readSettings returns for an empty env", () => {
    const settings = readSettings({}) as Record<string, unknown>;
    for (const [key, option] of Object.entries<Record<string, unknown>>(manifest.userConfig)) {
      if (key === "area") continue;
      expect(option.default).toBe(settings[key]);
    }
  });
});

describe("hooks.json", () => {
  it("declares only the SessionEnd command hook", () => {
    expect(hooks).toStrictEqual({
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: "node",
                args: [`${PLUGIN_ROOT_VAR}/scripts/session-end.mjs`],
              },
            ],
          },
        ],
      },
    });
  });
});

describe("package shape", () => {
  it("has no package.json and no node_modules", () => {
    const files = listPluginFiles();
    expect(files.some((f) => f.split("/").includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.endsWith("package.json"))).toBe(false);
    expect(existsSync(join(PLUGIN_ROOT, "node_modules"))).toBe(false);
  });

  it("lists the T3 files", () => {
    const files = listPluginFiles();
    for (const f of [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "scripts/lib/settings.mjs",
    ]) {
      expect(files).toContain(f);
    }
  });
});

describe("plugin files pass the shared scans", () => {
  const files = listPluginFiles();
  it("scanOwnerData finds nothing", () => {
    for (const f of files) expect([f, scanOwnerData(readPluginFile(f))]).toStrictEqual([f, []]);
  });
  it("scanImports finds nothing", () => {
    for (const f of files) expect([f, scanImports(readPluginFile(f))]).toStrictEqual([f, []]);
  });
  it("scanNetwork finds nothing", () => {
    for (const f of files) expect([f, scanNetwork(readPluginFile(f))]).toStrictEqual([f, []]);
  });
  it("has no em dash", () => {
    for (const f of files)
      expect([f, readPluginFile(f).includes(String.fromCodePoint(0x2014))]).toStrictEqual([
        f,
        false,
      ]);
  });
  it("relative imports resolve inside plugin/", () => {
    const root = resolve(PLUGIN_ROOT);
    for (const f of files.filter((x) => x.endsWith(".mjs"))) {
      for (const spec of importSpecifiers(readPluginFile(f))) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(PLUGIN_ROOT, f, "..", spec);
        expect(target.startsWith(root + sep)).toBe(true);
        expect(existsSync(target)).toBe(true);
      }
    }
  });
});

describe("scanOwnerData rules", () => {
  const rules = (text: string) => scanOwnerData(text).map((f) => f.rule);
  it("flags an email outside example.com", () => {
    expect(rules("ana@brain.test")).toContain("email");
    expect(rules("a@example.com")).toStrictEqual([]);
  });
  it("flags a URL host outside example.com", () => {
    expect(rules("https://brain.test/x")).toContain("url-host");
    expect(rules("https://example.com/x")).toStrictEqual([]);
  });
  it("flags a bare hostname outside example.com", () => {
    expect(rules("see example.org")).toContain("hostname");
    expect(rules("see example.com and settings.server_name and process.execPath")).toStrictEqual(
      [],
    );
  });
  it("flags a fixture person name", () => {
    expect(rules("met Ana Ferrer today")).toContain("person-name");
    expect(rules("met bruno today")).toContain("person-name");
    expect(rules("the analysis ran")).toStrictEqual([]);
  });
  it("flags a vault path outside the default areas", () => {
    expect(rules("clients/meetings/x.md")).toContain("vault-path");
    expect(rules("{area}/sessions")).toStrictEqual([]);
    expect(rules("work/meetings/x.md")).toStrictEqual([]);
    expect(rules("docs/progress.md")).toStrictEqual([]);
    expect(rules(`${PLUGIN_ROOT_VAR}/scripts/session-end.mjs`)).toStrictEqual([]);
  });
  it("flags the fixture areas and folders", () => {
    for (const token of FIXTURE_AREAS_AND_FOLDERS) {
      expect(rules(`file under ${token} here`)).toContain("denylist");
    }
    expect(rules("home office")).toStrictEqual([]);
  });
});

describe("scanImports rules", () => {
  const specs = (text: string) => scanImports(text).map((f) => f.match);
  it("flags non-built-in specifiers in every import form", () => {
    expect(specs('import fs from "fs";')).toStrictEqual(["fs"]);
    expect(specs('import { z } from "zod";')).toStrictEqual(["zod"]);
    expect(specs('import "hono";')).toStrictEqual(["hono"]);
    expect(specs('export * from "gray-matter";')).toStrictEqual(["gray-matter"]);
    expect(specs('const m = await import("node-fetch");')).toStrictEqual(["node-fetch"]);
    expect(specs('const m = require("zod");')).toStrictEqual(["zod"]);
  });
  it("flags a dynamic non-literal specifier", () => {
    expect(scanImports("await import(name)")).toHaveLength(1);
  });
  it("accepts node: and relative specifiers", () => {
    expect(
      scanImports(
        'import { spawn } from "node:child_process";\nimport fs from "node:fs";\nimport { log } from "./log.mjs";\nexport { a } from "../b.mjs";',
      ),
    ).toStrictEqual([]);
  });
});

describe("scanNetwork rules", () => {
  const rules = (text: string) => scanNetwork(text).map((f) => f.rule);
  it.each([
    ['import "node:http";', "net-module"],
    ['import "node:https";', "net-module"],
    ['import "node:http2";', "net-module"],
    ['import "node:net";', "net-module"],
    ['import "node:tls";', "net-module"],
    ['import "node:dgram";', "net-module"],
    ["await fetch(url)", "fetch"],
    ["new WebSocket(u)", "websocket"],
    ["new EventSource(u)", "eventsource"],
    ["new XMLHttpRequest()", "xhr"],
    ['spawn("git", ["pull"])', "git-spawn"],
    ["execFileSync('git', [])", "git-spawn"],
    ['exec("git status")', "git-spawn"],
    ["const d = '.2brain/config.yaml'", "vault-dir"],
    ["process.env.VAULT_PATH", "vault-env"],
  ])("flags %s", (text, rule) => {
    expect(rules(text)).toContain(rule);
  });
  it("accepts clean samples", () => {
    expect(rules("spawn(process.execPath, [a])")).toStrictEqual([]);
    expect(rules("prefetch(x)")).toStrictEqual([]);
    expect(rules('import { spawn } from "node:child_process";')).toStrictEqual([]);
  });
});

describe("reads the files of this tree", () => {
  it("settings.mjs exists next to the manifest", () => {
    expect(readFileSync(join(PLUGIN_ROOT, "scripts/lib/settings.mjs"), "utf8")).toContain(
      "readSettings",
    );
  });
});
