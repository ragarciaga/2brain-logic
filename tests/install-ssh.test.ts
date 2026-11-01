import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fingerprintSha256,
  GITHUB_ED25519_FINGERPRINT,
  gitSshCommand,
  knownHostsLine,
  parseKeyscan,
  pinGithubHostKey,
} from "../src/install/ssh.js";

const root = resolve(import.meta.dirname, "..");
const githubScan = readFileSync(join(root, "tests/fixtures/ssh/keyscan-github.txt"), "utf8");
const otherScan = readFileSync(join(root, "tests/fixtures/ssh/keyscan-other.txt"), "utf8");
const githubKey = parseKeyscan(githubScan)[0] as string;
const otherKey = parseKeyscan(otherScan)[0] as string;
const OTHER_FINGERPRINT = "SHA256:bDMUpweNPl+hOqU4AGZf/z5+8DYODm3qVd80rpVtei4";
const github = { host: "github.com", port: 22 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fingerprintSha256", () => {
  it("fingerprint matches published", () => {
    expect(githubScan).toContain(`ssh-keygen -lf value: 256 ${GITHUB_ED25519_FINGERPRINT}`);
    expect(fingerprintSha256(githubKey)).toBe(GITHUB_ED25519_FINGERPRINT);
  });

  it("fingerprint of other key", () => {
    expect(otherScan).toContain(OTHER_FINGERPRINT);
    expect(fingerprintSha256(otherKey)).toBe(OTHER_FINGERPRINT);
    expect(fingerprintSha256(otherKey)).not.toBe(GITHUB_ED25519_FINGERPRINT);
  });

  it("rejects input that is not strict base64", () => {
    expect(() => fingerprintSha256("not base64!")).toThrow();
    expect(() => fingerprintSha256("AAAA=AAA")).toThrow();
    expect(() => fingerprintSha256("AAA")).toThrow();
    expect(() => fingerprintSha256("")).toThrow();
  });
});

describe("parseKeyscan", () => {
  it("skips comments, blanks and other key types", () => {
    const text = [
      "# github.com:22 SSH-2.0-x",
      "",
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAA",
      `github.com ssh-ed25519 ${githubKey}`,
      "   ",
    ].join("\n");
    expect(parseKeyscan(text)).toEqual([githubKey]);
    expect(parseKeyscan("# only a comment\n")).toEqual([]);
  });
});

describe("knownHostsLine", () => {
  it("port renders bracket", () => {
    expect(knownHostsLine({ host: "github.com", port: 2222 }, githubKey)).toBe(
      `[github.com]:2222 ssh-ed25519 ${githubKey}`,
    );
    expect(knownHostsLine(github, githubKey)).toBe(`github.com ssh-ed25519 ${githubKey}`);
  });
});

