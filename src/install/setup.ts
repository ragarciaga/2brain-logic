import { constants } from "node:fs";
import { type FileHandle, lchown, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CliIo } from "../cli.js";
import { parseSshRemote } from "./answers.js";
import { type EnvAnswers, EnvValueError, mergeEnv, readEnvText, writeEnvFile } from "./env-file.js";
import {
  askSetupAnswers,
  type CurrentValues,
  createStreamTerminal,
  displayValue,
  type NonInteractiveAnswers,
  PromptAbort,
  type PromptTerminal,
  readNonInteractive,
} from "./prompt.js";
import {
  type CaptureRunner,
  ensureDeployKey,
  execFileCaptureRunner,
  execFileRunner,
  gitSshCommand,
  pinConfirmedHostKey,
  pinGithubHostKey,
  type Runner,
  scanHostKey,
} from "./ssh.js";
import { bootstrapVault, FIX_OWNERSHIP } from "./vault-bootstrap.js";

/**
 * `node dist/cli.js setup`: the installer's one command. Every effect (process identity, chown,
 * terminal, runners, bootstrap) is injected, so tests run as any user without touching the real
 * process. No answer, hash, token or key byte is ever placed in an output line.
 */

/** The unprivileged identity the service and the key files use (the `node` user of the image). */
const SERVICE_ID = 1000;
const PUB_KEY_MAX_BYTES = 4096;
const PUB_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/=]+(?: [\x20-\x7e]*)?$/;
const KEY_PATH_MAX = 120;
const CHOWN_NAMES = ["deploy_key", "deploy_key.pub", "known_hosts"];
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;

export const SETUP_USAGE =
  "usage: node dist/cli.js setup [--project-dir <dir>] [--vault-dir <dir>] | node dist/cli.js setup --non-interactive --remote <git-ssh-url> --author-name <name> --author-email <email> [--public-base-url <url> (--passphrase-stdin | --keep-passphrase)] [--host-fingerprint <SHA256:...>]";
const REMOTE_RULE = "use git@host:owner/repo.git or ssh://user@host[:port]/path";
const DONE_FIX =
  "start the service with docker compose up -d --build, then run docker compose run --rm doctor";
const LOCK_FIX =
  "another setup is running; if none is, delete secrets/.setup.lock and re-run setup";

export interface SetupProc {
  getuid?: () => number;
  setgid: (gid: number) => void;
  setuid: (uid: number) => void;
  setgroups?: (groups: number[]) => void;
}

export interface SetupTerminal {
  term: PromptTerminal;
  /** Stops listening to the input. Called once on every path. */
  close(): void;
}

export interface SetupDeps {
  proc: SetupProc;
  lchown: (path: string, uid: number, gid: number) => Promise<void>;
  /** Changes the owner of an already opened and checked file or directory (never follows a path). */
  fchown: (handle: FileHandle, path: string, uid: number, gid: number) => Promise<void>;
  openTerminal: () => SetupTerminal;
  keygenRunner: Runner;
  captureRunner: CaptureRunner;
  bootstrapVault: typeof bootstrapVault;
  ensureDeployKey: typeof ensureDeployKey;
  writeEnvFile: typeof writeEnvFile;
  env: Record<string, string | undefined>;
}

type InputLike = Parameters<typeof createStreamTerminal>[0];

// biome-ignore lint/suspicious/noExplicitAny: stream listeners take any argument list
type Listener = (...args: any[]) => void;

/** A terminal on the real process streams whose `close()` removes only the listeners it added. */
function openProcessTerminal(): SetupTerminal {
  const stdin = process.stdin;
  const added: Array<[string, Listener]> = [];
  const input = {
    isTTY: stdin.isTTY === true,
    setEncoding: (encoding: BufferEncoding) => stdin.setEncoding(encoding),
    setRawMode: (on: boolean) => {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(on);
    },
    on: (event: string, listener: Listener) => {
      added.push([event, listener]);
      stdin.on(event, listener);
    },
  } as unknown as InputLike;
  const term = createStreamTerminal(input, process.stdout);
  return {
    term,
    close: () => {
      for (const [event, listener] of added) stdin.off(event, listener);
      added.length = 0;
      try {
        if (typeof stdin.setRawMode === "function" && stdin.isTTY) stdin.setRawMode(false);
      } catch {
        // The stream may already be closed.
      }
      stdin.pause();
    },
  };
}

