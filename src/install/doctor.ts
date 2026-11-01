import { lookup as dnsLookup } from "node:dns/promises";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { validateNetworkName } from "./answers.js";

/** The doctor check ids, in the order the runner executes and prints them. */
export const CHECK_IDS = [
  "env",
  "env_file",
  "secrets",
  "network",
  "remote_reachable",
  "remote_pushable",
  "vault_config",
  "ingest_health",
  "mcp_internal",
  "proxy_metadata",
  "proxy_mcp",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export type CheckOutcome =
  | { status: "pass" }
  | {
      status: "fail";
      /**
       * One line telling the owner what to do. Build it from fixed strings plus
       * ids, codes and paths. The runner redacts the secrets it knows
       * (`INGEST_TOKEN`, `OWNER_PASSPHRASE_HASH`, `VAULT_REMOTE`, `ANTHROPIC_API_KEY`), but nothing
       * else, so never put raw error text, response bodies or other
       * environment values in it.
       */
      fix: string;
    };

export interface DoctorCheck {
  id: CheckId;
  run(): Promise<CheckOutcome>;
}

/** The checks that need `PUBLIC_BASE_URL`; they are skipped while it is empty or blank. */
export const PUBLIC_CHECK_IDS: readonly CheckId[] = ["mcp_internal", "proxy_metadata", "proxy_mcp"];

export const SKIP_NOTE = "PUBLIC_BASE_URL is empty: claude.ai cannot connect";

/** Printed when a check throws; the thrown error text is never printed. */
export const UNEXPECTED_FIX =
  "the check stopped unexpectedly; run doctor again, then see docs/INSTALL.md Troubleshooting";

const REDACTED = "<redacted>";
const MIN_BARE_USER = 8;
const MIN_USER_BEFORE_COLON = 4;
const SCHEME_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/gi;

function userinfoOf(url: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^@/\s]*)@/i.exec(url);
  return match?.[1] || undefined;
}

/** Replaces the known secrets, and any `scheme://userinfo@`, in `text`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
  const needles = new Set<string>();
  for (const key of [
    "INGEST_TOKEN",
    "OWNER_PASSPHRASE_HASH",
    "VAULT_REMOTE",
    "ANTHROPIC_API_KEY",
  ] as const) {
    const value = env[key];
    if (!value) continue;
    needles.add(value);
    if (key === "VAULT_REMOTE") {
      const info = userinfoOf(value);
      if (info) {
        const colon = info.indexOf(":");
        // A short bare user name such as `git` is not a secret and would garble fix lines.
        if (colon < 0) {
          if (info.length >= MIN_BARE_USER) needles.add(info);
        } else {
          needles.add(info);
          if (colon >= MIN_USER_BEFORE_COLON) needles.add(info.slice(0, colon));
          if (colon < info.length - 1) needles.add(info.slice(colon + 1));
        }
      }
    }
  }
  // Longest first, so a full value is replaced before any piece of it.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of ordered) out = out.split(needle).join(REDACTED);
  return out.replace(SCHEME_USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`);
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, () => " ");
}

export async function runDoctor(
  checks: readonly DoctorCheck[],
  opts: { env: NodeJS.ProcessEnv; out: (line: string) => void },
): Promise<0 | 1> {
  const byId = new Map<CheckId, DoctorCheck>();
  for (const check of checks) {
    if (byId.has(check.id)) throw new Error(`doctor: duplicate check ${check.id}`);
    byId.set(check.id, check);
  }
  const missing = CHECK_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0 || byId.size !== CHECK_IDS.length) {
    throw new Error(`doctor: expected one check per id, missing: ${missing.join(", ")}`);
  }

  const skipPublic = (opts.env.PUBLIC_BASE_URL ?? "").trim() === "";
  let failed = 0;
  let passed = 0;
  let skipped = 0;

  for (const id of CHECK_IDS) {
    if (skipPublic && PUBLIC_CHECK_IDS.includes(id)) {
      skipped += 1;
      opts.out(`skip  ${id} (${SKIP_NOTE})`);
      continue;
    }
    let outcome: CheckOutcome;
    try {
      const result: unknown = await (byId.get(id) as DoctorCheck).run();
      const shape = result as { status?: unknown; fix?: unknown } | null | undefined;
      if (shape?.status === "pass") {
        outcome = { status: "pass" };
      } else if (
        shape?.status === "fail" &&
        typeof shape.fix === "string" &&
        shape.fix.trim() !== ""
      ) {
        outcome = { status: "fail", fix: shape.fix };
      } else {
        outcome = { status: "fail", fix: UNEXPECTED_FIX };
      }
    } catch {
      outcome = { status: "fail", fix: UNEXPECTED_FIX };
    }
    if (outcome.status === "pass") {
      passed += 1;
      opts.out(`pass  ${id}`);
    } else {
      failed += 1;
      opts.out(`fail  ${id}`);
      opts.out(`      fix: ${oneLine(redactSecrets(outcome.fix, opts.env))}`);
    }
  }

  opts.out(`doctor: ${failed} failed, ${passed} passed, ${skipped} skipped`);
  return failed > 0 ? 1 : 0;
}

/** The variable names `loadEnv` checks; only these may appear in an `env` fix line. */
export const ENV_NAMES: readonly string[] = [
  "VAULT_DIR",
  "VAULT_REMOTE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "INGEST_TOKEN",
  "PORT",
  "HOST",
  "PUBLIC_BASE_URL",
  "OWNER_PASSPHRASE_HASH",
  "MCP_PORT",
  "AUTH_STORE_DIR",
  "TRUST_PROXY_HOPS",
  "ALLOWED_REDIRECT_HOSTS",
];

