import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, main, TEMPLATE_DIR } from "../src/cli.js";

/** Every regular file under root: POSIX relative path to its bytes (hex). */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join("/")] = readFileSync(full).toString("hex");
    }
  };
  walk(root);
  return out;
}

function fakeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

const TEMPLATE_FILES = Object.keys(tree(TEMPLATE_DIR)).sort();
const CONFIG = ".2brain/config.yaml";
const INBOX_README = "inbox/README.md";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "init-vault-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("TEMPLATE_DIR", () => {
  it("is the vault-template folder at the repository root", () => {
    expect(TEMPLATE_DIR).toBe(join(import.meta.dirname, "..", "vault-template"));
    expect(existsSync(join(TEMPLATE_DIR, CONFIG))).toBe(true);
  });
});

describe("init-vault on a new vault", () => {
  it("copies the whole template into a missing directory", async () => {
    const target = join(root, "vault", "nested");
    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(TEMPLATE_FILES).toContain(CONFIG);
    expect(out).toStrictEqual([
      ...TEMPLATE_FILES.map((f) => `copied ${f}`),
      `init-vault: ${TEMPLATE_FILES.length} copied, 0 skipped into ${target}`,
    ]);
    expect(err).toStrictEqual([]);
  });

  it("copies the whole template into an empty directory", async () => {
    const target = join(root, "empty");
    mkdirSync(target);
    const { io, out } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(out.at(-1)).toBe(
      `init-vault: ${TEMPLATE_FILES.length} copied, 0 skipped into ${target}`,
    );
  });
});

describe("init-vault listing", () => {
  it("lists a custom template in sorted POSIX order, nested paths included", async () => {
    const template = join(root, "template");
    mkdirSync(join(template, "b"), { recursive: true });
    for (const file of ["z.txt", "b/x.md", "b.txt", "a.txt"])
      writeFileSync(join(template, file), file);
    const target = join(root, "vault");
    const { io, out } = fakeIo();
    expect(await main(["init-vault", target], io, { templateDir: template })).toBe(0);
    expect(out).toStrictEqual([
      "copied a.txt",
      "copied b.txt",
      "copied b/x.md",
      "copied z.txt",
      `init-vault: 4 copied, 0 skipped into ${target}`,
    ]);
    expect(readFileSync(join(target, "b", "x.md"), "utf8")).toBe("b/x.md");
  });
});

describe("init-vault on a partial vault", () => {
  it("copies only the missing files, keeps existing bytes and lists the skipped ones", async () => {
    const target = join(root, "partial");
    mkdirSync(join(target, ".2brain"), { recursive: true });
    mkdirSync(join(target, "inbox"));
    writeFileSync(join(target, CONFIG), "my: config\n");
    writeFileSync(join(target, INBOX_README), "my inbox\n");
    writeFileSync(join(target, "extra.txt"), "not in the template\n");
    const before = tree(target);

    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);

    const after = tree(target);
    for (const [file, bytes] of Object.entries(before)) expect(after[file], file).toBe(bytes);
    const missing = TEMPLATE_FILES.filter((f) => f !== CONFIG && f !== INBOX_README);
    for (const file of missing) expect(after[file], file).toBe(tree(TEMPLATE_DIR)[file]);
    expect(Object.keys(after).sort()).toStrictEqual([...TEMPLATE_FILES, "extra.txt"].sort());

    expect(out).toContain(`skipped ${CONFIG} (exists)`);
    expect(out).toContain(`skipped ${INBOX_README} (exists)`);
    expect(out.filter((l) => l.startsWith("copied "))).toStrictEqual(
      missing.map((f) => `copied ${f}`),
    );
    expect(out.join("\n")).not.toContain("extra.txt");
    expect(out.at(-1)).toBe(`init-vault: ${missing.length} copied, 2 skipped into ${target}`);
    expect(err).toStrictEqual([]);
  });

  it("copies nothing on a second run and leaves every byte unchanged", async () => {
    const target = join(root, "twice");
    expect(await main(["init-vault", target], fakeIo().io)).toBe(0);
    const before = tree(target);

    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(0);
    expect(tree(target)).toStrictEqual(before);
    expect(out).toStrictEqual([
      ...TEMPLATE_FILES.map((f) => `skipped ${f} (exists)`),
      `init-vault: 0 copied, ${TEMPLATE_FILES.length} skipped into ${target}`,
    ]);
    expect(err).toStrictEqual([]);
  });
});

describe("init-vault failures", () => {
  it("returns 1 for a file target, names the path and changes nothing", async () => {
    const target = join(root, "afile");
    writeFileSync(target, "plain file\n");
    const { io, out, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(1);
    expect(err.join("\n")).toContain(`target is not a directory: ${target}`);
    expect(out).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual(["afile"]);
    expect(readFileSync(target, "utf8")).toBe("plain file\n");
  });

  it("returns 1 for a missing template without creating the target", async () => {
    const target = join(root, "vault");
    const { io, out, err } = fakeIo();
    const code = await main(["init-vault", target], io, {
      templateDir: join(root, "no-such-template"),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("template not found");
    expect(out).toStrictEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("returns 1 for a template that is a file without creating the target", async () => {
    const template = join(root, "template-file");
    writeFileSync(template, "x");
    const target = join(root, "vault");
    const { io, err } = fakeIo();
    expect(await main(["init-vault", target], io, { templateDir: template })).toBe(1);
    expect(err.join("\n")).toContain("template not found");
    expect(existsSync(target)).toBe(false);
  });

  it("returns 1 with an error code, not a stack, when a template path is blocked by a file", async () => {
    const target = join(root, "blocked");
    mkdirSync(target);
    writeFileSync(join(target, "inbox"), "a file where a folder belongs\n");
    const { io, err } = fakeIo();
    expect(await main(["init-vault", target], io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^init-vault: [A-Z]+ /);
    expect(err[0]).toContain("inbox");
    expect(readFileSync(join(target, "inbox"), "utf8")).toBe("a file where a folder belongs\n");
  });
});

describe("usage errors", () => {
  const cases: [string, string[]][] = [
    ["no arguments", []],
    ["an unknown command", ["frobnicate", "x"]],
    ["a missing directory argument", ["init-vault"]],
    ["an extra argument", ["init-vault", "a", "b"]],
    ["an empty directory argument", ["init-vault", ""]],
  ];
  for (const [name, argv] of cases) {
    it(`returns 2 with usage and writes nothing for ${name}`, async () => {
      const before = readdirSync(process.cwd()).sort();
      const { io, out, err } = fakeIo();
      expect(await main(argv, io)).toBe(2);
      expect(err.join("\n")).toContain("usage: node dist/cli.js init-vault <dir>");
      expect(out).toStrictEqual([]);
      expect(readdirSync(process.cwd()).sort()).toStrictEqual(before);
    });
  }
});

describe("entry point", () => {
  const script = join(import.meta.dirname, "..", "src", "cli.ts");

  it("runs main with the process arguments and exits 0 on success", () => {
    const target = join(root, "spawned");
    const result = spawnSync(process.execPath, [script, "init-vault", target], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(tree(target)).toStrictEqual(tree(TEMPLATE_DIR));
    expect(result.stdout).toContain(`${TEMPLATE_FILES.length} copied, 0 skipped`);
  });

  it("sets a non-zero exit code on failure", () => {
    const target = join(root, "afile");
    writeFileSync(target, "x");
    const result = spawnSync(process.execPath, [script, "init-vault", target], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(target);
  });

  it("does not run anything when imported", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log("loaded")`,
      ],
      { encoding: "utf8" },
    );
    expect(result.stdout.trim()).toBe("loaded");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