export const defaultSetupDeps: SetupDeps = {
  proc: {
    getuid:
      typeof process.getuid === "function" ? () => (process.getuid as () => number)() : undefined,
    setgid: (gid) => (process.setgid as (g: number) => void)(gid),
    setuid: (uid) => (process.setuid as (u: number) => void)(uid),
    setgroups: (groups) => (process.setgroups as (g: number[]) => void)(groups),
  },
  lchown,
  fchown: (handle, _path, uid, gid) => handle.chown(uid, gid),
  openTerminal: openProcessTerminal,
  keygenRunner: execFileRunner,
  captureRunner: execFileCaptureRunner,
  bootstrapVault,
  ensureDeployKey,
  writeEnvFile,
  env: process.env,
};

class Finish extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super("setup finished");
    this.exitCode = exitCode;
  }
}

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

function underOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readOneLine(term: PromptTerminal): Promise<string | null> {
  let buffer = "";
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline).replaceAll("\r", "");
    const chunk = await term.read();
    if (chunk === null) return null;
    buffer += chunk;
  }
}

function currentValues(text: string): CurrentValues {
  const merged = mergeEnv(text, {}, () => "unused");
  const current: CurrentValues = { hasPassphraseHash: merged.OWNER_PASSPHRASE_HASH !== "" };
  if (merged.VAULT_REMOTE !== "") current.remote = merged.VAULT_REMOTE;
  if (merged.GIT_AUTHOR_NAME !== "") current.authorName = merged.GIT_AUTHOR_NAME;
  if (merged.GIT_AUTHOR_EMAIL !== "") current.authorEmail = merged.GIT_AUTHOR_EMAIL;
  if (merged.PUBLIC_BASE_URL !== "") current.publicBaseUrl = merged.PUBLIC_BASE_URL;
  if (/^[0-9]+$/.test(merged.TRUST_PROXY_HOPS))
    current.trustProxyHops = Number(merged.TRUST_PROXY_HOPS);
  current.n8nNetwork = merged.N8N_NETWORK;
  return current;
}

