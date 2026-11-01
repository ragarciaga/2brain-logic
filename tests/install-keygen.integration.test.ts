import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDeployKey, execFileRunner } from "../src/install/ssh.js";

const hasKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe.skipIf(!hasKeygen || process.platform === "win32")(
  "ensureDeployKey with ssh-keygen",
  () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "keygen-int-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("generates a usable ed25519 key and keeps it on the second call", async () => {
      expect(await ensureDeployKey(dir, execFileRunner)).toEqual({ ok: true, created: true });
      const key = join(dir, "secrets", "deploy_key");
      const pub = join(dir, "secrets", "deploy_key.pub");
      expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(statSync(pub).mode & 0o777).toBe(0o644);
      expect(readFileSync(pub, "utf8")).toMatch(/^ssh-ed25519 \S+ 2brain deploy key\n?$/);
      expect(spawnSync("ssh-keygen", ["-y", "-P", "", "-f", key]).status).toBe(0);

      const before = readFileSync(key);
      expect(await ensureDeployKey(dir, execFileRunner)).toEqual({ ok: true, created: false });
      expect(readFileSync(key).equals(before)).toBe(true);
    });
  },
);
