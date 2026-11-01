import { type N8nTemplate, nodeByName } from "./n8n-template.js";

/** The `jsCode` of a Code node. */
export function codeNode(t: N8nTemplate, name: string): string {
  const code = nodeByName(t, name).parameters?.jsCode;
  if (typeof code !== "string") throw new Error(`node ${name} has no jsCode`);
  return code;
}

export interface CodeNodeRun {
  /** The object `$getWorkflowStaticData('global')` returns; the code mutates it in place. */
  staticData: Record<string, unknown>;
  /** `$input.all()` json values. */
  input: unknown[];
  /** `$('Settings').first().json`. */
  settings: unknown;
  /** `$('Poll route').itemMatching(i).json`, one value per input index. */
  matching: unknown[];
}

/** Runs a Code node body (run once for all items) with a fake n8n scope; returns the output json values. */
export async function runCodeNode(code: string, run: CodeNodeRun): Promise<unknown[]> {
  const getStatic = (kind: string) => {
    if (kind !== "global") throw new Error(`unexpected static data kind ${kind}`);
    return run.staticData;
  };
  const dollar = (name: string) => {
    if (name === "Settings") return { first: () => ({ json: run.settings }) };
    if (name === "Poll route") {
      return {
        itemMatching: (i: number) => {
          if (i < 0 || i >= run.matching.length) throw new Error(`no paired item at ${i}`);
          return { json: run.matching[i] };
        },
      };
    }
    throw new Error(`unexpected node ${name}`);
  };
  const input = { all: () => run.input.map((json) => ({ json })) };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<{ json: unknown }[]>;
  const fn = new AsyncFunction("$getWorkflowStaticData", "$input", "$", code);
  const result = await fn(getStatic, input, dollar);
  return result.map((item) => item.json);
}