/** Runs setup and returns the exit code: 0 done, 1 failed, 2 usage error or missing answers. */
export async function runSetup(
  argv: readonly string[],
  io: CliIo,
  deps: SetupDeps = defaultSetupDeps,
): Promise<number> {
  const args = argv.slice(1);
  let opened: SetupTerminal | undefined;
  let lockPath: string | undefined;

  const emit = (code: string, text: string, exitCode: number): never => {
    const line = `setup: ${code}: ${text}`;
    if (exitCode === 0) io.stdout(line);
    else io.stderr(line);
    throw new Finish(exitCode);
  };
  const failMessage = (message: string): never => {
    const code = /^[a-z_]+(?=: )/.exec(message)?.[0] ?? "keygen_failed";
    return emit(code, message.slice(code.length + 2), 1);
  };

  try {
    const nonInteractive = args.includes("--non-interactive");
    let answers: NonInteractiveAnswers;
    let projectFlag: string | undefined;
    let vaultFlag: string | undefined;

    // 1. Directories first from the flags, so nothing is asked before they are known to be sane.
    if (nonInteractive) {
      let result: Awaited<ReturnType<typeof readNonInteractive>>;
      try {
        result = await readNonInteractive(args, io.readStdin);
      } catch {
        return emit("invalid_answer", "passphrase: could not read standard input", 1);
      }
      if (!result.ok) {
        if (result.code === "usage") {
          return emit("missing_answers", SETUP_USAGE, 2);
        }
        if (result.code === "missing_answers") {
          return emit("missing_answers", `provide ${result.fields.join(", ")}`, 2);
        }
        if (result.code === "remote_not_ssh") {
          return emit("remote_not_ssh", `remote: ${REMOTE_RULE}`, 1);
        }
        return emit(result.code, `${result.fields.join(", ")}: ${result.rule ?? "invalid"}`, 1);
      }
      answers = result.answers;
      projectFlag = answers.projectDir;
      vaultFlag = answers.vaultDir;
    } else {
      let parsed: { "project-dir"?: string; "vault-dir"?: string };
      try {
        parsed = parseArgs({
          args: [...args],
          options: { "project-dir": { type: "string" }, "vault-dir": { type: "string" } },
          strict: true,
          allowPositionals: false,
        }).values;
      } catch {
        return emit("missing_answers", SETUP_USAGE, 2);
      }
      if (!io.stdinIsTTY) {
        return emit(
          "missing_answers",
          "standard input is not a terminal; use --non-interactive with flags",
          2,
        );
      }
      projectFlag = parsed["project-dir"];
      vaultFlag = parsed["vault-dir"];
      answers = undefined as unknown as NonInteractiveAnswers;
    }

    // 2. Directory checks.
    const projectDir = resolve(projectFlag ?? "/project");
    try {
      if (!(await stat(projectDir)).isDirectory()) throw new Error("not a directory");
    } catch {
      return emit("invalid_answer", "project-dir: must be an existing directory", 1);
    }
    try {
      gitSshCommand(join(projectDir, "secrets"));
    } catch {
      return emit(
        "invalid_answer",
        "project-dir: use letters, digits and / . _ - in an absolute path",
        1,
      );
    }
    const vaultDir = resolve(vaultFlag ?? (deps.env.VAULT_DIR || "/data/vault"));
    try {
      const info = await lstat(vaultDir).catch((error: unknown) => {
        if (errCode(error) === "ENOENT") return null;
        throw error;
      });
      if (info === null) {
        if (!(await stat(resolve(vaultDir, "..")).then((s) => s.isDirectory()))) {
          throw new Error("no parent");
        }
      } else if (!info.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      return emit(
        "invalid_answer",
        "vault-dir: must be an existing directory (not a link), or a new one in an existing directory",
        1,
      );
    }
    if (underOrEqual(vaultDir, projectDir)) {
      return emit("invalid_answer", "vault-dir: must not be or contain the project directory", 1);
    }

    // 3. Current .env, then the interactive answers.
    let envText: string;
    try {
      envText = await readEnvText(projectDir);
    } catch {
      return emit("project_not_writable", FIX_OWNERSHIP, 1);
    }
    const tty = !nonInteractive;
    if (tty) {
      opened = deps.openTerminal();
      try {
        answers = await askSetupAnswers(opened.term, currentValues(envText));
      } catch (error) {
        if (error instanceof PromptAbort) {
          if (error.code === "hash_failed") {
            return emit("invalid_answer", "passphrase: could not be hashed on this machine", 1);
          }
          return emit("missing_answers", error.message, 2);
        }
        throw error;
      }
    }
    const final: NonInteractiveAnswers = answers;
    if (final.keepPassphrase && !currentValues(envText).hasPassphraseHash) {
      return emit(
        "missing_answers",
        "passphrase: no OWNER_PASSPHRASE_HASH in .env to keep; pass --passphrase-stdin",
        2,
      );
    }

    // 4. Write .env.
    const envAnswers: EnvAnswers = {
      vaultRemote: final.remote,
      authorName: final.authorName,
      authorEmail: final.authorEmail,
      publicBaseUrl: final.publicBaseUrl,
      n8nNetwork: final.n8nNetwork,
    };
    if (final.trustProxyHops !== undefined) envAnswers.trustProxyHops = final.trustProxyHops;
    if (final.passphraseHash !== undefined) envAnswers.passphraseHash = final.passphraseHash;
    try {
      const written = await deps.writeEnvFile(projectDir, envAnswers);
      if (!written.ok) return emit("project_not_writable", FIX_OWNERSHIP, 1);
    } catch (error) {
      if (error instanceof Finish) throw error;
      if (error instanceof EnvValueError) {
        return emit("invalid_answer", `${error.key}: value cannot be written to .env`, 1);
      }
      return emit("project_not_writable", FIX_OWNERSHIP, 1);
    }

    // 5. Ownership (root only), secrets directory, lock, privilege drop.
    const isRoot = deps.proc.getuid?.() === 0;
    const secretsDir = join(projectDir, "secrets");
    try {
      if (isRoot) {
        const owner = await stat(projectDir);
        await deps.lchown(join(projectDir, ".env"), owner.uid, owner.gid);
      }
      const info = await lstat(secretsDir).catch((error: unknown) => {
        if (errCode(error) === "ENOENT") return null;
        throw error;
      });
      if (info === null) await mkdir(secretsDir, { mode: 0o700 });
      else if (!info.isDirectory()) {
        return emit("keygen_failed", "secrets is not a directory", 1);
      }
      const dirHandle = await open(secretsDir, DIR_FLAGS);
      try {
        if (!(await dirHandle.stat()).isDirectory()) throw new Error("not a directory");
        await dirHandle.chmod(0o700);
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      if (error instanceof Finish) throw error;
      return emit("project_not_writable", FIX_OWNERSHIP, 1);
    }
    try {
      const handle = await open(join(secretsDir, ".setup.lock"), "wx", 0o600);
      await handle.close();
      lockPath = join(secretsDir, ".setup.lock");
    } catch {
      return emit("project_not_writable", LOCK_FIX, 1);
    }
    try {
      if (isRoot) {
        const dirHandle = await open(secretsDir, DIR_FLAGS);
        try {
          if (!(await dirHandle.stat()).isDirectory()) throw new Error("not a directory");
          await deps.fchown(dirHandle, secretsDir, SERVICE_ID, SERVICE_ID);
        } finally {
          await dirHandle.close();
        }
        // Only the three expected names; each is opened without following a link and must be a
        // regular file with one link, so a planted hard link to another file is never handed over.
        for (const name of CHOWN_NAMES) {
          const file = join(secretsDir, name);
          let handle: FileHandle;
          try {
            handle = await open(file, FILE_FLAGS);
          } catch (error) {
            if (errCode(error) === "ENOENT") continue;
            return emit("keygen_failed", `secrets/${name} is not a plain file`, 1);
          }
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1) {
              return emit("keygen_failed", `secrets/${name} is not a plain file`, 1);
            }
            await deps.fchown(handle, file, SERVICE_ID, SERVICE_ID);
          } finally {
            await handle.close();
          }
        }
        deps.proc.setgroups?.([]);
        deps.proc.setgid(SERVICE_ID);
        deps.proc.setuid(SERVICE_ID);
      }
    } catch (error) {
      if (error instanceof Finish) throw error;
      return emit("project_not_writable", FIX_OWNERSHIP, 1);
    }

    // 6. Deploy key and host pin.
    const key = await deps.ensureDeployKey(projectDir, deps.keygenRunner);
    if (!key.ok) return failMessage(key.message);
    const parsedRemote = parseSshRemote(final.remote);
    if (!parsedRemote.ok) return emit("remote_not_ssh", `remote: ${REMOTE_RULE}`, 1);
    const remote = parsedRemote.remote;
    if (remote.host === "github.com") {
      const scan = await scanHostKey(remote, deps.captureRunner);
      if (!scan.ok) return failMessage(scan.message);
      const pin = pinGithubHostKey(secretsDir, remote, scan.text);
      if (!pin.ok) return failMessage(pin.message);
    } else {
      const confirm =
        tty && opened !== undefined ? { term: opened.term } : { expected: final.hostFingerprint };
      const pin = await pinConfirmedHostKey(secretsDir, remote, confirm, deps.captureRunner);
      if (!pin.ok) return failMessage(pin.message);
    }

    // 7. Show the public key and the steps; wait for Enter on a terminal.
    const pubPath = join(secretsDir, "deploy_key.pub");
    let pubText: string;
    try {
      const info = await lstat(pubPath);
      if (!info.isFile() || info.size > PUB_KEY_MAX_BYTES) throw new Error("bad key file");
      const handle = await open(pubPath, "r");
      try {
        pubText = (await handle.readFile("utf8")).trim();
      } finally {
        await handle.close();
      }
      if (!PUB_KEY_RE.test(pubText)) throw new Error("bad key text");
    } catch {
      return emit("keygen_failed", "deploy_key.pub is not a valid public key", 1);
    }
    io.stdout("Public deploy key (add it to the vault repository):");
    io.stdout(pubText);
    io.stdout("Steps:");
    io.stdout("  1. Open the vault repository settings and go to Deploy keys.");
    io.stdout("  2. Add the public key above and enable write access.");
    if (tty && opened !== undefined) {
      opened.term.write("Added the deploy key with write access? Press Enter: ");
      const line = await readOneLine(opened.term);
      if (line === null) {
        return emit("missing_answers", "input ended before the deploy key was confirmed", 2);
      }
    }

    // 8. Vault bootstrap.
    let result: Awaited<ReturnType<typeof bootstrapVault>>;
    try {
      result = await deps.bootstrapVault({
        remote: final.remote,
        vaultDir,
        author: { name: final.authorName, email: final.authorEmail },
        gitEnv: { GIT_SSH_COMMAND: gitSshCommand(secretsDir) },
      });
    } catch {
      return emit("project_not_writable", FIX_OWNERSHIP, 1);
    }
    if (result.code === "done") return emit("done", DONE_FIX, 0);
    if (result.code === "config_invalid") {
      const where = displayValue("other", result.keyPath ?? "").slice(0, KEY_PATH_MAX);
      return emit(
        "config_invalid",
        `${result.fix} (${result.file ?? "config"}${where === "" ? "" : `: ${where}`})`,
        1,
      );
    }
    return emit(result.code, result.fix, 1);
  } catch (error) {
    if (error instanceof Finish) return error.exitCode;
    io.stderr("setup: project_not_writable: unexpected error; check permissions and re-run setup");
    return 1;
  } finally {
    if (lockPath !== undefined) await unlink(lockPath).catch(() => {});
    opened?.close();
  }
}
