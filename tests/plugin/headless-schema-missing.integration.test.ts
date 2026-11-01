import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installFakeClaude } from "./helpers/fake-claude.js";

describe("runCapture with an unreadable result.schema.json", () => {
  it("answers headless_failed and does not throw", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => {
      const actual = await orig<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: ((p: string, ...rest: unknown[]) => {
          if (String(p).endsWith("result.schema.json")) throw new Error("gone");
          return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
        }) as typeof actual.readFileSync,
      };
    });
    try {
      const { runCapture } = await import("../../plugin/scripts/lib/headless.mjs");
      const { readSettings } = await import("../../plugin/scripts/lib/settings.mjs");
      const root = mkdtempSync(join(tmpdir(), "schema-missing-"));
      mkdirSync(join(root, "data"));
      const fake = installFakeClaude({ result: {} });
      const out = await runCapture(
        {
          settings: readSettings({}),
          env: fake.env,
          paths: { pluginRoot: join(process.cwd(), "plugin"), dataDir: join(root, "data") },
          input: "i",
        },
        { home: root },
      );
      expect(out).toStrictEqual({ ok: false, code: "headless_failed", exit: null });
      expect(fake.runs()).toHaveLength(0);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
