import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDigest,
  cutDigest,
  DIGEST_MAX,
  HEAD,
  TAIL,
} from "../../plugin/scripts/lib/digest.mjs";

const read = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

const basicLines = read("transcript-basic.jsonl");
const noiseLines = read("transcript-noise.jsonl");
const basic = buildDigest(basicLines, { timeZone: "America/Bogota" });

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, message: { content: text } });

describe("buildDigest on the basic fixture", () => {
  it("counts only real user prompts", () => {
    expect(basic.userPrompts).toBe(4);
  });

  it("takes the lineage from the first counted prompt, not the meta entry", () => {
    expect(basic.lineage).toBe("u-2");
  });

  it("keeps prompts, assistant text and tool calls", () => {
    expect(basic.text).toContain("USER: PROMPT-ONE");
    expect(basic.text).toContain("USER: PROMPT-TWO");
    expect(basic.text).toContain("ASSISTANT: ASSIST-ONE");
    expect(basic.text).toContain("ASSISTANT: ASSIST-FOUR");
    expect(basic.text).toContain("TOOL Bash: ls -la src");
    expect(basic.text).toContain("TOOL Read: /work/app/src/main.ts");
  });

  it("keeps only the first 2000 characters of each tool result", () => {
    expect(basic.text).toContain(`RESULT: ${"A".repeat(2000)}\n`);
    expect(basic.text).toContain(`RESULT: ${"C".repeat(2000)}\n`);
    expect(basic.text).not.toContain("B".repeat(5));
    expect(basic.text).not.toContain("D".repeat(5));
  });

  it("leaves meta, sidechain, command-tag, thinking and ignored input fields out", () => {
    for (const s of [
      "META-ENTRY",
      "SIDECHAIN",
      "STDOUT-TEXT",
      "STDERR-TEXT",
      "command-name",
      "THINKING-TEXT",
      "DESC-IGNORED",
    ]) {
      expect(basic.text).not.toContain(s);
    }
  });

  it("formats lastDate in the given zone", () => {
    expect(basic.lastDate).toBe("2026-10-31");
    expect(buildDigest(basicLines, { timeZone: "UTC" }).lastDate).toBe("2026-11-01");
  });

  it("falls back to the default zone for an invalid one and has a default zone", () => {
    expect(buildDigest(basicLines, { timeZone: "Not/AZone" }).lastDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(buildDigest(basicLines).lastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("gives null lastDate without timestamps and an empty result for no lines", () => {
    expect(buildDigest([prompt("p1", "hello")]).lastDate).toBeNull();
    expect(buildDigest([])).toStrictEqual({
      text: "",
      userPrompts: 0,
      lineage: null,
      lastDate: null,
    });
  });

  it("counts a prompt with CRLF line endings", () => {
    const crlf = basicLines.map((l) => (l === "" ? l : `${l}\r`));
    expect(buildDigest(crlf, { timeZone: "America/Bogota" })).toStrictEqual(basic);
  });
});

describe("fromPrompt", () => {
  it("0 equals the default", () => {
    expect(buildDigest(basicLines, { fromPrompt: 0, timeZone: "America/Bogota" })).toStrictEqual(
      basic,
    );
  });

  it("2 starts at prompt 3 and keeps the other fields", () => {
    const d = buildDigest(basicLines, { fromPrompt: 2, timeZone: "America/Bogota" });
    expect(d.text.startsWith("USER: PROMPT-THREE")).toBe(true);
    expect(d.text).not.toContain("PROMPT-ONE");
    expect(d.text).not.toContain("PROMPT-TWO");
    expect(d.text).not.toContain("ASSIST-TWO");
    expect(d.text).not.toContain("RESULT:");
    expect(d.userPrompts).toBe(basic.userPrompts);
    expect(d.lineage).toBe(basic.lineage);
    expect(d.lastDate).toBe(basic.lastDate);
  });

  it("4 and 9 give an empty text", () => {
    expect(buildDigest(basicLines, { fromPrompt: 4 }).text).toBe("");
    expect(buildDigest(basicLines, { fromPrompt: 9 }).text).toBe("");
  });

  it("a negative or non-integer value counts as 0", () => {
    for (const fromPrompt of [-1, 1.5, Number.NaN]) {
      expect(buildDigest(basicLines, { fromPrompt, timeZone: "UTC" }).text).toBe(
        buildDigest(basicLines, { timeZone: "UTC" }).text,
      );
    }
  });
});

describe("cutDigest", () => {
  it("leaves 150000 and 149999 characters unchanged", () => {
    expect(cutDigest("x".repeat(DIGEST_MAX))).toBe("x".repeat(DIGEST_MAX));
    expect(cutDigest("x".repeat(DIGEST_MAX - 1))).toBe("x".repeat(DIGEST_MAX - 1));
  });

  it("reports one character left out at 150001", () => {
    const out = cutDigest("x".repeat(DIGEST_MAX + 1));
    expect(out).toContain("\n[1 characters left out]\n");
    expect(out.length).toBe(HEAD + TAIL + "\n[1 characters left out]\n".length);
  });

  it("keeps head 30000 and tail 120000 of 200000 with one marker", () => {
    const text = `${"h".repeat(HEAD)}${"m".repeat(50000)}${"t".repeat(TAIL)}`;
    const out = cutDigest(text);
    expect(out).toBe(`${"h".repeat(HEAD)}\n[50000 characters left out]\n${"t".repeat(TAIL)}`);
    expect(out.split("characters left out").length).toBe(2);
  });

  it("does not split a surrogate pair at either cut", () => {
    const text = `${"a".repeat(HEAD - 1)}\u{1F600}${"b".repeat(60000)}\u{1F600}${"c".repeat(TAIL - 1)}`;
    const out = cutDigest(text);
    const [head, rest] = out.split("\n[");
    const tail = rest?.split("]\n")[1] ?? "";
    expect(head?.length).toBe(HEAD - 1);
    expect(tail.length).toBe(TAIL - 1);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    const omitted = Number(/\[(\d+) characters/.exec(out)?.[1]);
    expect(omitted + (head?.length ?? 0) + tail.length).toBe(text.length);
  });

  it("buildDigest bounds many long prompts", () => {
    const lines = Array.from({ length: 100 }, (_, i) => prompt(`p${i}`, "z".repeat(5000)));
    const d = buildDigest(lines);
    expect(d.userPrompts).toBe(100);
    expect(d.text.length).toBeLessThanOrEqual(DIGEST_MAX + 40);
    expect(d.text).toContain("characters left out");
  });
});

describe("tolerant reading", () => {
  it("the noise fixture gives the basic result", () => {
    expect(noiseLines.length).toBeGreaterThan(basicLines.length);
    expect(noiseLines.some((l) => l.trim() !== "" && !isJson(l))).toBe(true);
    expect(
      noiseLines.some((l) => {
        const e = safeParse(l);
        return (
          typeof e === "object" &&
          e !== null &&
          !["user", "assistant"].includes((e as { type?: string }).type ?? "")
        );
      }),
    ).toBe(true);
    expect(buildDigest(noiseLines, { timeZone: "America/Bogota" })).toStrictEqual(basic);
  });

  it("skips tool-result-only user entries from the count and a user entry with odd content", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "r",
        message: { content: [{ type: "tool_result", content: "x" }] },
      }),
      JSON.stringify({ type: "user", uuid: "w", message: { content: "   " } }),
      JSON.stringify({ type: "user", uuid: "n", message: { content: 5 } }),
      prompt("p", "real"),
    ];
    const d = buildDigest(lines);
    expect(d.userPrompts).toBe(1);
    expect(d.lineage).toBe("p");
  });
});

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function isJson(line: string): boolean {
  return safeParse(line) !== undefined;
}
