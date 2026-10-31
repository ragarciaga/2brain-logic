import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSourceIndex,
  createSourceIndex,
  SourceIndexLimitError,
  sourceIdKey,
} from "../src/vault/source-index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "2brain-srcidx-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function withId(value: string, extra = ""): string {
  return `---\nsource_id: ${value}\n${extra}---\nbody\n`;
}

describe("sourceIdKey", () => {
  it("keeps a non-empty string, stringifies finite numbers and bigints, rejects the rest", () => {
    expect(sourceIdKey("ff-1")).toBe("ff-1");
    expect(sourceIdKey("")).toBeUndefined();
    expect(sourceIdKey(42)).toBe("42");
    expect(sourceIdKey(Number.NaN)).toBeUndefined();
    expect(sourceIdKey(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sourceIdKey(10n)).toBe("10");
    expect(sourceIdKey({ a: 1 })).toBeUndefined();
    expect(sourceIdKey(["a"])).toBeUndefined();
    expect(sourceIdKey(null)).toBeUndefined();
    expect(sourceIdKey(true)).toBeUndefined();
  });
});

describe("buildSourceIndex", () => {
  it("maps ids to vault-relative paths joined with /", async () => {
    put("inbox/deep/a.md", withId("ff-1"));
    put("b.md", withId("ff-2"));
    const index = await buildSourceIndex(root, "source_id");
    expect(Object.fromEntries(index)).toEqual({ "ff-1": "inbox/deep/a.md", "ff-2": "b.md" });
  });

  it("uses the owner's property name only", async () => {
    put("a.md", withId("only-source"));
    put("b.md", "---\norigin_id: from-origin\n---\n");
    const index = await buildSourceIndex(root, "origin_id");
    expect(Object.fromEntries(index)).toEqual({ "from-origin": "b.md" });
  });

  it("skips .git and other dot directories", async () => {
    put(".git/x.md", withId("in-git"));
    put(".obsidian/x.md", withId("in-obsidian"));
    put("ok.md", withId("fine"));
    expect(Object.fromEntries(await buildSourceIndex(root, "source_id"))).toEqual({
      fine: "ok.md",
    });
  });

  it("skips files that do not qualify", async () => {
    put("none.md", "---\ntitle: x\n---\n");
    put("object.md", "---\nsource_id:\n  a: 1\n---\n");
    put("array.md", "---\nsource_id: [a, b]\n---\n");
    put("js.md", "---js\nsource_id = 'js-1'\n---\n");
    put("bad.md", "---\nsource_id: [unclosed\n---\n");
    put("noclose.md", "---\nsource_id: nc-1\nmore: text\n");
    put("body.md", "---\ntitle: x\n---\nsource_id: in-body\n");
    put("nofm.md", "source_id: plain\n");
    put("note.txt", withId("txt-1"));
    put("good.md", withId("good-1"));
    expect(Object.fromEntries(await buildSourceIndex(root, "source_id"))).toEqual({
      "good-1": "good.md",
    });
  });

  it("skips a frontmatter block that does not close within the cap", async () => {
    put("long.md", withId("long-1", `pad: ${"x".repeat(200)}\n`));
    put("short.md", withId("short-1"));
    const index = await buildSourceIndex(root, "source_id", { maxFrontmatterBytes: 64 });
    expect(Object.fromEntries(index)).toEqual({ "short-1": "short.md" });
  });

  it("reads a block that spans several read chunks", async () => {
    put("big.md", withId("big-1", `pad: ${"x".repeat(10_000)}\n`));
    expect(Object.fromEntries(await buildSourceIndex(root, "source_id"))).toEqual({
      "big-1": "big.md",
    });
  });

  it("accepts CRLF fences", async () => {
    put("crlf.md", "---\r\nsource_id: crlf-1\r\n---\r\nbody\r\n");
    expect((await buildSourceIndex(root, "source_id")).get("crlf-1")).toBe("crlf.md");
  });

  it.skipIf(process.platform === "win32")(
    "skips a symlinked file and a symlinked dir",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "2brain-srcidx-out-"));
      try {
        writeFileSync(join(outside, "x.md"), withId("outside-1"));
        symlinkSync(join(outside, "x.md"), join(root, "link.md"));
        symlinkSync(outside, join(root, "linkdir"));
        expect((await buildSourceIndex(root, "source_id")).size).toBe(0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("indexes a numeric id under its string form", async () => {
    put("n.md", "---\nsource_id: 42\n---\n");
    expect((await buildSourceIndex(root, "source_id")).get("42")).toBe("n.md");
  });

  it("indexes a note next to an alias bomb within the test timeout", {
    timeout: 2000,
  }, async () => {
    const levels = ["&a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 30; i += 1) {
      levels.push(`&a${i} [${Array.from({ length: 10 }, () => `*a${i - 1}`).join(", ")}]`);
    }
    put("bomb.md", `---\nbomb: ${levels.join("\n  ")}\n---\n`);
    put("fine.md", withId("fine-1"));
    const index = await buildSourceIndex(root, "source_id");
    expect(index.get("fine-1")).toBe("fine.md");
  });

  it("keeps the first path in sort order when two files share an id", async () => {
    put("b.md", withId("dup"));
    put("a.md", withId("dup"));
    expect((await buildSourceIndex(root, "source_id")).get("dup")).toBe("a.md");
  });

  it("throws SourceIndexLimitError above maxFiles and passes at the limit", async () => {
    put("1.md", withId("a"));
    put("2.md", withId("b"));
    expect((await buildSourceIndex(root, "source_id", { maxFiles: 2 })).size).toBe(2);
    put("3.md", withId("c"));
    await expect(buildSourceIndex(root, "source_id", { maxFiles: 2 })).rejects.toBeInstanceOf(
      SourceIndexLimitError,
    );
  });

  it("throws SourceIndexLimitError above maxEntries, counting directories and other files", async () => {
    put("d/1.txt", "x");
    put("d/2.txt", "x");
    await expect(buildSourceIndex(root, "source_id", { maxEntries: 2 })).rejects.toBeInstanceOf(
      SourceIndexLimitError,
    );
    expect((await buildSourceIndex(root, "source_id", { maxEntries: 3 })).size).toBe(0);
  });

  it("returns an empty map for an empty vault", async () => {
    expect((await buildSourceIndex(root, "source_id")).size).toBe(0);
  });

  it("limit error message names no path", () => {
    expect(new SourceIndexLimitError().message).not.toContain(root);
  });
});

describe("createSourceIndex", () => {
  it("rebuilds only when the head or the property name changes", async () => {
    put("a.md", withId("one"));
    const index = createSourceIndex();
    expect(await index.lookup(root, "h1", "source_id", "one")).toBe("a.md");
    put("b.md", withId("two"));
    expect(await index.lookup(root, "h1", "source_id", "two")).toBeUndefined();
    expect(await index.lookup(root, "h2", "source_id", "two")).toBe("b.md");
    put("c.md", "---\norigin_id: three\n---\n");
    expect(await index.lookup(root, "h2", "source_id", "three")).toBeUndefined();
    expect(await index.lookup(root, "h2", "origin_id", "three")).toBe("c.md");
  });
});
