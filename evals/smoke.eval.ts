import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeStructured } from "../src/llm/index.js";
import { createMockProvider } from "../src/llm/mock.js";

const CaseSchema = z.object({
  id: z.string(),
  response: z.string(),
  expect: z.enum(["ok", "invalid_json", "schema_mismatch"]),
});

const NoteMeta = z.object({ title: z.string(), tags: z.array(z.string()) });

const cases = readFileSync(new URL("./datasets/smoke.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => CaseSchema.parse(JSON.parse(line)));

/** Code grader: 1 when the structured result matches the expected outcome, else 0. */
function grade(
  expected: z.infer<typeof CaseSchema>["expect"],
  result: Awaited<ReturnType<typeof completeStructured>>,
): 0 | 1 {
  const actual = result.ok ? "ok" : result.error;
  return actual === expected ? 1 : 0;
}

describe("smoke eval (mock provider, no network)", () => {
  it("has the three documented cases", () => {
    expect(cases.map((c) => c.id)).toEqual(["valid", "malformed_json", "schema_mismatch"]);
  });

  it("scores 1 on every case and calls the provider once per case", async () => {
    const provider = createMockProvider(cases.map((c) => c.response));
    const scores: number[] = [];
    for (const testCase of cases) {
      const result = await completeStructured(
        provider,
        { prompt: `case ${testCase.id}` },
        NoteMeta,
      );
      scores.push(grade(testCase.expect, result));
    }
    const score = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    expect(scores).toEqual([1, 1, 1]);
    expect(score).toBe(1);
    expect(provider.calls).toHaveLength(3);
  });
});