describe("pinGithubHostKey", () => {
  it("github match pins", () => {
    const file = join(dir, "known_hosts");
    const result = pinGithubHostKey(dir, github, githubScan);
    expect(result).toEqual({ ok: true, line: `github.com ssh-ed25519 ${githubKey}` });
    expect(readFileSync(file, "utf8")).toBe(`github.com ssh-ed25519 ${githubKey}\n`);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces a pre-existing file with one line at 0600", () => {
    const file = join(dir, "known_hosts");
    writeFileSync(file, "old.example.com ssh-ed25519 AAAA\nother.example.com ssh-ed25519 BBBB\n");
    chmodSync(file, 0o644);
    pinGithubHostKey(dir, github, githubScan);
    expect(readFileSync(file, "utf8")).toBe(`github.com ssh-ed25519 ${githubKey}\n`);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("pins a non-default port with the bracket form", () => {
    pinGithubHostKey(dir, { host: "github.com", port: 2222 }, githubScan);
    expect(readFileSync(join(dir, "known_hosts"), "utf8")).toBe(
      `[github.com]:2222 ssh-ed25519 ${githubKey}\n`,
    );
  });

  it("github mismatch", () => {
    const result = pinGithubHostKey(dir, github, otherScan);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("host_key_mismatch");
    expect(result.message).toContain(OTHER_FINGERPRINT);
    expect(result.message).toContain(GITHUB_ED25519_FINGERPRINT);
    expect(existsSync(join(dir, "known_hosts"))).toBe(false);
  });

  it("a keyscan with no ed25519 line is a mismatch that saw none", () => {
    const result = pinGithubHostKey(
      dir,
      github,
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAA\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.message).toBe(
      `host_key_mismatch: seen none, expected ${GITHUB_ED25519_FINGERPRINT}`,
    );
    expect(existsSync(join(dir, "known_hosts"))).toBe(false);
  });

  it("pins when the matching key is not the first ed25519 line", () => {
    const result = pinGithubHostKey(dir, github, `${otherScan}${githubScan}`);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "known_hosts"), "utf8")).toBe(
      `github.com ssh-ed25519 ${githubKey}\n`,
    );
  });

  it.skipIf(process.platform === "win32")("does not write through a symlinked known_hosts", () => {
    const target = join(dir, "target");
    writeFileSync(target, "target-bytes");
    symlinkSync(target, join(dir, "known_hosts"));
    expect(() => pinGithubHostKey(dir, github, githubScan)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("target-bytes");
  });

  it("refuses a known_hosts that is a directory and leaves no temp file", () => {
    mkdirSync(join(dir, "known_hosts"));
    expect(() => pinGithubHostKey(dir, github, githubScan)).toThrow();
    expect(readdirSync(dir)).toEqual(["known_hosts"]);
  });

  it("leaves no temp file after a successful write", () => {
    pinGithubHostKey(dir, github, githubScan);
    expect(readdirSync(dir)).toEqual(["known_hosts"]);
  });

  it("refuses any other host", () => {
    expect(() =>
      pinGithubHostKey(dir, { host: "git.example.com", port: 22 }, githubScan),
    ).toThrow();
    expect(existsSync(join(dir, "known_hosts"))).toBe(false);
  });
});

describe("gitSshCommand", () => {
  const flags = [
    "-i /run/2brain/deploy_key",
    "IdentitiesOnly=yes",
    "UserKnownHostsFile=/run/2brain/known_hosts",
    "StrictHostKeyChecking=yes",
    "BatchMode=yes",
    "ConnectTimeout=10",
    "ServerAliveInterval=5",
    "ServerAliveCountMax=2",
  ];

  it("ssh command flags", () => {
    const cmd = gitSshCommand("/run/2brain");
    expect(cmd).toBe(
      "ssh -i /run/2brain/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/run/2brain/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
    );
    for (const flag of flags) {
      expect(cmd).toContain(flag);
    }
  });

  it("refuses a directory a shell would interpret", () => {
    for (const bad of ["/run/my dir", "/run/x;id", "/run/$(id)", "relative/dir", "", "/a`b`"]) {
      expect(() => gitSshCommand(bad)).toThrow();
    }
  });
});

describe("host key checking is never disabled", () => {
  const forbidden = [
    /StrictHostKeyChecking[\s=]+(no|off|accept-new)\b/i,
    /UserKnownHostsFile[\s=]+\/dev\/null/i,
  ];

  function walk(path: string, out: string[]): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full, out);
      } else {
        out.push(full);
      }
    }
  }

  it("no installer file, compose.yaml or INSTALL.md turns it off", () => {
    const files: string[] = [];
    walk(join(root, "src/install"), files);
    for (const extra of ["compose.yaml", "docs/INSTALL.md"]) {
      if (existsSync(join(root, extra))) {
        files.push(join(root, extra));
      }
    }
    expect(files).toContain(join(root, "src/install/ssh.ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(re.test(text), `${file} matches ${re}`).toBe(false);
      }
    }
  });

  it("the patterns match what they are meant to catch", () => {
    expect(forbidden[0]?.test("-o StrictHostKeyChecking=no")).toBe(true);
    expect(forbidden[0]?.test("stricthostkeychecking accept-new")).toBe(true);
    expect(forbidden[1]?.test("UserKnownHostsFile=/dev/null")).toBe(true);
    expect(forbidden[0]?.test("StrictHostKeyChecking=yes")).toBe(false);
  });
});
