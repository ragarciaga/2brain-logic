import { parseArgs } from "node:util";
import { hashPassphrase, MIN_PASSPHRASE_LENGTH, passphraseLength } from "../auth/owner.js";
import {
  type AnswerError,
  type AnswerResult,
  parseSshRemote,
  renderAnswerError,
  validateAuthorEmail,
  validateAuthorName,
  validateHopCount,
  validateNetworkName,
  validatePassphrase,
  validatePublicBaseUrl,
} from "./answers.js";

/**
 * The installer's two ways to collect setup answers: the interactive question flow and the
 * non-interactive flags. The interactive flow talks to an injected terminal, validates every answer
 * with the validators in answers.ts, and asks again until the answer is valid. The flags are parsed
 * by `readNonInteractive`, which reads the passphrase only from stdin. Neither writes a file. No
 * typed or passed value (above all the passphrase) reaches an output or an error message.
 */

export interface PromptTerminal {
  write(text: string): void;
  /** The next input chunk, or `null` at the end of input. */
  read(): Promise<string | null>;
  setRawMode(on: boolean): void;
  isTTY: boolean;
}

export type PromptAbortCode = "interrupted" | "input_closed" | "not_a_terminal" | "hash_failed";

const ABORT_MESSAGES: Record<PromptAbortCode, string> = {
  interrupted: "setup interrupted",
  input_closed: "input ended before the questions were answered",
  not_a_terminal: "a passphrase can only be typed in a terminal",
  hash_failed: "the passphrase could not be hashed",
};

export class PromptAbort extends Error {
  readonly code: PromptAbortCode;
  constructor(code: PromptAbortCode) {
    super(ABORT_MESSAGES[code]);
    this.name = "PromptAbort";
    this.code = code;
  }
}

type InputLike = {
  isTTY?: boolean;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  setRawMode?: (on: boolean) => unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "end" | "close" | "error", listener: () => void): unknown;
};

type OutputLike = { write(text: string): unknown };

/** Adapts a Node input and output stream pair (a TTY, or a PassThrough in tests). */
export function createStreamTerminal(input: InputLike, output: OutputLike): PromptTerminal {
  const queue: string[] = [];
  let ended = false;
  let waiting: ((value: string | null) => void) | undefined;

  const finish = (): void => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(null);
    }
  };

  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(text);
      return;
    }
    queue.push(text);
  });
  input.on("end", finish);
  input.on("close", finish);
  input.on("error", finish);

  return {
    write: (text) => {
      output.write(text);
    },
    read: () => {
      const next = queue.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      if (ended) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        waiting = resolve;
      });
    },
    setRawMode: (on) => {
      input.setRawMode?.(on);
    },
    isTTY: input.isTTY === true,
  };
}

/** Input read ahead of the current prompt, shared by every prompt of one run. */
type Reader = { term: PromptTerminal; buffer: string };

async function readLine(reader: Reader): Promise<string> {
  for (;;) {
    const newline = reader.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = reader.buffer.slice(0, newline);
      reader.buffer = reader.buffer.slice(newline + 1);
      return line.replaceAll("\r", "");
    }
    const chunk = await reader.term.read();
    if (chunk === null) {
      throw new PromptAbort("input_closed");
    }
    reader.buffer += chunk;
  }
}

/**
 * Reads one entry with no echo. Raw mode is on only while reading and is turned off in `finally`
 * on every path. Nothing is written per key, only a newline at the end.
 */
export async function readHidden(term: PromptTerminal, label: string): Promise<string> {
  return readHiddenFrom({ term, buffer: "" }, label);
}

