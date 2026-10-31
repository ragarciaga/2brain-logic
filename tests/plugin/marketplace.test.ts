import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanOwnerData } from "./helpers/plugin-scan.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const marketplacePath = join(repoRoot, ".claude-plugin/marketplace.json");
const text = readFileSync(marketplacePath, "utf8");
const marketplace = JSON.parse(text);
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

describe("marketplace.json", () => {
  it("has a name and the fixed owner", () => {
    expect(typeof marketplace.name).toBe("string");
    expect(marketplace.name).toBe("2brain-logic");
    expect(marketplace.owner).toStrictEqual({ name: "2brain-logic" });
  });

  it("lists exactly the 2brain plugin with a relative source and no version", () => {
    expect(marketplace.plugins).toHaveLength(1);
    const entry = marketplace.plugins[0];
    expect(entry.name).toBe("2brain");
    expect(entry.source).toBe("./plugin");
    expect(entry).not.toHaveProperty("version");
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "plugin/.claude-plugin/plugin.json"), "utf8"),
    );
    expect(entry.description).toBe(manifest.description);
  });

  it("resolves the source to the plugin directory", () => {
    const dir = resolve(repoRoot, marketplace.plugins[0].source);
    expect(statSync(dir).isDirectory()).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("2brain");
    expect(existsSync(join(repoRoot, ".claude-plugin/plugin.json"))).toBe(false);
  });

  it("holds no owner data", () => {
    expect(scanOwnerData(text)).toStrictEqual([]);
  });
});

describe("package.json lint change", () => {
  it("lints the plugin and the marketplace file", () => {
    expect(pkg.scripts.lint).toBe(
      "biome check src tests evals plugin .claude-plugin vitest.config.ts vitest.evals.config.ts",
    );
  });

  it("leaves every other key as at base", () => {
    const { lint: _lint, ...scripts } = pkg.scripts;
    expect({ ...pkg, scripts }).toStrictEqual({
      name: "2brain-logic",
      version: "0.1.0",
      private: true,
      type: "module",
      description: "A self-feeding second brain: notes land in an Obsidian vault stored in Git.",
      license: "MIT",
      engines: { node: "24.x" },
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
        build: "tsc -p tsconfig.build.json",
        evals: "vitest run --config vitest.evals.config.ts",
        start: "tsc -p tsconfig.build.json && node --env-file=.env dist/index.js",
      },
      dependencies: {
        "@hono/node-server": "2.1.5",
        "@modelcontextprotocol/server": "2.4.0",
        "gray-matter": "4.0.3",
        hono: "4.13.14",
        zod: "4.6.7",
      },
      devDependencies: {
        "@biomejs/biome": "2.6.4",
        "@modelcontextprotocol/client": "2.4.0",
        "@types/node": "24.19.2",
        typescript: "7.0.2",
        vitest: "5.0.5",
      },
    });
  });
});
