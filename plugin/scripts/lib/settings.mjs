/**
 * @typedef {object} Settings
 * @property {string} area
 * @property {string} server_name
 * @property {string} model
 * @property {number} min_user_prompts
 * @property {string} note_language
 * @property {boolean} enabled
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  area: "",
  server_name: "brain",
  model: "sonnet",
  min_user_prompts: 3,
  note_language: "en",
  enabled: true,
});

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @returns {string | undefined}
 */
function raw(env, key) {
  const value = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads the plugin options Claude Code exports to hook processes. Never mutates `env`.
 * @param {Record<string, string | undefined>} env
 * @returns {Settings}
 */
export function readSettings(env) {
  const off = raw(env, "enabled")?.toLowerCase();
  const prompts = raw(env, "min_user_prompts");
  const parsed = prompts !== undefined && /^\d+$/.test(prompts) ? Number(prompts) : Number.NaN;
  return {
    area: raw(env, "area") ?? DEFAULTS.area,
    server_name: raw(env, "server_name") ?? DEFAULTS.server_name,
    model: raw(env, "model") ?? DEFAULTS.model,
    min_user_prompts: Number.isSafeInteger(parsed) ? parsed : DEFAULTS.min_user_prompts,
    note_language: raw(env, "note_language") ?? DEFAULTS.note_language,
    enabled: !(off === "false" || off === "0"),
  };
}
