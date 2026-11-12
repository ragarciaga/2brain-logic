import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CONFIG_FILE,
  ConfigInvalidError,
  FORBIDDEN_LINK_NAMES,
  linkPropertyNames,
  loadVaultConfig,
  type VaultConfig,
} from "../../config/vault-config.js";
import { issuesOf, mapWriteError, redactedLogLine } from "../../server/errors.js";
import { isSafePathSegment, NoteInput, NotePatch } from "../../vault/note-schema.js";
import {
  defaultScrubber,
  InvalidFrontmatterError,
  type Scrubber,
  scrubText,
  type WriteResult,
} from "../../vault/write-note.js";
// Types only: server.ts imports WRITE_TOOLS from this module.
import type { McpServerDeps, McpToolDefinition } from "../server.js";

/**
 * The write tools: `save_note`, `save_recipe`, `update_properties` (R9.1 to R9.5) and
 * `append_to_note` (docs/adr/0023-mcp-append.md).
 *
 * - `save_note` and `save_recipe` save through `VaultWriter.write`, the same create path as
 *   `POST /notes`; `update_properties` goes through `VaultWriter.patch`, the same path as
 *   `PATCH /notes` (validation, scrub, dedupe, commit, push). It sets properties only: an
 *   `append` or a `body` is refused, so the body of a note is never touched. Nothing here touches
 *   the vault or git directly.
 * - Every answer is `{ ok: true, ... }` or the body `mapWriteError` gives the ingest API for the
 *   same error, so codes and detail fields cannot drift. Handlers never throw, and no result or
 *   log line carries note content, a request value, an error message or a stack. The one
 *   exception is the `link` of a `save_recipe` result, whose alias is the scrubbed title.
 * - `append_to_note` goes through the same `VaultWriter.patch` path with `append` only: the
 *   stored bytes are kept, the text is scrubbed and its remote embeds neutralized, and a note of a
 *   type with an immutable body (a transcript) is refused.
 * - There is no tool that deletes, moves, renames or archives a file.
 */

const SLUG_MAX = 80;
const TITLE_MAX = 200;
const AREA_MAX = 100;
const SOURCE_MAX = 100;
const PATH_MAX = 1024;
const LINK_NAME_MAX = 200;
const TOPICS_MAX = 20;
/** Most text one append may add: a long section, far below the 2 MiB MCP body cap. */
export const APPEND_MAX = 100_000;

export interface WriteToolOptions {
  /** Test seam for the clock (the recipe date is its UTC day). */
  now?: () => Date;
  /** Test seam for the log sink. Defaults to `console.error`. */
  log?: (line: string) => void;
  /**
   * The scrubber that builds the recipe file name from the title. Defaults to the real one, the
   * default of the note writer; a test that gives the writer another scrubber gives it here too.
   */
  scrubber?: Scrubber;
}

export type SavedNote = {
  ok: true;
  path: string;
  /** Only a recipe: `[[<slug>|<title>]]`, the one link that resolves to the saved file. */
  link?: string;
  commit: string | null;
  unchanged: boolean;
  redactions: { rule: string; count: number }[];
};

/** A failure answer: a mapped write error, `invalid_body` or `internal_error`. */
export interface Refusal {
  status: number;
  body: { ok: false; error: string; [detail: string]: unknown };
  /** The line to log, or undefined to log the code. */
  log: string | undefined;
}

export type WriteToolOutcome = SavedNote | Refusal["body"];

function toResult(body: WriteToolOutcome) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body as unknown as Record<string, unknown>,
    isError: !body.ok,
  };
}

/** File name part of a recipe: ASCII letters and digits joined by single dashes, at most 80. */
export function slugify(title: string): string {
  const cut = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return cut.replace(/-+$/g, "");
}

