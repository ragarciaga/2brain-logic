import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlConfig } from "../vault/frontmatter.js";
import { DEFAULT_VAULT_CONFIG } from "./defaults.js";

export const CONFIG_FILE = ".2brain/config.yaml";

/**
 * The vault config is invalid. `keyPath` is the dot-joined path of the first offending key, or an
 * empty string when the file as a whole cannot be read as YAML.
 */
export class ConfigInvalidError extends Error {
  readonly file: string;
  readonly keyPath: string;

  constructor(file: string, keyPath: string, detail: string) {
    super(
      keyPath === "" ? `Invalid ${file}: ${detail}` : `Invalid ${file} at ${keyPath}: ${detail}`,
    );
    this.name = "ConfigInvalidError";
    this.file = file;
    this.keyPath = keyPath;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** One path segment: non-empty, no separators, no control characters, not hidden or `..`. */
function isSafeSegment(value: string): boolean {
  return (
    value !== "" &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !CONTROL_CHARS.test(value) &&
    !value.startsWith(".")
  );
}

/** A relative folder: safe segments joined by `/`, no drive letter. */
function isSafeFolder(value: string): boolean {
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every(isSafeSegment);
}

/** A folder pattern: a safe folder once `{area}` is replaced, and no other braces. */
function isSafeFolderPattern(value: string): boolean {
  const replaced = value.replaceAll("{area}", "x");
  return !/[{}]/.test(replaced) && isSafeFolder(replaced);
}

const nonEmpty = z.string().min(1);
const safeFolder = z.string().refine(isSafeFolder, {
  message: "must be a relative folder without dot segments, backslashes or control characters",
});
const safeSegment = z.string().refine(isSafeSegment, {
  message: "must be one name without slashes, backslashes, control characters or a leading dot",
});
const folderPattern = z.string().refine(isSafeFolderPattern, {
  message: "must be a safe relative folder; the only placeholder allowed is {area}",
});

const TypeEntrySchema = z.strictObject({
  value: nonEmpty,
  folder: folderPattern.optional(),
  immutable_body: z.boolean().optional(),
});

const VaultSectionSchema = z.strictObject({
  archive_folder: safeFolder.default(DEFAULT_VAULT_CONFIG.vault.archive_folder),
  inbox_folder: safeFolder.default(DEFAULT_VAULT_CONFIG.vault.inbox_folder),
});

const PropertiesSchema = z
  .strictObject({
    type: nonEmpty.default(DEFAULT_VAULT_CONFIG.properties.type),
    area: nonEmpty.default(DEFAULT_VAULT_CONFIG.properties.area),
    date: nonEmpty.default(DEFAULT_VAULT_CONFIG.properties.date),
    source: nonEmpty.default(DEFAULT_VAULT_CONFIG.properties.source),
    source_id: nonEmpty.default(DEFAULT_VAULT_CONFIG.properties.source_id),
  })
  .refine((props) => new Set(Object.values(props)).size === Object.keys(props).length, {
    message: "property names must be distinct",
  });

const TypesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]*$/, "type keys are lowercase words"), TypeEntrySchema)
  .refine((types) => Object.keys(types).length > 0, { message: "at least one type is required" })
  .refine(
    (types) => {
      const values = Object.values(types).map((entry) => entry.value);
      return new Set(values).size === values.length;
    },
    { message: "type values must be distinct" },
  );

const AreasSchema = z
  .array(safeSegment)
  .min(1)
  .refine((areas) => new Set(areas).size === areas.length, { message: "areas must be unique" });

export interface TypeEntry {
  value: string;
  folder?: string | undefined;
  immutable_body?: boolean | undefined;
}

export interface VaultConfig {
  version: 1;
  vault: { archive_folder: string; inbox_folder: string };
  properties: { type: string; area: string; date: string; source: string; source_id: string };
  areas: string[];
  sources: string[];
  types: Record<string, TypeEntry>;
}

// Zod clones a `.default(object)` shallowly, so object defaults come from a function. The type
// is written out (not inferred) because the defaults file is typed with it.
export const VaultConfigSchema: z.ZodType<VaultConfig, unknown> = z.strictObject({
  version: z.literal(1).default(1),
  vault: VaultSectionSchema.default(() => structuredClone(DEFAULT_VAULT_CONFIG.vault)),
  properties: PropertiesSchema.default(() => structuredClone(DEFAULT_VAULT_CONFIG.properties)),
  areas: AreasSchema.default(() => structuredClone(DEFAULT_VAULT_CONFIG.areas)),
  sources: z.array(nonEmpty).default(() => structuredClone(DEFAULT_VAULT_CONFIG.sources)),
  types: TypesSchema.default(() => structuredClone(DEFAULT_VAULT_CONFIG.types)),
});

function keyPathOf(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    path.push(issue.keys[0] as string);
  }
  return path.join(".");
}

/**
 * Load `.2brain/config.yaml` from the vault. A missing file gives the defaults. Anything else
 * that is wrong with the file throws `ConfigInvalidError`; a read error other than ENOENT is
 * rethrown unchanged.
 */
export async function loadVaultConfig(vaultDir: string): Promise<VaultConfig> {
  let text: string;
  try {
    text = await readFile(join(vaultDir, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return VaultConfigSchema.parse({});
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = parseYamlConfig(text);
  } catch (error) {
    throw new ConfigInvalidError(CONFIG_FILE, "", (error as Error).message);
  }

  const parsed = VaultConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as z.core.$ZodIssue;
    throw new ConfigInvalidError(CONFIG_FILE, keyPathOf(issue), issue.message);
  }
  return parsed.data;
}

/**
 * Every folder the configured types write to, with `{area}` expanded per area, unique, in the
 * order the types are declared.
 */
export function expandTypeFolders(config: VaultConfig): string[] {
  const folders = new Set<string>();
  for (const entry of Object.values(config.types)) {
    if (entry.folder === undefined) continue;
    if (entry.folder.includes("{area}")) {
      for (const area of config.areas) {
        folders.add(entry.folder.replaceAll("{area}", area));
      }
    } else {
      folders.add(entry.folder);
    }
  }
  return [...folders];
}
