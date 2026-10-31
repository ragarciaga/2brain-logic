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

/** Credential and backend variables removed from the child env (API billing guard). */
export const STRIPPED_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

const CAPTURE_FLAG = "TWOBRAIN_CAPTURE";
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
 * Never mutates `env`. The returned env drops the credential and backend variables
 * (STRIPPED_ENV, in any letter case on win32, where env keys are case-insensitive) so the run
 * uses the subscription, and forces TWOBRAIN_CAPTURE=1; an own `__proto__` key is skipped. `cwd` is the plugin data dir.
 * @param {Settings} settings
 * @param {Record<string, string | undefined>} env
 * @param {Paths} paths
 * @param {{ platform?: string }} [opts]
 * @returns {{ argv: string[], env: Record<string, string | undefined>, cwd: string } | { error: "not_configured" }}
 */
export function buildInvocation(settings, env, paths, opts = {}) {
  const platform = opts.platform ?? process.platform;
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
  const win = platform === "win32";
  /** @type {Record<string, string | undefined>} */
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "__proto__") continue;
    const name = win ? key.toUpperCase() : key;
    if (STRIPPED_ENV.includes(name)) continue;
    if (win && name === CAPTURE_FLAG) continue;
    childEnv[key] = value;
  }
  childEnv[CAPTURE_FLAG] = "1";
  return { argv, env: childEnv, cwd: paths.dataDir };
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} name
 * @param {boolean} win
 * @returns {unknown}
 */
function lookup(obj, name, win) {
  if (!win) return Object.hasOwn(obj, name) ? obj[name] : undefined;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (key.toUpperCase() === name && typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Looks in the user settings file (`CLAUDE_CONFIG_DIR` first, looked up case-insensitively on
 * win32) for something that can bill the API: a non-empty `apiKeyHelper`, or an `env` object
 * holding a STRIPPED_ENV name (case-insensitive on win32) with a non-empty string value, since
 * `--setting-sources user` loads that block back into the child. The caller must not spawn when
 * it returns `api_helper_present`. A leading BOM is ignored. Never throws.
 * @param {{ home: string, env: Record<string, string | undefined> }} input
 * @param {{ platform?: string }} [opts]
 * @returns {"api_helper_present" | "ok"}
 */
export function checkApiHelper({ home, env }, opts = {}) {
  try {
    const win = (opts.platform ?? process.platform) === "win32";
    const dir = lookup(env, "CLAUDE_CONFIG_DIR", win);
    const file =
      typeof dir === "string" && dir !== ""
        ? join(dir, "settings.json")
        : join(home, ".claude", "settings.json");
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return "ok";
    if (typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.length > 0) {
      return "api_helper_present";
    }
    const block = parsed.env;
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const name of STRIPPED_ENV) {
        const value = lookup(block, name, win);
        if (typeof value === "string" && value !== "") return "api_helper_present";
      }
    }
    return "ok";
  } catch {
    return "ok";
  }
}