export interface RecipeArgs {
  title: string;
  area: string;
  problem: string;
  solution: string;
  source?: string | undefined;
  /** One note name, stored as a `[[...]]` link. */
  project?: string | undefined;
  /** Note names, each stored as a `[[...]]` link. */
  topics?: string[] | undefined;
}

/** Code point ranges a link name must not hold: C0 and C1 controls, zero-width, separators, bidi, BOM. */
const LINK_NAME_FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200d],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const LINK_NAME_FORBIDDEN_CHARS = "[]|#^";

function hasLinkNameBreaker(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (LINK_NAME_FORBIDDEN_CHARS.includes(char)) return true;
    if (LINK_NAME_FORBIDDEN_RANGES.some(([from, to]) => code >= from && code <= to)) return true;
  }
  return false;
}

/**
 * Whether a string is usable as the name inside a `[[...]]` link: 1 to 200 characters, no edge
 * whitespace, no control, bidi or zero-width character, and none of `[ ] | # ^` (which would wrap,
 * alias, or point into the note).
 */
export function isLinkName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= LINK_NAME_MAX &&
    name === name.trim() &&
    !hasLinkNameBreaker(name)
  );
}

/** A refusal built by `buildRecipe`: the ingest-shaped body to return. */
export interface RecipeRefusal {
  ok: false;
  failure: Refusal;
}

const invalidTitle = (): RecipeRefusal => ({
  ok: false,
  failure: {
    status: 400,
    body: {
      ok: false,
      error: "invalid_body",
      issues: [
        { path: "title", message: "title must contain letters or digits usable as a file name" },
      ],
    },
    log: undefined,
  },
});

/**
 * The file name part of a recipe, built from the scrubbed title: a secret in the title becomes
 * `redacted-<rule>`, never part of the path, the commit message or the remote. Refuses an empty or
 * reserved slug, and a scrubber failure (`scrub_failed`, nothing written).
 */
export function recipeSlug(
  title: string,
  scrubber: Scrubber,
): { ok: true; slug: string; link: string } | RecipeRefusal {
  let slug: string;
  let link: string;
  try {
    slug = slugify(scrubText(scrubber, title).text);
    link = recipeLink(slug, title, scrubber);
  } catch (error) {
    return { ok: false, failure: mapWriteError(error) };
  }
  if (slug === "" || !isSafePathSegment(`${slug}.md`)) return invalidTitle();
  return { ok: true, slug, link };
}

/**
 * The link a client uses to point at a saved recipe: `[[<slug>|<title>]]`. The file is named after
 * the slug, so a link by title does not resolve. The alias is cleaned first (no `[`, `]` or `|`,
 * whitespace collapsed, trimmed) and scrubbed last, so a secret split by a bracket cannot be
 * rejoined into the alias; an empty alias falls back to the slug. Throws `ScrubFailedError`.
 */
