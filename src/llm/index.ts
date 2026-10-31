import type { z } from "zod";

/** The only door to a language model. Tests and evals use the mock provider. */
export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface Completion {
  text: string;
}

export interface LlmProvider {
  complete(request: CompletionRequest): Promise<Completion>;
}

export type StructuredResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "invalid_json" | "schema_mismatch" };

/** Ask for JSON and validate it against `schema`. Never throws on bad model output. */
export async function completeStructured<T>(
  provider: LlmProvider,
  request: CompletionRequest,
  schema: z.ZodType<T>,
): Promise<StructuredResult<T>> {
  const { text } = await provider.complete(request);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "schema_mismatch" };
}
