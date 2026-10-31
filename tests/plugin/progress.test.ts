import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ requested: 0, readFileSyncCalls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: ((...args: unknown[]) => {
      // (fd, buffer, offset, length, position)
      reads.requested += Number(args[3]);
      return (actual.readSync as (...a: unknown[]) => number)(...args);
    }) as typeof actual.readSync,
    readFileSync: ((...args: unknown[]) => {
      reads.readFileSyncCalls++;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
  };
});

import { PROGRESS_HEADER, readProgress } from "../../plugin/scripts/lib/progress.mjs";

const HEADER = "--- progress.md (first 20,000 characters) ---";
const onWindows = process.platform === "win32";

let root: string;
let cwd: string;

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      out.push(`${full}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

function writeProgress(text: string | Buffer): void {
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "progress.md"), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "progress-"));
  cwd = join(root, "proj");
  mkdirSync(cwd);
  reads.requested = 0;
  reads.readFileSyncCalls = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function check(_dir: string, fn: () => void): void {
  const before = snapshot(root);
  fn();
  expect(snapshot(root)).toStrictEqual(before);
}

describe("readProgress", () => {
  it("exports the design header", () => {
    expect(PROGRESS_HEADER).toBe(HEADER);
  });

  it("returns exactly the first 20,000 code points with no split pair", () => {
    const unit = ["a", "é", "€", String.fromCodePoint(0x1f600)];
    const chars: string[] = [];
    // Start with ASCII so an astral character straddles UTF-16 unit 20,000.
    for (let i = 0; i < 50000; i++) chars.push(unit[(i * 7 + (i > 19990 ? 3 : 0)) % 4] as string);
    chars[19999] = String.fromCodePoint(0x1f600);
    const src = chars.join("");
    expect(src.length).toBeGreaterThan(50000);
    writeProgress(src);
    check(cwd, () => {
      const got = readProgress(cwd);
      expect(got).toBe(`${HEADER}\n${Array.from(src).slice(0, 20000).join("")}`);
      const body = (got as string).slice(HEADER.length + 1);
      expect(Array.from(body)).toHaveLength(20000);
      expect(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(body),
      ).toBe(false);
    });
  });

  it("returns a short file whole", () => {
    writeProgress("done: T1\n");
    check(cwd, () => {
      expect(readProgress(cwd)).toBe(`${HEADER}\ndone: T1\n`);
    });
  });

  it("reads at most 80,000 bytes of a 10 MiB file and never uses readFileSync", () => {
    writeProgress(Buffer.alloc(10 * 1024 * 1024, 0x61));
    check(cwd, () => {
      const got = readProgress(cwd) as string;
      expect(got.length).toBe(HEADER.length + 1 + 20000);
    });
    expect(reads.requested).toBeGreaterThan(0);
    expect(reads.requested).toBeLessThanOrEqual(80000);
    expect(reads.readFileSyncCalls).toBe(0);
  });

  it("returns null for a missing file", () => {
    check(cwd, () => expect(readProgress(cwd)).toBeNull());
  });

  it("returns null for a directory named progress.md", () => {
    mkdirSync(join(cwd, "docs", "progress.md"), { recursive: true });
    check(cwd, () => expect(readProgress(cwd)).toBeNull());
  });

  it("returns null for a missing or empty cwd", () => {
    expect(readProgress(join(root, "nope"))).toBeNull();
    expect(readProgress("")).toBeNull();
    expect(readProgress(undefined as unknown as string)).toBeNull();
  });

  describe.skipIf(onWindows)("symlinks", () => {
    it("returns null when the progress.md symlink leads outside cwd", () => {
      const outside = join(root, "outside.md");
      writeFileSync(outside, "outside");
      mkdirSync(join(cwd, "docs"));
      symlinkSync(outside, join(cwd, "docs", "progress.md"));
      check(cwd, () => expect(readProgress(cwd)).toBeNull());
    });

    it("returns null when the docs symlink leads outside cwd", () => {
      const other = join(root, "other");
      mkdirSync(other);
      writeFileSync(join(other, "progress.md"), "outside");
      symlinkSync(other, join(cwd, "docs"));
      check(cwd, () => expect(readProgress(cwd)).toBeNull());
    });

    it("returns the text when a symlink leads to a file inside cwd", () => {
      mkdirSync(join(cwd, "docs"));
      writeFileSync(join(cwd, "real.md"), "inside");
      symlinkSync(join(cwd, "real.md"), join(cwd, "docs", "progress.md"));
      check(cwd, () => expect(readProgress(cwd)).toBe(`${HEADER}\ninside`));
    });

    it("returns the text when cwd itself is a symlink", () => {
      writeProgress("via link");
      const link = join(root, "link");
      symlinkSync(cwd, link);
      check(cwd, () => expect(readProgress(link)).toBe(`${HEADER}\nvia link`));
    });
  });
});

describe("read-only source scan", () => {
  const WRITE_API =
    /\b(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|createWriteStream|utimes|futimes|truncate|ftruncate|chmod|symlink|link)(?:Sync)?\b/;
  const OPEN_CALL = /\bopen(?:Sync)?\s*\(([^)]*)\)/g;

  function findings(src: string): string[] {
    const out: string[] = [];
    const w = WRITE_API.exec(src);
    if (w) out.push(w[0]);
    for (const m of src.matchAll(OPEN_CALL)) {
      const args = (m[1] ?? "").split(",").map((a) => a.trim());
      if (args[1] !== '"r"') out.push(m[0]);
    }
    return out;
  }

  it("flags planted write calls and non-read open flags", () => {
    expect(findings('openSync(p,"w")')).not.toHaveLength(0);
    expect(findings("rmSync(x)")).not.toHaveLength(0);
    expect(findings("fs.writeFileSync(a, b)")).not.toHaveLength(0);
    expect(findings('openSync(p, "r")')).toHaveLength(0);
  });

  it("finds none in progress.mjs", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "plugin", "scripts", "lib", "progress.mjs"),
      "utf8",
    );
    expect(findings(src)).toStrictEqual([]);
  });
});
