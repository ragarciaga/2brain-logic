import matter from "gray-matter";

/**
 * The only module in src/ that imports gray-matter.
 *
 * Two rules keep a note body from becoming executable or from forging its own frontmatter:
 * - the code engines are replaced by functions that throw, so a `---js` fence never runs code;
 * - the stored file is always `---` fence, YAML dump, `---` fence, then the body verbatim. The
 *   body is never handed to gray-matter on the write path.
 */

export class UnsafeFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFrontmatterError";
  }
}

function refuse(): never {
  throw new UnsafeFrontmatterError("Frontmatter code engines are disabled");
}

const SAFE_OPTS = {
  language: "yaml",
  engines: { js: refuse, javascript: refuse },
};

interface YamlEngine {
  stringify(data: object): string;
}

// gray-matter exposes its engines at runtime but its type declarations omit them.
const yamlEngine = (matter as unknown as { engines: { yaml: YamlEngine } }).engines.yaml;

export interface ParsedNote {
  data: Record<string, unknown>;
  content: string;
}

/** Parse a stored note. A fence that names a language (`---js`) is rejected. */
export function parseNote(text: string): ParsedNote {
  const firstLine = text.split("\n", 1)[0]?.replace(/\r$/, "") ?? "";
  if (firstLine.startsWith("---") && firstLine !== "---") {
    throw new UnsafeFrontmatterError("Frontmatter fence must be exactly ---");
  }
  const file = matter(text, SAFE_OPTS);
  return { data: file.data, content: file.content };
}

/**
 * Serialize a note. The result always starts with a `---` block, even for empty frontmatter, so
 * a body that starts with its own fence is just content. A body gets one trailing newline.
 */
export function stringifyNote(frontmatter: Record<string, unknown>, body: string): string {
  const dump = yamlEngine.stringify(frontmatter).trim();
  const tail = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${dump}\n---\n${tail}`;
}

/**
 * Parse the YAML of `.2brain/config.yaml`. A leading `---` line is accepted; any other line that
 * starts with `---` (a second document) throws, because it would silently cut the file short.
 */
export function parseYamlConfig(text: string): unknown {
  const lines = text.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") === "---") {
    lines.shift();
  }
  for (const line of lines) {
    if (line.startsWith("---")) {
      throw new Error("Multiple YAML documents are not supported");
    }
  }
  return parseNote(`---\n${lines.join("\n")}\n---\n`).data;
}
