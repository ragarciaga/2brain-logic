import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlConfig } from "../vault/frontmatter.js";

const CONFIG_FILE = ".2brain/config.yaml";

const VaultConfigSchema = z.object({
  vault: z
    .object({
      archive_folder: z.string().min(1).default("Archive"),
    })
    .default({ archive_folder: "Archive" }),
});

export type VaultConfig = z.infer<typeof VaultConfigSchema>;

/** Load `.2brain/config.yaml` from the vault. A missing file gives the defaults. */
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
    throw new Error(`Invalid ${CONFIG_FILE}: ${(error as Error).message}`);
  }

  const parsed = VaultConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid ${CONFIG_FILE}: ${problems.join("; ")}`);
  }
  return parsed.data;
}
