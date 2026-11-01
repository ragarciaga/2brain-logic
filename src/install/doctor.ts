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
       * (`INGEST_TOKEN`, `OWNER_PASSPHRASE_HASH`, `VAULT_REMOTE`), but nothing
       * else, so never put raw error text, response bodies or other
       * environment values in it.
       */
      fix: string;
    };

export interface DoctorCheck {
  id: CheckId;
  run(): Promise<CheckOutcome>;
}

/** The checks that need `PUBLIC_BASE_URL`; they are skipped while it is empty. */
export const PUBLIC_CHECK_IDS: readonly CheckId[] = ["mcp_internal", "proxy_metadata", "proxy_mcp"];

export const SKIP_NOTE = "PUBLIC_BASE_URL is empty: claude.ai cannot connect";

/** Printed when a check throws; the thrown error text is never printed. */
export const UNEXPECTED_FIX =
  "the check stopped unexpectedly; run doctor again, then see docs/INSTALL.md Troubleshooting";

const REDACTED = "<redacted>";
const SCHEME_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/gi;

function userinfoOf(url: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^@/\s]*)@/i.exec(url);
  return match?.[1] || undefined;
}

/** Replaces the known secrets, and any `scheme://userinfo@`, in `text`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
  const needles = new Set<string>();
  for (const key of ["INGEST_TOKEN", "OWNER_PASSPHRASE_HASH", "VAULT_REMOTE"] as const) {
    const value = env[key];
    if (!value) continue;
    needles.add(value);
    if (key === "VAULT_REMOTE") {
      const info = userinfoOf(value);
      if (info) {
        needles.add(info);
        const colon = info.indexOf(":");
        if (colon > 0) needles.add(info.slice(0, colon));
        if (colon >= 0 && colon < info.length - 1) needles.add(info.slice(colon + 1));
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

  const skipPublic = opts.env.PUBLIC_BASE_URL === undefined || opts.env.PUBLIC_BASE_URL === "";
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
      outcome = await (byId.get(id) as DoctorCheck).run();
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
