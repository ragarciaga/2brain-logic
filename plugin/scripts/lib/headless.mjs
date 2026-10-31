import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path, { join, resolve } from "node:path";
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

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

/** @param {string} model */
function validModel(model) {
  return typeof model === "string" && MODEL.test(model);
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
 * True when the settings env block sets `name` to anything but null or "" (exact key on POSIX,
 * any letter case on win32).
 * @param {Record<string, unknown>} block
 * @param {string} name
 * @param {boolean} win
 * @returns {boolean}
 */
function blockSets(block, name, win) {
  /** @param {unknown} value */
  const set = (value) => value !== undefined && value !== null && value !== "";
  if (!win) return Object.hasOwn(block, name) && set(block[name]);
  return Object.keys(block).some((key) => key.toUpperCase() === name && set(block[key]));
}

/**
 * Looks in the user settings file (`CLAUDE_CONFIG_DIR` first, looked up case-insensitively on
 * win32; a relative one is resolved against `cwd`, the directory the child runs in, falling
 * back to `home`) for something that can bill the API: a non-empty `apiKeyHelper`, or an `env`
 * object holding a STRIPPED_ENV name (case-insensitive on win32) with any value other than null
 * or "", since `--setting-sources user` loads that block back into the child. The caller must
 * not spawn when it returns `api_helper_present`. A leading BOM is ignored. Never throws.
 * Not checked: managed settings, and how the CLI itself resolves a relative `CLAUDE_CONFIG_DIR`.
 * @param {{ home: string, env: Record<string, string | undefined>, cwd?: string }} input
 * @param {{ platform?: string }} [opts]
 * @returns {"api_helper_present" | "ok"}
 */
export function checkApiHelper({ home, env, cwd }, opts = {}) {
  try {
    const win = (opts.platform ?? process.platform) === "win32";
    const dir = lookup(env, "CLAUDE_CONFIG_DIR", win);
    const file =
      typeof dir === "string" && dir !== ""
        ? join(resolve(cwd ?? home, dir), "settings.json")
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
      if (STRIPPED_ENV.some((name) => blockSets(block, name, win))) return "api_helper_present";
    }
    return "ok";
  } catch {
    return "ok";
  }
}

/** Default run limit of one capture, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 600000;
const MAX_STDOUT = 1024 * 1024;
const KILL_GRACE_MS = 5000;
const MAX_CMD_LINE = 8000;
const DETAIL = /^[a-z0-9_ =.,:-]{0,120}$/;
const PATH_CONTROL = /\p{Cc}/u;

/**
 * @param {string} file
 * @param {boolean} win
 * @returns {boolean}
 */
