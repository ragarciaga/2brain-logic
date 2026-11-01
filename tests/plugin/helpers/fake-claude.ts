import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE = join(process.cwd(), "tests", "plugin", "fixtures", "fake-claude.mjs");

export interface FakeScript {
  result?: unknown;
  exit?: number;
  stdout?: string;
  sleepMs?: number;
  hang?: boolean;
  skipStdin?: boolean;
  spawnGrandchild?: boolean;
}

export interface FakeRun {
  argv: string[];
  env: Record<string, string>;
  pid: number;
  grandchildPid: number | null;
  stdin: string | null;
  start: number;
  end: number | null;
}

export interface FakeSetup {
  /** The only PATH entry: holds the executable `claude`. */
  binDir: string;
  /** Env for the child: PATH limited to `binDir` plus the fake's two variables. */
  env: Record<string, string>;
  runs(): FakeRun[];
}

/** Installs the fake `claude` in a fresh temp dir and returns an env that reaches only it. */
export function installFakeClaude(script: FakeScript): FakeSetup {
  const root = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const binDir = join(root, "bin");
  const records = join(root, "records");
  mkdirSync(binDir);
  mkdirSync(records);
  const scriptFile = join(root, "script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  const exe = join(binDir, "claude");
  writeFileSync(
    exe,
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`,
  );
  chmodSync(exe, 0o755);
  return {
    binDir,
    env: { PATH: binDir, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_RECORD: records },
    runs: () =>
      readdirSync(records)
        .filter((f) => f.startsWith("run-"))
        .map((f) => JSON.parse(readFileSync(join(records, f), "utf8")) as FakeRun),
  };
}