export interface LocalCheckDeps {
  env: NodeJS.ProcessEnv;
  projectDir: string;
  /** Defaults to `<projectDir>/secrets`. */
  secretsDir?: string;
  stat?: (p: string) => Promise<{ mode: number; isFile(): boolean }>;
  lookup?: (host: string) => Promise<unknown>;
  platform?: NodeJS.Platform;
}

const NO_ENV_FILE_FIX = "no .env in the project directory: run docker compose run --rm setup";
const PASS: CheckOutcome = { status: "pass" };
const NAME_PATTERN = /(?:^Invalid environment: |; )([A-Z][A-Z0-9_]*)[.:]/g;
const SECRET_FILES = ["deploy_key", "known_hosts"] as const;

function failWith(fix: string): CheckOutcome {
  return { status: "fail", fix };
}

/** The `env`, `env_file`, `secrets` and `network` checks. Fix lines never hold values. */
export function createLocalChecks(deps: LocalCheckDeps): DoctorCheck[] {
  const stat = deps.stat ?? ((p: string) => lstat(p));
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host));
  const platform = deps.platform ?? process.platform;
  const secretsDir = deps.secretsDir ?? path.join(deps.projectDir, "secrets");

  const wide = (mode: number) => platform !== "win32" && (mode & 0o077) !== 0;

  const env: DoctorCheck = {
    id: "env",
    async run() {
      try {
        loadEnv(deps.env);
        return PASS;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const names: string[] = [];
        for (const match of message.matchAll(NAME_PATTERN)) {
          const name = match[1] as string;
          if (ENV_NAMES.includes(name) && !names.includes(name)) names.push(name);
        }
        return failWith(
          names.length > 0
            ? `fix these variables in .env: ${names.join(", ")}; then re-run setup`
            : "the environment is invalid; re-run setup",
        );
      }
    },
  };

  const envFile: DoctorCheck = {
    id: "env_file",
    async run() {
      let info: { mode: number; isFile(): boolean };
      try {
        info = await stat(path.join(deps.projectDir, ".env"));
      } catch {
        return failWith(NO_ENV_FILE_FIX);
      }
      if (!info.isFile()) {
        return failWith(NO_ENV_FILE_FIX);
      }
      return wide(info.mode) ? failWith("chmod 600 .env") : PASS;
    },
  };

  const secrets: DoctorCheck = {
    id: "secrets",
    async run() {
      let tooWide = false;
      for (const name of SECRET_FILES) {
        let info: { mode: number; isFile(): boolean } | undefined;
        try {
          info = await stat(path.join(secretsDir, name));
        } catch {
          info = undefined;
        }
        if (info === undefined || !info.isFile()) {
          return failWith(`secrets/${name} is missing: re-run setup`);
        }
        if (wide(info.mode)) tooWide = true;
      }
      return tooWide ? failWith("chmod 600 secrets/deploy_key secrets/known_hosts") : PASS;
    },
  };

  const network: DoctorCheck = {
    id: "network",
    async run() {
      try {
        await lookup("brain");
        return PASS;
      } catch {
        const raw = deps.env.N8N_NETWORK;
        let net = "n8n";
        if (raw !== undefined && raw.trim() !== "") {
          net = validateNetworkName(raw).ok ? raw : "<N8N_NETWORK>";
        }
        return failWith(
          `the brain service is not on the Docker network: docker network create ${net}, then docker compose up -d`,
        );
      }
    },
  };

  return [env, envFile, secrets, network];
}
