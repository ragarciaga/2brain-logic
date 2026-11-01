import { z } from "zod";
import { isAllowedBaseUrl } from "../config/env.js";

/**
 * Pure validators for the installer's setup answers, plus the SSH remote parser.
 * Every check carries a fixed rule message. Zod's default messages and the issue input are never
 * read, so a value (a passphrase, an address) cannot reach an error. Keep it so when adding a check.
 */

export type AnswerField =
  | "vault remote"
  | "author name"
  | "author email"
  | "public base URL"
  | "proxy hop count"
  | "passphrase"
  | "passphrase repeat"
  | "Docker network name";

export type AnswerError = { field: AnswerField; rule: string };

export type AnswerResult<T> = { ok: true; value: T } | { ok: false; error: AnswerError };

export function renderAnswerError(e: AnswerError): string {
  return `${e.field}: ${e.rule}`;
}

function run<T>(
  schema: z.ZodType<T>,
  field: AnswerField,
  value: unknown,
  fallbackRule: string,
): AnswerResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const rule = parsed.error.issues[0]?.message ?? fallbackRule;
  return { ok: false, error: { field, rule } };
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const EMAIL_RULE = "must be an email address";
const EmailSchema = z.string({ error: EMAIL_RULE }).pipe(z.email({ error: EMAIL_RULE }));

export function validateAuthorEmail(value: string): AnswerResult<string> {
  return run(EmailSchema, "author email", value, EMAIL_RULE);
}

const NAME_EMPTY_RULE = "must not be empty";
const NAME_CONTROL_RULE = "must be a single line with no control characters";
const NAME_FORMAT_RULE = "must not contain direction-control or zero-width characters";
const FORMAT_CHAR_RE = /[\u202a-\u202e\u2066-\u2069\u061c\u200b-\u200f\ufeff]/;
const NAME_ENV_RULE =
  "cannot be stored in the .env file: no backslash, and no apostrophe together with $ or a double quote";

/**
 * True when a name can be written to the .env file in one of its forms: bare, single quoted or
 * double quoted. A backslash fits no form, an apostrophe together with `$` or `"` fits no form, and
 * a newline never fits. Shared by the prompt and the non-interactive flags.
 */
export function isEnvWritableName(value: string): boolean {
  if (value.includes("\n") || value.includes("\r") || value.includes("\\")) {
    return false;
  }
  if (value.includes("'") && /[$"]/.test(value)) {
    return false;
  }
  return true;
}

const NameSchema = z
  .string({ error: NAME_EMPTY_RULE })
  .refine((v) => v.trim().length > 0, { error: NAME_EMPTY_RULE })
  .refine((v) => !hasControlChar(v), { error: NAME_CONTROL_RULE })
  .refine((v) => !FORMAT_CHAR_RE.test(v), { error: NAME_FORMAT_RULE })
  .refine(isEnvWritableName, { error: NAME_ENV_RULE });

export function validateAuthorName(value: string): AnswerResult<string> {
  return run(NameSchema, "author name", value, NAME_EMPTY_RULE);
}

const URL_RULE = "must be an https origin with no path, or empty to turn MCP off";
const BaseUrlSchema = z
  .string({ error: URL_RULE })
  .refine(
    (v) => {
      if (v === "") {
        return true;
      }
      if (!isAllowedBaseUrl(v)) {
        return false;
      }
      return new URL(v).protocol === "https:";
    },
    { error: URL_RULE },
  )
  .transform((v) => (v === "" ? "" : new URL(v).origin));

/** `""` means MCP off. Otherwise the value is an https origin without a trailing slash. */
export function validatePublicBaseUrl(value: string): AnswerResult<string> {
  return run(BaseUrlSchema, "public base URL", value, URL_RULE);
}

const HOP_RULE = "must be a whole number from 0 to 10";
const HopSchema = z
  .string({ error: HOP_RULE })
  .regex(/^[0-9]+$/, { error: HOP_RULE })
  .transform(Number)
  .refine((n) => Number.isSafeInteger(n) && n <= 10, { error: HOP_RULE });

export function validateHopCount(value: string): AnswerResult<number> {
  return run(HopSchema, "proxy hop count", value, HOP_RULE);
}

const NETWORK_RULE = "must start with a letter or digit and use only letters, digits, _ . -";
const NetworkSchema = z
  .string({ error: NETWORK_RULE })
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { error: NETWORK_RULE });

export function validateNetworkName(value: string): AnswerResult<string> {
  return run(NetworkSchema, "Docker network name", value, NETWORK_RULE);
}

const PASSPHRASE_LENGTH_RULE = "must be 12 characters or more";
const PASSPHRASE_MATCH_RULE = "must match the first entry";
const PassphraseSchema = z
  .string({ error: PASSPHRASE_LENGTH_RULE })
  .min(12, { error: PASSPHRASE_LENGTH_RULE });

export function validatePassphrase(first: string, second: string): AnswerResult<string> {
  const length = run(PassphraseSchema, "passphrase", first, PASSPHRASE_LENGTH_RULE);
  if (!length.ok) {
    return length;
  }
  if (first !== second) {
    return { ok: false, error: { field: "passphrase repeat", rule: PASSPHRASE_MATCH_RULE } };
  }
  return length;
}

export type SshRemote = { user: string; host: string; port: number; path: string };

export type SshRemoteResult =
  | { ok: true; remote: SshRemote }
  | { ok: false; code: "remote_not_ssh" };

const USER = "([A-Za-z0-9_][A-Za-z0-9_.-]*)";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST = `(${LABEL}(?:\\.${LABEL})*)`;
const SCP_RE = new RegExp(`^${USER}@${HOST}:(\\S+)$`);
const SSH_RE = new RegExp(`^ssh://${USER}@${HOST}(?::([0-9]{1,5}))?/(\\S+)$`);

const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

function refuse(): SshRemoteResult {
  return { ok: false, code: "remote_not_ssh" };
}

/**
 * Accepts only `user@host:path` (port 22) and `ssh://user@host[:port]/path`. Regexes, not
 * `new URL`. Only printable ASCII (0x21 to 0x7e) is accepted, so a bidi, zero-width or control
 * character cannot hide in the path. A password, token, IPv6 literal or leading `-` in user or host is refused, and every
 * refusal is the same fixed object, so no part of the input can leak.
 */
export function parseSshRemote(input: string): SshRemoteResult {
  if (typeof input !== "string" || input.length > 2048 || !PRINTABLE_ASCII_RE.test(input)) {
    return refuse();
  }
  const scp = SCP_RE.exec(input);
  if (scp) {
    const [, user, host, path] = scp as unknown as [string, string, string, string];
    if (path.startsWith("-") || path.startsWith("/") || hasControlChar(path)) {
      return refuse();
    }
    return { ok: true, remote: { user, host: host.toLowerCase(), port: 22, path } };
  }
  const ssh = SSH_RE.exec(input);
  if (ssh) {
    const [, user, host, portText, path] = ssh as unknown as [
      string,
      string,
      string,
      string | undefined,
      string,
    ];
    const port = portText === undefined ? 22 : Number(portText);
    if (port < 1 || port > 65535 || hasControlChar(path)) {
      return refuse();
    }
    return { ok: true, remote: { user, host: host.toLowerCase(), port, path } };
  }
  return refuse();
}