async function readHiddenFrom(reader: Reader, label: string): Promise<string> {
  const { term } = reader;
  if (!term.isTTY) {
    throw new PromptAbort("not_a_terminal");
  }
  term.write(label);
  let entry: string[] = [];
  // 0: plain, 1: after ESC, 2: inside a CSI or SS3 sequence
  let escState = 0;
  try {
    term.setRawMode(true);
    for (;;) {
      let chunk: string;
      if (reader.buffer !== "") {
        chunk = reader.buffer;
        reader.buffer = "";
      } else {
        const next = await term.read();
        if (next === null) {
          throw new PromptAbort("input_closed");
        }
        chunk = next;
      }
      const chars = Array.from(chunk);
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        const code = ch.codePointAt(0) as number;
        if (escState === 1) {
          escState = ch === "[" || ch === "O" ? 2 : 0;
          continue;
        }
        if (escState === 2) {
          if (code >= 0x40 && code <= 0x7e) {
            escState = 0;
          }
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          let rest = chars.slice(i + 1);
          if (ch === "\r" && rest[0] === "\n") {
            rest = rest.slice(1);
          }
          reader.buffer = rest.join("");
          term.write("\n");
          return entry.join("");
        }
        if (ch === "\u0003") {
          throw new PromptAbort("interrupted");
        }
        if (ch === "\u0004") {
          throw new PromptAbort("input_closed");
        }
        if (ch === "\u007f" || ch === "\b") {
          entry = entry.slice(0, -1);
          continue;
        }
        if (ch === "\u001b") {
          escState = 1;
          continue;
        }
        if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
          continue;
        }
        entry.push(ch);
      }
    }
  } finally {
    entry = [];
    term.setRawMode(false);
  }
}

const REMOTE_PRINTABLE_RE = /^[\x21-\x7e]+$/;

function isEscaped(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0xfeff
  );
}

/**
 * What to show in brackets. A remote is shown only when it is printable ASCII and a valid SSH
 * remote (otherwise nothing, so a hidden character cannot disguise the repository). Any other
 * value has control, bidi and zero-width characters escaped as `\u{XXXX}`.
 */