function defaultIsFile(file, win) {
  try {
    if (!statSync(file).isFile()) return false;
    if (!win) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds `claude` on the PATH of `env` without a shell. Empty and relative entries are skipped.
 * On win32 `claude.exe` anywhere on PATH wins over `claude.cmd`.
 * @param {Record<string, string | undefined>} env
 * @param {{ platform?: string, isFile?: (file: string) => boolean }} [opts]
 * @returns {{ file: string, kind: "exe" | "cmd" } | null}
 */
export function resolveClaude(env, opts = {}) {
  const win = (opts.platform ?? process.platform) === "win32";
  const p = win ? path.win32 : path.posix;
  const isFile = opts.isFile ?? ((file) => defaultIsFile(file, win));
  let raw;
  for (const key of Object.keys(env)) {
    const hit = win ? key.toUpperCase() === "PATH" : key === "PATH";
    if (hit && typeof env[key] === "string") {
      raw = env[key];
      break;
    }
  }
  if (raw === undefined) return null;
  const dirs = raw
    .split(win ? ";" : path.delimiter)
    .map((d) => (win ? d.replace(/^"(.*)"$/, "$1") : d))
    .filter((d) => d !== "" && p.isAbsolute(d));
  if (!win) {
    for (const dir of dirs) {
      const file = p.join(dir, "claude");
      if (isFile(file)) return { file, kind: "exe" };
    }
    return null;
  }
  for (const [name, kind] of /** @type {const} */ ([
    ["claude.exe", "exe"],
    ["claude.cmd", "cmd"],
  ])) {
    for (const dir of dirs) {
      const file = p.join(dir, name);
      if (isFile(file)) return { file, kind };
    }
  }
  return null;
}

const CMD_META = /[()[\]%!^"`<>&|;, *?]/g;

/**
 * Quotes one argument for a `.cmd` shim: C runtime quoting first, then caret escapes, applied
 * twice when `double` since the npm shim re-expands `%*` through cmd.exe. Algorithm after
 * cross-spawn (MIT), used as a reference only.
 * @param {string} arg
 * @param {boolean} double
 * @returns {string}
 */
function quoteCmdArg(arg, double) {
  let s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  s = s.replace(CMD_META, "^$&");
  return double ? s.replace(CMD_META, "^$&") : s;
}

/**
 * Builds the verbatim command line (without the outer quotes) that runs a `.cmd` shim through
 * `cmd.exe /d /s /c`. Returns null when an element holds CR, LF or NUL, or the line is too long.
 * @param {string} file
 * @param {string[]} argv
 * @returns {string | null}
 */
export function cmdLine(file, argv) {
  if ([file, ...argv].some((a) => /[\r\n\0]/.test(a))) return null;
  const line = [file.replace(CMD_META, "^$&"), ...argv.map((a) => quoteCmdArg(a, true))].join(" ");
  return line.length > MAX_CMD_LINE ? null : line;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPath(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 300 &&
    !PATH_CONTROL.test(value)
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPathList(value) {
  return Array.isArray(value) && value.length <= 50 && value.every(isPath);
}

/**
 * Checks a `structured_output` against result.schema.json at runtime (the model is not trusted)
 * and returns a fresh object with only the schema keys, or null.
 * @param {unknown} value
 * @returns {CaptureResult | null}
 */
function validateResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const schema = JSON.parse(readFileSync(fileURLToPath(SCHEMA_URL), "utf8"));
  /** @type {string[]} */
  const required = schema.required;
  const keys = Object.keys(value);
  if (keys.length !== required.length || !required.every((k) => Object.hasOwn(value, k))) {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (value);
  if (!schema.properties.status.enum.includes(o.status)) return null;
  if (o.session_note !== null && !isPath(o.session_note)) return null;
  if (!isPathList(o.recipes) || !isPathList(o.people_updated)) return null;
  if (typeof o.already_saved !== "boolean") return null;
  if (typeof o.detail !== "string" || !DETAIL.test(o.detail)) return null;
  return {
    status: /** @type {string} */ (o.status),
    session_note: /** @type {string | null} */ (o.session_note),
    recipes: [.../** @type {string[]} */ (o.recipes)],
    people_updated: [.../** @type {string[]} */ (o.people_updated)],
    already_saved: o.already_saved,
    detail: o.detail,
  };
}

/**
 * @typedef {object} CaptureResult
 * @property {string} status
 * @property {string | null} session_note
 * @property {string[]} recipes
 * @property {string[]} people_updated
 * @property {boolean} already_saved
 * @property {string} detail
 */

/**
 * @typedef {{ ok: true, result: CaptureResult }
 *   | { ok: false, code: "not_configured" | "api_helper_present" | "claude_not_found" | "timeout" }
 *   | { ok: false, code: "headless_failed", exit: number | null }} CaptureOutcome
 */

/**
 * Runs one headless capture: builds the invocation, refuses when user settings can bill the API,
 * resolves `claude` on PATH, spawns it without a shell (input on stdin only), kills the whole
 * process tree after `timeoutMs`, and validates the `structured_output` of the JSON answer.
 * The outcome never carries stdout or stderr text. Residual risks: managed settings are not
 * checked, and vault paths in a valid result reach the caller (the log strips control characters).
 * @param {{ settings: Settings, env: Record<string, string | undefined>, paths: Paths, input: string }} job
 * @param {{
 *   platform?: string,
 *   spawn?: typeof nodeSpawn,
 *   execFile?: typeof nodeExecFile,
 *   kill?: (pid: number, signal: NodeJS.Signals) => unknown,
 *   timeoutMs?: number,
 *   home?: string,
 *   isFile?: (file: string) => boolean,
 * }} [deps]
 * @returns {Promise<CaptureOutcome>}
 */
export function runCapture({ settings, env, paths, input }, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  const doSpawn = deps.spawn ?? nodeSpawn;
  const doExecFile = deps.execFile ?? nodeExecFile;
  const doKill = deps.kill ?? process.kill.bind(process);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** @type {(exit: number | null) => CaptureOutcome} */
  const failed = (exit) => ({ ok: false, code: "headless_failed", exit });

  const inv = buildInvocation(settings, env, paths, { platform });
  if ("error" in inv) return Promise.resolve({ ok: false, code: inv.error });
  if (
    checkApiHelper({ home: deps.home ?? homedir(), env: inv.env, cwd: inv.cwd }, { platform }) !==
    "ok"
  ) {
    return Promise.resolve({ ok: false, code: "api_helper_present" });
  }
  const found = resolveClaude(inv.env, { platform, isFile: deps.isFile });
  if (found === null) return Promise.resolve({ ok: false, code: "claude_not_found" });

  let command = found.file;
  let args = inv.argv;
  let verbatim = false;
  if (win && found.kind === "cmd") {
    const compact = inv.argv.map((a, i) =>
      inv.argv[i - 1] === "--json-schema" ? JSON.stringify(JSON.parse(a)) : a,
    );
    const line = cmdLine(found.file, compact);
    if (line === null) return Promise.resolve(failed(null));
    const root = lookup(inv.env, "SYSTEMROOT", true);
    const comspec = lookup(inv.env, "COMSPEC", true);
    command =
      typeof comspec === "string" && path.win32.isAbsolute(comspec)
        ? comspec
        : path.win32.join(typeof root === "string" ? root : "C:\\Windows", "System32", "cmd.exe");
    args = ["/d", "/s", "/c", `"${line}"`];
    verbatim = true;
  }

  return new Promise((done) => {
    let settled = false;
    /** @param {CaptureOutcome} outcome */
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      done(outcome);
    };
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let grace;
    let timedOut = false;
    let overflow = false;
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;

    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = doSpawn(command, args, {
        cwd: inv.cwd,
        env: inv.env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: !win,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
    } catch {
      return finish(failed(null));
    }

    const killTree = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (win) {
          doExecFile(
            "taskkill",
            ["/pid", String(pid), "/T", "/F"],
            {
              shell: false,
              windowsHide: true,
            },
            () => {},
          );
        } else {
          doKill(-pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      grace = setTimeout(
        () => finish(timedOut ? { ok: false, code: "timeout" } : failed(null)),
        KILL_GRACE_MS,
      );
      grace.unref?.();
    };

    child.on("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      finish(code === "ENOENT" ? { ok: false, code: "claude_not_found" } : failed(null));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_STDOUT) {
        overflow = true;
        chunks.length = 0;
        killTree();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, code: "timeout" });
      if (overflow || code !== 0) return finish(failed(typeof code === "number" ? code : null));
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return finish(failed(code));
      }
      const result =
        parsed !== null && typeof parsed === "object"
          ? validateResult(parsed.structured_output)
          : null;
      finish(result === null ? failed(code) : { ok: true, result });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
  });
}