export function recipeLink(
  slug: string,
  title: string,
  scrubber: Scrubber = defaultScrubber,
): string {
  const cleaned = title
    .replace(/[[\]|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // The scrubber's own `[REDACTED:<rule>]` placeholders are the only brackets left to drop.
  const alias = scrubText(scrubber, cleaned)
    .text.replace(/[[\]|]/g, "")
    .trim();
  return `[[${slug}|${alias === "" ? slug : alias}]]`;
}

/**
 * Build the note a `save_recipe` call saves. Pure: the config, the date and the slug (from
 * `recipeSlug`) come from the caller. Refuses (without building any path) on a missing `recipe`
 * type or an unknown area.
 */
export function buildRecipe(
  args: RecipeArgs,
  config: VaultConfig,
  today: string,
  slug: string,
): { ok: true; note: NoteInput } | RecipeRefusal {
  const recipe = config.types.recipe;
  if (recipe === undefined) {
    return {
      ok: false,
      failure: mapWriteError(
        new ConfigInvalidError(CONFIG_FILE, "types.recipe", "no recipe type is configured"),
      ),
    };
  }
  const props = config.properties;
  if (!config.areas.includes(args.area)) {
    return {
      ok: false,
      failure: mapWriteError(new InvalidFrontmatterError([], [props.area])),
    };
  }

  const folder = recipe.folder?.replaceAll("{area}", args.area) ?? config.vault.inbox_folder;
  const frontmatter: Record<string, unknown> = {
    [props.type]: recipe.value,
    [props.area]: args.area,
    [props.date]: today,
    [props.source]: args.source ?? "mcp",
  };
  const core = [props.type, props.area, props.date, props.source, props.source_id];
  if (!core.includes("title")) frontmatter.title = args.title;

  const names = linkPropertyNames(config);
  const wanted: { key: "project" | "topics"; name: string; value: unknown }[] = [];
  if (args.project !== undefined) {
    wanted.push({ key: "project", name: names.project, value: `[[${args.project}]]` });
  }
  if (args.topics !== undefined && args.topics.length > 0) {
    wanted.push({
      key: "topics",
      name: names.topics,
      value: args.topics.map((topic) => `[[${topic}]]`),
    });
  }
  // A link name that collides with another property, the title or the other link name is refused,
  // and only when the call gives that argument (an implicit default is never checked at load).
  for (const { key, name } of wanted) {
    const other = key === "project" ? names.topics : names.project;
    if (FORBIDDEN_LINK_NAMES.has(name) || core.includes(name) || name === other) {
      return {
        ok: false,
        failure: mapWriteError(
          new ConfigInvalidError(
            CONFIG_FILE,
            `properties.${key}`,
            "the link property name is used by another property",
          ),
        ),
      };
    }
  }
  for (const { name, value } of wanted) {
    Object.defineProperty(frontmatter, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    ok: true,
    note: {
      path: `${folder}/${slug}.md`,
      frontmatter,
      body: `## Problem\n\n${args.problem.trimEnd()}\n\n## Solution\n\n${args.solution.trimEnd()}\n`,
    },
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (what: string, max: number) =>
  z
    .string({ message: `${what} must be a string` })
    .min(1, { message: `${what} must not be empty` })
    .max(max, { message: `${what} is too long` });

/** One note name for a `[[...]]` link; the message never repeats the value. */
const linkName = (what: string) =>
  z.string({ message: `${what} must be a string` }).refine(isLinkName, {
    message: `${what} must be 1 to ${LINK_NAME_MAX} characters, without edge whitespace, control characters, brackets, | # or ^`,
  });

/** The three write tools. Options are test seams; production passes none. */
export function createWriteTools(options: WriteToolOptions = {}): McpToolDefinition[] {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.error;
  const scrubber = options.scrubber ?? defaultScrubber;

  /** What one write operation gives back: the writer's result or the refusal to answer with. */
  type Outcome = { ok: true; result: WriteResult; link?: string } | { ok: false; failure: Refusal };

  const invalidBody = (issues: unknown): Outcome => ({
    ok: false,
    failure: { status: 400, body: { ok: false, error: "invalid_body", issues }, log: undefined },
  });

  /**
   * Refuse a project or topic name the scrubber changes (it held a secret): `invalid_body` with
   * the path only, so the value is in no result or log line. A scrubber failure is `scrub_failed`.
   */
  function refuseScrubbed(
    project: string | undefined,
    topics: string[] | undefined,
  ): RecipeRefusal | undefined {
    const checks: [string, string[]][] = [
      ["project", project === undefined ? [] : [project]],
      ["topics", topics ?? []],
    ];
    for (const [path, names] of checks) {
      for (const name of names) {
        let changed: boolean;
        try {
          changed = scrubText(scrubber, name).text !== name;
        } catch (error) {
          return { ok: false, failure: mapWriteError(error) };
        }
        if (changed) {
          return {
            ok: false,
            failure: {
              status: 400,
              body: {
                ok: false,
                error: "invalid_body",
                issues: [{ path, message: `${path} must not contain a secret` }],
              },
              log: undefined,
            },
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Run one write operation and shape the answer; the only place that turns a writer result or
   * error into a tool result. `op` calls the writer and returns a refusal or its result; an error
   * it throws is a bug of the tool and becomes `internal_error`.
   */
  async function run(tool: string, op: () => Promise<Outcome>) {
    const prefix = `mcp ${tool}: `;
    const refuse = (failure: Refusal) => {
      log(`${prefix}${failure.log ?? failure.body.error}`);
      return toResult(failure.body);
    };
    try {
      const outcome = await op();
      if (!outcome.ok) return refuse(outcome.failure);
      const { result } = outcome;
      const redactions = result.redactions ?? [];
      if (redactions.length > 0) log(`${prefix}${redactedLogLine(redactions)}`);
      return toResult({
        ok: true,
        path: result.path,
        ...(outcome.link === undefined ? {} : { link: outcome.link }),
        commit: result.commit,
        unchanged: result.unchanged === true,
        redactions,
      });
    } catch {
      log(`${prefix}internal_error`);
      return toResult({ ok: false, error: "internal_error" });
    }
  }

  /** Call a writer method; a writer error becomes the refusal `mapWriteError` gives. */
  async function viaWriter(call: () => Promise<WriteResult>): Promise<Outcome> {
    try {
      return { ok: true, result: await call() };
    } catch (error) {
      return { ok: false, failure: mapWriteError(error) };
    }
  }

  type BuildStep = (
    loadConfig: () => Promise<VaultConfig>,
  ) => Promise<ReturnType<typeof buildRecipe> & { link?: string }>;

  /** Create a note from the call's input, or from the note a build step makes of it. */
  function save(tool: string, deps: McpServerDeps, input: unknown, build?: BuildStep) {
    return run(tool, async () => {
      let candidate = input;
      let link: string | undefined;
      if (build !== undefined) {
        const root = resolve(deps.config.vaultDir);
        const built = await build(() => deps.writer.withPulled(() => loadVaultConfig(root)));
        if (!built.ok) return built;
        candidate = built.note;
        link = built.link;
      }
      const parsed = NoteInput.safeParse(candidate);
      if (!parsed.success) return invalidBody(issuesOf(parsed.error));
      const written = await viaWriter(() => deps.writer.write(parsed.data));
      return written.ok && link !== undefined ? { ...written, link } : written;
    });
  }

  const saveNote: McpToolDefinition = {
    name: "save_note",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "save_note",
        {
          description:
            "Save a new note at a vault path with frontmatter and a body. Call vault_info first: it gives the property names, areas, note types and the folder of each type. The frontmatter must hold the type, area and date properties under the names vault_info returns (date as YYYY-MM-DD), and the path must sit in the folder of that type. Secrets are redacted before it is stored. Fails when the path already exists.",
          inputSchema: z.object({
            path: text("path", PATH_MAX),
            frontmatter: z
              .record(z.string(), z.unknown(), {
                message: "frontmatter must be an object",
              })
              .describe(
                "Properties of the note. Required: the type, area and date properties named by vault_info.",
              ),
            body: z.string({ message: "body must be a string" }),
          }),
        },
        (args) => save("save_note", deps, args),
      );
    },
  };

  const saveRecipe: McpToolDefinition = {
    name: "save_recipe",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "save_recipe",
        {
          description:
            "Save something that worked as a recipe note: a title, the area, the problem and the steps or code that solved it. Optionally give the project and the topics the recipe belongs to, as note names (without brackets); they are stored as links. The file is named after the title slug, not the title: to link the recipe from another note, use only the link field of the result and never the title.",
          inputSchema: z.object({
            title: text("title", TITLE_MAX).refine((t) => !CONTROL.test(t), {
              message: "title must not contain control characters",
            }),
            area: text("area", AREA_MAX),
            problem: z
              .string({ message: "problem must be a string" })
              .min(1, { message: "problem must not be empty" }),
            solution: z
              .string({ message: "solution must be a string" })
              .min(1, { message: "solution must not be empty" }),
            source: text("source", SOURCE_MAX).optional(),
            project: linkName("project").optional(),
            topics: z
              .array(linkName("topics"), { message: "topics must be a list of note names" })
              .max(TOPICS_MAX, { message: "topics has too many entries" })
              .refine((list) => new Set(list).size === list.length, {
                message: "topics must not repeat a name",
              })
              .describe("Note names of the topics, without brackets; stored as links.")
              .optional(),
          }),
        },
        (args) =>
          save("save_recipe", deps, undefined, async (loadConfig) => {
            // The slug check comes before the config pull: a bad title costs no git work.
            const slug = recipeSlug(args.title, scrubber);
            if (!slug.ok) return slug;
            // A name the scrubber changes held a secret: refused, the value never echoed.
            const unsafe = refuseScrubbed(args.project, args.topics);
            if (unsafe !== undefined) return unsafe;
            let config: VaultConfig;
            try {
              config = await loadConfig();
            } catch (error) {
              return { ok: false, failure: mapWriteError(error) };
            }
            const built = buildRecipe(args, config, now().toISOString().slice(0, 10), slug.slug);
            return built.ok ? { ...built, link: slug.link } : built;
          }),
      );
    },
  };

  const updateProperties: McpToolDefinition = {
    name: "update_properties",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "update_properties",
        {
          description:
            "Set frontmatter properties of an existing note. Top-level keys in set replace the stored ones and the others are kept. Use the property names vault_info returns. The body is never changed. Secrets are redacted before they are stored.",
          // Loose on purpose: a key the schema does not name must reach the handler, which refuses
          // it. A plain object schema would strip `append` and apply `set` as if it were absent.
          inputSchema: z.looseObject({
            path: text("path", PATH_MAX),
            set: z.record(z.string(), z.unknown(), { message: "set must be an object" }),
          }),
        },
        (args) =>
          run("update_properties", async () => {
            if (Object.hasOwn(args, "append")) {
              return invalidBody([
                {
                  path: "append",
                  message: "update_properties sets properties only; append is not accepted",
                },
              ]);
            }
            // The F1 patch schema is strict: `body` or any other extra key is refused here.
            const parsed = NotePatch.safeParse(args);
            if (!parsed.success) return invalidBody(issuesOf(parsed.error));
            return viaWriter(() => deps.writer.patch(parsed.data));
          }),
      );
    },
  };

  const appendToNote: McpToolDefinition = {
    name: "append_to_note",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "append_to_note",
        {
          description:
            "Add text at the end of the body of an existing note, after a blank line, for example a dated section with new decisions or facts. What the note already says is never changed or removed. Meeting transcripts (types with an immutable body) are refused. Search first to find the note and read it to avoid repeating what it already says. Secrets are redacted and remote image embeds are turned into links before the text is stored.",
          inputSchema: z.object({
            path: text("path", PATH_MAX),
            text: z
              .string({ message: "text must be a string" })
              .min(1, { message: "text must not be empty" })
              .max(APPEND_MAX, { message: "text is too long" })
              .refine((t) => t.trim() !== "", { message: "text must not be blank" }),
          }),
        },
        (args) =>
          run("append_to_note", async () => {
            // The same patch path as PATCH /notes: earlier bytes kept, scrub, embeds, immutable refused.
            const parsed = NotePatch.safeParse({ path: args.path, append: args.text });
            if (!parsed.success) return invalidBody(issuesOf(parsed.error));
            return viaWriter(() => deps.writer.patch(parsed.data));
          }),
      );
    },
  };

  return [saveNote, saveRecipe, updateProperties, appendToNote];
}

export const WRITE_TOOLS: readonly McpToolDefinition[] = Object.freeze(createWriteTools());
