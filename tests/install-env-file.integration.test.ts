import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EnvAnswers, type EnvFileIo, writeEnvFile } from "../src/install/env-file.js";

const posix = process.platform !== "win32";
const fixedToken = ["fictional-test-token", "0123456789", "abcdefghij"].join("-");
const answers: EnvAnswers = {
  vaultRemote: "git@example.com:you/vault.git",
  authorName: "Test Author",
  authorEmail: "author@example.com",
};
const makeToken = () => fixedToken;
const tempName = /^\.env\.tmp-[0-9a-f]{16}$/;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "env-file-"));
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

function codeError(code: string): Error {
  return Object.assign(new Error("fake"), { code });
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(".env.tmp-"));
}

describe("writeEnvFile", () => {
  it("writes through a 0600 temp file in the same directory and leaves no temp file", async () => {
    const seen: { name: string; mode: number }[] = [];
    const io: Partial<EnvFileIo> = {
      async rename(from, to) {
        seen.push({ name: from, mode: (await stat(from)).mode & 0o777 });
        await rename(from, to);
      },
    };
    const result = await writeEnvFile(dir, answers, { makeToken, io });
    expect(result).toEqual({ ok: true, changed: true });
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0]?.name as string)).toBe(dir);
    expect(path.basename(seen[0]?.name as string)).toMatch(tempName);
    if (posix) expect(seen[0]?.mode).toBe(0o600);
    if (posix) expect((await stat(path.join(dir, ".env"))).mode & 0o777).toBe(0o600);
    expect(await leftovers()).toEqual([]);
    expect(await readFile(path.join(dir, ".env"), "utf8")).toContain(`INGEST_TOKEN=${fixedToken}`);
  });

  it.runIf(posix)("chmods the temp file after the open, whatever the umask", async () => {
    const old = process.umask(0o277);
    try {
      const modes: number[] = [];
      await writeEnvFile(dir, answers, {
        makeToken,
        io: {
          async rename(from, to) {
            modes.push((await stat(from)).mode & 0o777);
            await rename(from, to);
          },
        },
      });
      expect(modes).toEqual([0o600]);
    } finally {
      process.umask(old);
    }
  });

  it.runIf(posix)("turns an existing 0644 file into 0600", async () => {
    const file = path.join(dir, ".env");
    await writeFile(file, "FOO=bar\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await writeEnvFile(dir, answers, { makeToken });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("FOO=bar\n");
    expect(await leftovers()).toEqual([]);
  });

  it("keeps the old file and removes the temp file when the rename fails", async () => {
    const file = path.join(dir, ".env");
    await writeFile(file, "FOO=bar\n");
    const result = await writeEnvFile(dir, answers, {
      makeToken,
      io: {
        async rename() {
          throw codeError("EPERM");
        },
      },
    });
    expect(result).toEqual({ ok: false, code: "project_not_writable" });
    expect(await readFile(file, "utf8")).toBe("FOO=bar\n");
    expect(await leftovers()).toEqual([]);
  });

  it("rethrows other errors after removing the temp file", async () => {
    await expect(
      writeEnvFile(dir, answers, {
        makeToken,
        io: {
          async rename() {
            throw codeError("EIO");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(await leftovers()).toEqual([]);
    await expect(readFile(path.join(dir, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not touch the file, its mtime or the disk on a byte-identical re-run", async () => {
    const file = path.join(dir, ".env");
    await writeEnvFile(dir, answers, { makeToken });
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(file, old, old);
    const before = await readFile(file, "utf8");
    const writeTemp = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const result = await writeEnvFile(dir, answers, { makeToken, io: { writeTemp, rename } });
    expect(result).toEqual({ ok: true, changed: false });
    expect(writeTemp).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(old.getTime());
    expect(await leftovers()).toEqual([]);
  });

  it("returns project_not_writable when the temp file cannot be created", async () => {
    const result = await writeEnvFile(dir, answers, {
      makeToken,
      io: {
        async writeTemp() {
          throw codeError("EACCES");
        },
      },
    });
    expect(result).toEqual({ ok: false, code: "project_not_writable" });
    expect(await readdir(dir)).toEqual([]);
  });

  it.runIf(posix && process.getuid?.() !== 0)(
    "returns project_not_writable for a read-only directory",
    async () => {
      const ro = path.join(dir, "ro");
      await mkdir(ro);
      await chmod(ro, 0o555);
      const result = await writeEnvFile(ro, answers, { makeToken });
      expect(result).toEqual({ ok: false, code: "project_not_writable" });
      expect(await readdir(ro)).toEqual([]);
      await chmod(ro, 0o755);
    },
  );
});
