import { readFileSync } from "node:fs";

export interface N8nNode {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, Record<string, unknown>>;
  disabled?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  onError?: string;
  [key: string]: unknown;
}

export interface N8nConnection {
  node: string;
  type: string;
  index: number;
}

export interface N8nTemplate {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, N8nConnection[][]>>;
  [key: string]: unknown;
}

/** Reads and parses an n8n workflow export. */
export function loadTemplate(file: string): N8nTemplate {
  return JSON.parse(readFileSync(file, "utf8")) as N8nTemplate;
}

export function nodeByName(t: N8nTemplate, name: string): N8nNode {
  const node = t.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name}`);
  return node;
}

export function nodesByType(t: N8nTemplate, type: string): N8nNode[] {
  return t.nodes.filter((n) => n.type === type);
}

/** Direct targets of a node's main output; all outputs when outputIndex is omitted. */
function successors(t: N8nTemplate, from: string, outputIndex?: number): string[] {
  const outputs = t.connections[from]?.main ?? [];
  const picked = outputIndex === undefined ? outputs : [outputs[outputIndex] ?? []];
  return picked.flat().map((c) => c.node);
}

/** Names of every node reachable from `from` (excluded unless on a cycle), via the given output. */
export function reachable(t: N8nTemplate, from: string, outputIndex?: number): Set<string> {
  const seen = new Set<string>();
  const stack = successors(t, from, outputIndex);
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...successors(t, name));
  }
  return seen;
}

/** Every simple path (node names, ends included) from `from` to `to`. */
export function paths(t: N8nTemplate, from: string, to: string): string[][] {
  const found: string[][] = [];
  const walk = (name: string, trail: string[]): void => {
    if (name === to) {
      found.push([...trail, name]);
      return;
    }
    for (const next of successors(t, name)) {
      if (!trail.includes(next) && next !== name) walk(next, [...trail, name]);
    }
  };
  walk(from, []);
  return found;
}

/** Paths from `from` to `to` that never pass through `via`. Empty means `via` is on every path. */
export function pathsAvoiding(t: N8nTemplate, from: string, to: string, via: string): string[][] {
  return paths(t, from, to).filter((p) => !p.includes(via));
}

export interface N8nEvalContext {
  /** The current item's `$json`. */
  json?: unknown;
  /** Output of other nodes by name. An array means one item per element. */
  nodes?: Record<string, unknown>;
  /** Index of the current item, used by `$(name).item`. */
  index?: number;
  /** The HTTP response, as `$response` in pagination expressions. */
  response?: unknown;
}

/** Evaluates an n8n `={{ ... }}` expression with a fake `$`, `$json` and `$response`. */
export function evalN8n(expr: string, ctx: N8nEvalContext = {}): unknown {
  const m = /^=\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expr);
  if (!m) throw new Error("not an expression");
  const nodes = ctx.nodes ?? {};
  const index = ctx.index ?? 0;
  const itemsOf = (name: string): unknown[] => {
    const value = nodes[name];
    return Array.isArray(value) ? value : [value];
  };
  const dollar = (name: string) => ({
    isExecuted: name in nodes,
    first: () => ({ json: itemsOf(name)[0] }),
    item: { json: Array.isArray(nodes[name]) ? itemsOf(name)[index] : nodes[name] },
    all: () => itemsOf(name).map((json) => ({ json })),
  });
  return new Function("$", "$json", "$response", `return (${m[1]});`)(
    dollar,
    ctx.json,
    ctx.response,
  );
}
