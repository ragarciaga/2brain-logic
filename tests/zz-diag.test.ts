import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { logChangedPaths } from "../src/git/index.js";

it("diag: raw git log layout on this runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-"));
  const g = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env } });
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.md"), "a\n");
  g(["add", "a.md"]);
  const d = new Date(Date.now() - 2 * 86_400_000).toISOString();
  g(["-c", "user.name=a", "-c", "user.email=a@example.com", "commit", "-qm", "x"], {
    GIT_COMMITTER_DATE: d,
    GIT_AUTHOR_DATE: d,
  });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out: string[] = [];
  out.push("V " + g(["--version"]).toString());
  out.push(
    "R " +
      JSON.stringify(
        g([
          "log",
          "-z",
          "--name-only",
          "--no-renames",
          "--format=%x1eMK%cI",
          `--since=${since}`,
          "HEAD",
        ]).toString("latin1"),
      ),
  );
  out.push(
    "N " +
      JSON.stringify(
        g(["log", "-z", "--name-only", "--no-renames", "--format=%x1eMK%cI", "HEAD"]).toString(
          "latin1",
        ),
      ),
  );
  out.push(
    "P " + JSON.stringify(await logChangedPaths(dir, new Date(Date.now() - 7 * 86_400_000))),
  );
  throw new Error(`DIAG ${out.join(" | ").replace(/\n/g, "\\n")}`);
});
