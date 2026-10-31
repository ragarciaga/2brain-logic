import type { CompletionRequest, LlmProvider } from "./index.js";

export interface MockProvider extends LlmProvider {
  readonly calls: CompletionRequest[];
}

/** Answers each call with the next canned response, in order, and records every request. */
export function createMockProvider(responses: string[]): MockProvider {
  const calls: CompletionRequest[] = [];
  let next = 0;
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const text = responses[next];
      if (text === undefined) {
        throw new Error("Mock provider has no response left");
      }
      next += 1;
      return { text };
    },
  };
}
