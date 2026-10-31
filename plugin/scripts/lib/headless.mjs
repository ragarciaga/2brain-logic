import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {import("./settings.mjs").Settings} Settings */

/**
 * @typedef {object} Paths
 * @property {string} pluginRoot
 * @property {string} dataDir
 */

/** The only tools a capture session may use, in the order of the permission rule. */
export const CAPTURE_TOOLS = Object.freeze([
  "vault_info",
  "search",
  "read",
  "save_note",
  "save_recipe",
  "update_properties",
]);

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const SCHEMA_URL = new URL("../../prompts/result.schema.json", import.meta.url);

/** @param {string} name */
function validServerName(name) {
  return typeof name === "string" && SERVER_NAME.test(name);
}

/** @param {string} model */
function validModel(model) {
  return (
    typeof model === "string" && model !== "" && !model.startsWith("-") && !/[\s,]/.test(model)
  );
}

/**
 * Builds the `claude -p` argument list of a capture session. `server_name` and `model` are
 * checked first: the name goes into comma-joined permission rules, the model could read as a flag.
 * Never mutates `env`; the environment filtering is done by the caller of this module.
 * @param {Settings} settings
 * @param {Record<string, string | undefined>} env
 * @param {Paths} paths
 * @returns {{ argv: string[], env: Record<string, string | undefined>, cwd: string } | { error: "not_configured" }}
 */
export function buildInvocation(settings, env, paths) {
  if (!validServerName(settings.server_name) || !validModel(settings.model)) {
    return { error: "not_configured" };
  }
  const allowed = CAPTURE_TOOLS.map((tool) => `mcp__${settings.server_name}__${tool}`).join(",");
  const schema = readFileSync(fileURLToPath(SCHEMA_URL), "utf8");
  const argv = [
    "-p",
    "--tools",
    "",
    "--allowedTools",
    allowed,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--model",
    settings.model,
    "--max-turns",
    "20",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--append-system-prompt-file",
    join(paths.pluginRoot, "prompts", "capture.md"),
    "--setting-sources",
    "user",
    "--no-session-persistence",
  ];
  return { argv, env: { ...env }, cwd: paths.dataDir };
}
