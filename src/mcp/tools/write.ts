import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CONFIG_FILE,
  ConfigInvalidError,
  loadVaultConfig,
  type VaultConfig,
} from "../../config/vault-config.js";
import { issuesOf, mapWriteError, redactedLogLine } from "../../server/errors.js";
import { isSafePathSegment, NoteInput } from "../../vault/note-schema.js";
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
 * The write tools: `save_note` and `save_recipe` (R9.1, R9.2, R9.4, R9.5).
 *
 * - Both save through `VaultWriter.write`, the same create path as `POST /notes` (validation,
 *   scrub, dedupe, commit, push). Nothing here touches the vault or git directly.
 * - Every answer is `{ ok: true, ... }` or the body `mapWriteError` gives the ingest API for the
 *   same error, so codes and detail fields cannot drift. Handlers never throw, and no result or
 *   log line carries note content, a request value, an error message or a stack.
 * - There is no tool that deletes, moves, renames or archives a file.
 */

const SLUG_MAX = 80;
const TITLE_MAX = 200;
const AREA_MAX = 100;
const SOURCE_MAX = 100;
const PATH_MAX = 1024;

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
): { ok: true; slug: string } | RecipeRefusal {
  let scrubbed: string;
  try {
    scrubbed = scrubText(scrubber, title).text;
  } catch (error) {
    return { ok: false, failure: mapWriteError(error) };
  }
  const slug = slugify(scrubbed);
  if (slug === "" || !isSafePathSegment(`${slug}.md`)) return invalidTitle();
  return { ok: true, slug };
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
  if (!(Object.values(props) as string[]).includes("title")) frontmatter.title = args.title;

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

/** The two write tools. Options are test seams; production passes none. */
export function createWriteTools(options: WriteToolOptions = {}): McpToolDefinition[] {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.error;
  const scrubber = options.scrubber ?? defaultScrubber;

  /** Save a note and shape the answer; the only place that calls the writer. */
  async function save(tool: string, deps: McpServerDeps, input: unknown, build?: BuildStep) {
    const prefix = `mcp ${tool}: `;
    const refuse = (failure: Refusal) => {
      log(`${prefix}${failure.log ?? failure.body.error}`);
      return toResult(failure.body);
    };
    try {
      let candidate = input;
      if (build !== undefined) {
        const root = resolve(deps.config.vaultDir);
        const built = await build(() => deps.writer.withPulled(() => loadVaultConfig(root)));
        if (!built.ok) return refuse(built.failure);
        candidate = built.note;
      }
      const parsed = NoteInput.safeParse(candidate);
      if (!parsed.success) {
        return refuse({
          status: 400,
          body: { ok: false, error: "invalid_body", issues: issuesOf(parsed.error) },
          log: undefined,
        });
      }
      let result: WriteResult;
      try {
        result = await deps.writer.write(parsed.data);
      } catch (error) {
        return refuse(mapWriteError(error));
      }
      const redactions = result.redactions ?? [];
      if (redactions.length > 0) log(`${prefix}${redactedLogLine(redactions)}`);
      return toResult({
        ok: true,
        path: result.path,
        commit: result.commit,
        unchanged: result.unchanged === true,
        redactions,
      });
    } catch {
      log(`${prefix}internal_error`);
      return toResult({ ok: false, error: "internal_error" });
    }
  }

  type BuildStep = (
    loadConfig: () => Promise<VaultConfig>,
  ) => Promise<ReturnType<typeof buildRecipe>>;

  const saveNote: McpToolDefinition = {
    name: "save_note",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "save_note",
        {
          description:
            "Save a new note at a vault path with frontmatter and a body. Secrets are redacted before it is stored. Fails when the path already exists.",
          inputSchema: z.object({
            path: text("path", PATH_MAX),
            frontmatter: z.record(z.string(), z.unknown(), {
              message: "frontmatter must be an object",
            }),
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
            "Save something that worked as a recipe note: a title, the area, the problem and the steps or code that solved it.",
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
          }),
        },
        (args) =>
          save("save_recipe", deps, undefined, async (loadConfig) => {
            // The slug check comes before the config pull: a bad title costs no git work.
            const slug = recipeSlug(args.title, scrubber);
            if (!slug.ok) return slug;
            let config: VaultConfig;
            try {
              config = await loadConfig();
            } catch (error) {
              return { ok: false, failure: mapWriteError(error) };
            }
            return buildRecipe(args, config, now().toISOString().slice(0, 10), slug.slug);
          }),
      );
    },
  };

  return [saveNote, saveRecipe];
}

export const WRITE_TOOLS: readonly McpToolDefinition[] = Object.freeze(createWriteTools());
