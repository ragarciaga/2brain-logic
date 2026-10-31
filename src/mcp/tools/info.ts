import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadVaultConfig, type VaultConfig } from "../../config/vault-config.js";
// Types only: server.ts imports INFO_TOOLS from this module.
import type { McpServerDeps, McpToolDefinition } from "../server.js";
import { type Failure, guarded } from "./read.js";

/**
 * The `vault_info` tool (R10.1, R10.2): read only. It describes the shape of the vault so a client
 * can pick valid areas, types and property names, since `read` refuses `.2brain/`.
 *
 * - The answer is built field by field from an allowlist: areas, property names, types with their
 *   folder pattern, and the archive folder. Nothing else from the config, no file content, no env
 *   value and no server setting ever reaches it.
 * - It runs through `guarded` like the read tools: the config is loaded after the pull, a failed
 *   pull adds `stale: true`, and failures are fixed codes. It takes no input and never writes.
 */

export interface VaultInfoType {
  key: string;
  value: string;
  folder: string | null;
}

export interface VaultInfo {
  areas: string[];
  properties: { type: string; area: string; date: string; source: string; source_id: string };
  types: VaultInfoType[];
  archive_folder: string;
}

export type InfoOutcome = ({ ok: true } & VaultInfo) | Failure;

/** Pick the public fields of a vault config, one by one (never a spread). */
export function buildVaultInfo(config: VaultConfig): VaultInfo {
  return {
    areas: [...config.areas],
    properties: {
      type: config.properties.type,
      area: config.properties.area,
      date: config.properties.date,
      source: config.properties.source,
      source_id: config.properties.source_id,
    },
    types: Object.entries(config.types).map(([key, entry]) => ({
      key,
      value: entry.value,
      folder: entry.folder ?? null,
    })),
    archive_folder: config.vault.archive_folder,
  };
}

/** The `vault_info` tool. */
export function createInfoTools(): McpToolDefinition[] {
  const vaultInfo: McpToolDefinition = {
    name: "vault_info",
    register(server: McpServer, deps: McpServerDeps) {
      server.registerTool(
        "vault_info",
        {
          description:
            "Read only. Describe the vault: its areas, property names, note types with their folder patterns, and the archive folder.",
        },
        () =>
          guarded(
            deps,
            async (): Promise<InfoOutcome> => ({
              ok: true,
              ...buildVaultInfo(await loadVaultConfig(resolve(deps.config.vaultDir))),
            }),
          ),
      );
    },
  };
  return [vaultInfo];
}

export const INFO_TOOLS: readonly McpToolDefinition[] = Object.freeze(createInfoTools());