export function displayValue(field: "remote" | "other", value: string): string {
  if (field === "remote") {
    return REMOTE_PRINTABLE_RE.test(value) && parseSshRemote(value).ok ? value : "";
  }
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    out += isEscaped(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}` : ch;
  }
  return out;
}

export type CurrentValues = {
  remote?: string;
  authorName?: string;
  authorEmail?: string;
  publicBaseUrl?: string;
  trustProxyHops?: number;
  n8nNetwork?: string;
  hasPassphraseHash: boolean;
};

export type PromptAnswers = {
  remote: string;
  authorName: string;
  authorEmail: string;
  publicBaseUrl: string;
  trustProxyHops?: number;
  passphraseHash?: string;
  keepPassphrase: boolean;
  n8nNetwork: string;
};

const REMOTE_RULE = "remote_not_ssh: use git@host:owner/repo.git or ssh://user@host[:port]/path";
const KEEP_RULE = "answer y or n";
const PASSPHRASE_LENGTH_RULE = "must be 12 characters or more";
const HASH_FAILED_RULE = "could not be hashed on this machine";

function reject(term: PromptTerminal, error: AnswerError): void {
  term.write(`${renderAnswerError(error)}\n`);
}

async function askLine<T>(
  reader: Reader,
  label: string,
  shown: string,
  fallback: string | undefined,
  validate: (value: string) => AnswerResult<T>,
): Promise<T> {
  for (;;) {
    reader.term.write(`${label} [${shown}]: `);
    let line = await readLine(reader);
    if (line === "" && fallback !== undefined) {
      line = fallback;
    }
    const result = validate(line);
    if (result.ok) {
      return result.value;
    }
    reject(reader.term, result.error);
  }
}

async function askKeep(reader: Reader): Promise<boolean> {
  for (;;) {
    reader.term.write("Keep the current passphrase? [Y/n]: ");
    const line = (await readLine(reader)).trim().toLowerCase();
    if (line === "" || line === "y" || line === "yes") {
      return true;
    }
    if (line === "n" || line === "no") {
      return false;
    }
    reject(reader.term, { field: "passphrase", rule: KEEP_RULE });
  }
}

async function askPassphraseHash(reader: Reader): Promise<string> {
  for (;;) {
    const first = await readHiddenFrom(reader, "passphrase: ");
    const second = await readHiddenFrom(reader, "passphrase repeat: ");
    const checked = validatePassphrase(first, second);
    if (!checked.ok) {
      reject(reader.term, checked.error);
      continue;
    }
    try {
      return await hashPassphrase(first);
    } catch {
      // The validator counts code points as typed, the hash counts them after NFC composition, so a
      // passphrase of combining sequences can pass the validator and still be too short here.
      // Any other failure (scrypt itself) will not change on a retry, so it aborts.
      if (passphraseLength(first) >= MIN_PASSPHRASE_LENGTH) throw new PromptAbort("hash_failed");
      reject(reader.term, { field: "passphrase", rule: PASSPHRASE_LENGTH_RULE });
    }
  }
}

/** Asks every setup question in order and returns the answers. Writes no file. */
export async function askSetupAnswers(
  term: PromptTerminal,
  current: CurrentValues,
): Promise<PromptAnswers> {
  const reader: Reader = { term, buffer: "" };

  const shownRemote = displayValue("remote", current.remote ?? "");
  const remoteDefault = shownRemote === "" ? undefined : shownRemote;
  const remote = await askLine(reader, "vault remote", shownRemote, remoteDefault, (value) => {
    if (value === "" || !parseSshRemote(value).ok) {
      return { ok: false, error: { field: "vault remote", rule: REMOTE_RULE } };
    }
    return { ok: true, value };
  });

  const authorName = await askLine(
    reader,
    "author name",
    displayValue("other", current.authorName ?? ""),
    current.authorName,
    validateAuthorName,
  );
  const authorEmail = await askLine(
    reader,
    "author email",
    displayValue("other", current.authorEmail ?? ""),
    current.authorEmail,
    validateAuthorEmail,
  );

  const currentUrl = current.publicBaseUrl ?? "";
  // A single "-" clears the shown value (MCP off), because Enter keeps it.
  const publicBaseUrl = await askLine(
    reader,
    "public base URL",
    displayValue("other", currentUrl),
    currentUrl,
    (value) => validatePublicBaseUrl(value === "-" ? "" : value),
  );

  const answers: PromptAnswers = {
    remote,
    authorName,
    authorEmail,
    publicBaseUrl,
    keepPassphrase: false,
    n8nNetwork: "",
  };

  if (publicBaseUrl !== "") {
    const hops = current.trustProxyHops ?? 1;
    answers.trustProxyHops = await askLine(
      reader,
      "proxy hop count",
      displayValue("other", String(hops)),
      String(hops),
      validateHopCount,
    );
    if (current.hasPassphraseHash) {
      answers.keepPassphrase = await askKeep(reader);
    }
    if (!answers.keepPassphrase) {
      answers.passphraseHash = await askPassphraseHash(reader);
    }
  }

  const network = current.n8nNetwork ?? "n8n";
  answers.n8nNetwork = await askLine(
    reader,
    "Docker network name",
    displayValue("other", network),
    network,
    validateNetworkName,
  );
  return answers;
}

export type NonInteractiveAnswers = PromptAnswers & {
  hostFingerprint?: string;
  projectDir?: string;
  vaultDir?: string;
};

export type NonInteractiveResult =
  | { ok: true; answers: NonInteractiveAnswers }
  | {
      ok: false;
      code: "usage" | "missing_answers" | "invalid_answer" | "remote_not_ssh";
      exitCode: 1 | 2;
      fields: string[];
      rule?: string;
    };

const STDIN_LIMIT_BYTES = 1024;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const FINGERPRINT_RULE = "must be SHA256: followed by 43 base64 characters";

const STRING_OPTIONS = [
  "remote",
  "author-name",
  "author-email",
  "public-base-url",
  "trust-proxy-hops",
  "n8n-network",
  "host-fingerprint",
  "project-dir",
  "vault-dir",
] as const;

const USAGE: NonInteractiveResult = { ok: false, code: "usage", exitCode: 2, fields: [] };

function invalid(field: string, rule: string): NonInteractiveResult {
  return { ok: false, code: "invalid_answer", exitCode: 1, fields: [field], rule };
}

/** Exactly one line of at most 1024 bytes of valid UTF-8, without its trailing line break. */
function decodePassphrase(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > STDIN_LIMIT_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.endsWith("\r\n")) {
    text = text.slice(0, -2);
  } else if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  return /[\r\n]/.test(text) ? undefined : text;
}

/**
 * Maps the setup flags to answers. Validates every answer before it reads stdin, so a failed run
 * never consumes the passphrase. The passphrase comes only from stdin and only its hash is kept.
 * No argv token, parser message or stdin byte is placed in a result. Reads and writes no file.
 */
export async function readNonInteractive(
  argv: readonly string[],
  readStdin: () => Promise<Uint8Array>,
): Promise<NonInteractiveResult> {
  const options: Record<string, { type: "string" | "boolean" }> = {
    "passphrase-stdin": { type: "boolean" },
    "keep-passphrase": { type: "boolean" },
    "non-interactive": { type: "boolean" },
  };
  for (const name of STRING_OPTIONS) {
    options[name] = { type: "string" };
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens ?? []) {
      if (token.kind === "option") {
        if (seen.has(token.name)) {
          return USAGE;
        }
        seen.add(token.name);
      }
    }
    values = parsed.values;
  } catch {
    return USAGE;
  }
  const str = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === "string" ? v : undefined;
  };
  const stdinFlag = values["passphrase-stdin"] === true;
  const keepFlag = values["keep-passphrase"] === true;
  if (stdinFlag && keepFlag) {
    return USAGE;
  }

  const remote = str("remote");
  const authorName = str("author-name");
  const authorEmail = str("author-email");
  const baseUrlRaw = str("public-base-url") ?? "";
  const withUrl = baseUrlRaw !== "";

  const missing: string[] = [];
  if (remote === undefined) missing.push("remote");
  if (authorName === undefined) missing.push("author-name");
  if (authorEmail === undefined) missing.push("author-email");
  if (withUrl && !stdinFlag && !keepFlag) missing.push("passphrase");
  if (
    missing.length > 0 ||
    remote === undefined ||
    authorName === undefined ||
    authorEmail === undefined
  ) {
    return { ok: false, code: "missing_answers", exitCode: 2, fields: missing };
  }

  if (!parseSshRemote(remote).ok) {
    return { ok: false, code: "remote_not_ssh", exitCode: 1, fields: ["remote"] };
  }
  const name = validateAuthorName(authorName);
  if (!name.ok) return invalid("author-name", name.error.rule);
  const email = validateAuthorEmail(authorEmail);
  if (!email.ok) return invalid("author-email", email.error.rule);
  const url = validatePublicBaseUrl(baseUrlRaw);
  if (!url.ok) return invalid("public-base-url", url.error.rule);
  const hops = validateHopCount(str("trust-proxy-hops") ?? (url.value === "" ? "0" : "1"));
  if (!hops.ok) return invalid("trust-proxy-hops", hops.error.rule);
  const network = validateNetworkName(str("n8n-network") ?? "n8n");
  if (!network.ok) return invalid("n8n-network", network.error.rule);
  const fingerprint = str("host-fingerprint");
  if (fingerprint !== undefined && !FINGERPRINT_RE.test(fingerprint)) {
    return invalid("host-fingerprint", FINGERPRINT_RULE);
  }

  const answers: NonInteractiveAnswers = {
    remote,
    authorName: name.value,
    authorEmail: email.value,
    publicBaseUrl: url.value,
    trustProxyHops: hops.value,
    keepPassphrase: false,
    n8nNetwork: network.value,
  };
  if (fingerprint !== undefined) answers.hostFingerprint = fingerprint;
  const projectDir = str("project-dir");
  if (projectDir !== undefined) answers.projectDir = projectDir;
  const vaultDir = str("vault-dir");
  if (vaultDir !== undefined) answers.vaultDir = vaultDir;

  if (url.value !== "") {
    if (keepFlag) {
      answers.keepPassphrase = true;
    } else if (stdinFlag) {
      const passphrase = decodePassphrase(await readStdin());
      if (passphrase === undefined) {
        return invalid("passphrase", "must be one line of at most 1024 bytes of UTF-8");
      }
      try {
        answers.passphraseHash = await hashPassphrase(passphrase);
      } catch {
        return invalid(
          "passphrase",
          passphraseLength(passphrase) < MIN_PASSPHRASE_LENGTH
            ? PASSPHRASE_LENGTH_RULE
            : HASH_FAILED_RULE,
        );
      }
    }
  }
  return { ok: true, answers };
}
