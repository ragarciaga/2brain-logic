import { describe, expect, it } from "vitest";
import { normalizeSegments } from "../src/meetings/normalize.js";

type Segs = Parameters<typeof normalizeSegments>[0];
const seg = (speaker: string, offsetSeconds: number, text: string) => ({
  speaker,
  offsetSeconds,
  text,
});
const U = "Speaker";
const ACUTE = String.fromCodePoint(0x301);

describe("normalizeSegments", () => {
  it("merges consecutive segments of one speaker into one turn", () => {
    const r = normalizeSegments(
      [seg("A", 4, "one"), seg("A", 10, "two"), seg("B", 31, "three")],
      U,
    );
    expect(r.turns).toBe(2);
    expect(r.body).toBe("**A** [00:00:04]\none two\n\n**B** [00:00:31]\nthree\n");
  });

  it("renders offsets as HH:MM:SS, flooring and clamping", () => {
    expect(normalizeSegments([seg("A", 3725, "x")], U).body).toBe("**A** [01:02:05]\nx\n");
    expect(normalizeSegments([seg("A", 4.9, "x")], U).body).toContain("[00:00:04]");
    expect(normalizeSegments([seg("A", -3, "x")], U).body).toContain("[00:00:00]");
  });

  it("separates turns with one blank line and does not merge across another speaker", () => {
    const r = normalizeSegments([seg("A", 0, "a1"), seg("B", 5, "b1"), seg("A", 9, "a2")], U);
    expect(r.turns).toBe(3);
    expect(r.body).toBe("**A** [00:00:00]\na1\n\n**B** [00:00:05]\nb1\n\n**A** [00:00:09]\na2\n");
  });

  it("uses unknownLabel for an empty speaker", () => {
    const r = normalizeSegments([seg("", 0, "a"), seg("  ", 1, "b")], U);
    expect(r.body).toBe("**Speaker** [00:00:00]\na b\n");
    expect(r.turns).toBe(1);
  });

  it("normalizes to NFC", () => {
    const r = normalizeSegments([seg(`Jose${ACUTE}`, 0, `cafe${ACUTE}`)], U);
    expect(r.body).toBe(
      `**Jos${String.fromCodePoint(0xe9)}** [00:00:00]\ncaf${String.fromCodePoint(0xe9)}\n`,
    );
  });

  it("converts CRLF and CR to LF", () => {
    expect(normalizeSegments([seg("A", 0, "a\r\nb\rc")], U).body).toBe(
      "**A** [00:00:00]\na\nb\nc\n",
    );
  });

  it("collapses spaces and tabs and drops empty lines", () => {
    expect(normalizeSegments([seg("A", 0, "a  \t b")], U).body).toBe("**A** [00:00:00]\na b\n");
    expect(normalizeSegments([seg("A", 0, " a \n\n  \n b ")], U).body).toBe(
      "**A** [00:00:00]\na\nb\n",
    );
  });

  it("drops empty segments without splitting a turn", () => {
    const r1 = normalizeSegments([seg("A", 0, "x"), seg("B", 1, " \t "), seg("A", 2, "y")], U);
    expect(r1.turns).toBe(1);
    expect(r1.body).toBe("**A** [00:00:00]\nx y\n");
    const r2 = normalizeSegments([seg("A", 0, "x"), seg("A", 1, ""), seg("A", 2, "y")], U);
    expect(r2.turns).toBe(1);
  });

  it("orders by offset and keeps delivered order on ties", () => {
    const r = normalizeSegments([seg("B", 20, "late"), seg("A", 5, "early")], U);
    expect(r.body.indexOf("early")).toBeLessThan(r.body.indexOf("late"));
    const t = normalizeSegments([seg("X", 7, "x"), seg("Y", 7, "y")], U);
    expect(t.body).toBe("**X** [00:00:07]\nx\n\n**Y** [00:00:07]\ny\n");
  });

  it("gives turns 0 and an empty body when there is no text", () => {
    expect(normalizeSegments([], U)).toEqual({ body: "", turns: 0 });
    expect(normalizeSegments([seg("A", 0, " \t\r\n ")], U)).toEqual({ body: "", turns: 0 });
  });

  it("is deterministic, order independent for distinct offsets, and does not mutate", () => {
    const input: Segs = [
      seg("A", 1, "a"),
      seg("B", 2, "b"),
      seg("A", 3, "c"),
      seg("B", 4, "d"),
      seg("A", 5, "e"),
    ];
    const snapshot = structuredClone(input);
    const first = normalizeSegments(input, U);
    expect(normalizeSegments(input, U).body).toBe(first.body);
    expect(input).toEqual(snapshot);
    const shuffled = [input[3], input[0], input[4], input[2], input[1]] as Segs;
    expect(normalizeSegments(shuffled, U).body).toBe(first.body);
  });
});
