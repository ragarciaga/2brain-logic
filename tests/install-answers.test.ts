import { describe, expect, it } from "vitest";
import {
  type AnswerField,
  type AnswerResult,
  isEnvWritableName,
  parseSshRemote,
  renderAnswerError,
  validateAuthorEmail,
  validateAuthorName,
  validateHopCount,
  validateNetworkName,
  validatePassphrase,
  validatePublicBaseUrl,
} from "../src/install/answers.js";

/** True when the message contains the value or any substring of 4 or more characters of it. */
function leaks(message: string, value: string): boolean {
  if (value.length < 4) {
    return value !== "" && message.includes(value);
  }
  for (let i = 0; i + 4 <= value.length; i++) {
    for (let j = i + 4; j <= value.length; j++) {
      if (message.includes(value.slice(i, j))) {
        return true;
      }
    }
  }
  return false;
}

function failure<T>(result: AnswerResult<T>) {
  if (result.ok) {
    throw new Error("expected a failure");
  }
  return result.error;
}

describe("message omits the value", () => {
  const cases: Array<[AnswerField, string, () => AnswerResult<unknown>]> = [
    ["author email", "zqxj@@kkvv", () => validateAuthorEmail("zqxj@@kkvv")],
    [
      "public base URL",
      "ftp://wqzx.example.net/vvkk",
      () => validatePublicBaseUrl("ftp://wqzx.example.net/vvkk"),
    ],
    ["proxy hop count", "9876543210123", () => validateHopCount("9876543210123")],
    ["Docker network name", "-qzvx kkjj", () => validateNetworkName("-qzvx kkjj")],
    ["passphrase", "zqxjkkv", () => validatePassphrase("zqxjkkv", "zqxjkkv")],
    ["passphrase repeat", "zqxjkkvwwpp1", () => validatePassphrase("zqxjkkvwwpp1", "zqxjkkvwwpp2")],
    ["author name", "zqxj\nkkvv", () => validateAuthorName("zqxj\nkkvv")],
    ["author name", "", () => validateAuthorName("")],
  ];
  for (const [field, value, run] of cases) {
    it(`${field}: ${JSON.stringify(value).slice(0, 12)}`, () => {
      const error = failure(run());
      expect(error.field).toBe(field);
      expect(error.rule.length).toBeGreaterThan(0);
      expect(leaks(renderAnswerError(error), value)).toBe(false);
      expect(leaks(JSON.stringify(error), value)).toBe(false);
      expect(renderAnswerError(error)).toBe(`${field}: ${error.rule}`);
    });
  }

  it("the leak helper catches a 4-character echo", () => {
    expect(leaks("bad: abcd", "xabcdx")).toBe(true);
    expect(leaks("bad: abc", "xabcx")).toBe(false);
  });
});

describe("validateAuthorEmail", () => {
  it("accepts an email", () => {
    expect(validateAuthorEmail("ana@example.com")).toEqual({ ok: true, value: "ana@example.com" });
  });
});

describe("validateAuthorName", () => {
  it("accepts a name and rejects control characters", () => {
    expect(validateAuthorName("Ana Perez")).toEqual({ ok: true, value: "Ana Perez" });
    for (const bad of ["a\rb", "a\nb", "a\u0000b", "a\u007fb", "a\u0085b"]) {
      expect(validateAuthorName(bad).ok).toBe(false);
    }
  });
});

describe("validateHopCount", () => {
  it("accepts 0 and 10", () => {
    expect(validateHopCount("0")).toEqual({ ok: true, value: 0 });
    expect(validateHopCount("10")).toEqual({ ok: true, value: 10 });
  });
  it("rejects everything else", () => {
    for (const bad of ["11", "-1", "1.5", "1e1", "0x1", "", " 1"]) {
      expect(failure(validateHopCount(bad)).field).toBe("proxy hop count");
    }
  });
});

describe("validateNetworkName", () => {
  it("accepts valid names", () => {
    expect(validateNetworkName("n8n").ok).toBe(true);
    expect(validateNetworkName("my_net.1").ok).toBe(true);
  });
  it("rejects invalid names", () => {
    for (const bad of ["-n8n", "_x", "a b", ""]) {
      expect(validateNetworkName(bad).ok).toBe(false);
    }
  });
});

describe("validatePublicBaseUrl", () => {
  it("empty means MCP off", () => {
    expect(validatePublicBaseUrl("")).toEqual({ ok: true, value: "" });
  });
  it("returns the origin without a trailing slash", () => {
    expect(validatePublicBaseUrl("https://brain.example.com/")).toEqual({
      ok: true,
      value: "https://brain.example.com",
    });
  });
  it("rejects http, a path, userinfo and loopback http", () => {
    for (const bad of [
      "http://brain.example.com",
      "https://brain.example.com/mcp",
      "https://user@brain.example.com",
      "http://localhost:3001",
      "not a url",
    ]) {
      expect(failure(validatePublicBaseUrl(bad)).field).toBe("public base URL");
    }
  });
});

describe("validatePassphrase", () => {
  it("rejects 11 characters on the passphrase field", () => {
    expect(failure(validatePassphrase("a".repeat(11), "a".repeat(11))).field).toBe("passphrase");
  });
  it("accepts 12 equal characters", () => {
    expect(validatePassphrase("a".repeat(12), "a".repeat(12))).toEqual({
      ok: true,
      value: "a".repeat(12),
    });
  });
  it("rejects differing entries on the repeat field", () => {
    expect(failure(validatePassphrase("a".repeat(12), `${"a".repeat(11)}b`)).field).toBe(
      "passphrase repeat",
    );
  });
});

describe("validateAuthorName extra rules", () => {
  it("refuses a whitespace-only name", () => {
    for (const bad of [" ", "   ", "\u00a0", "\u3000"]) {
      const error = failure(validateAuthorName(bad));
      expect(error).toEqual({ field: "author name", rule: "must not be empty" });
    }
  });
  it("refuses bidi and zero-width characters", () => {
    for (const bad of [
      "a\u202eb",
      "a\u202ab",
      "a\u2066b",
      "a\u2069b",
      "a\u061cb",
      "a\u200bb",
      "a\u200fb",
      "a\ufeffb",
    ]) {
      const error = failure(validateAuthorName(bad));
      expect(error.field).toBe("author name");
      expect(error.rule).toBe("must not contain direction-control or zero-width characters");
    }
    expect(validateAuthorName("Ana Pérez").ok).toBe(true);
  });
});

describe("isEnvWritableName", () => {
  it("accepts plain names and each quote form", () => {
    for (const ok of ["Ana Perez", "O'Brien", 'Ana "Nick" Perez', "Ana $Perez", "dom\\ana"]) {
      expect(isEnvWritableName(ok)).toBe(true);
      expect(validateAuthorName(ok).ok).toBe(true);
    }
  });
  it("refuses a name that fits no .env form", () => {
    for (const bad of [
      "O'Brien $x",
      `O'Brien "x"`,
      "O'Brien\\x",
      "Ana Perez\\",
      "a b\\c",
      "a\nb",
      "a\rb",
    ]) {
      expect(isEnvWritableName(bad)).toBe(false);
      const error = failure(validateAuthorName(bad));
      expect(error.field).toBe("author name");
      expect(leaks(renderAnswerError(error), bad)).toBe(false);
    }
  });
});

describe("parseSshRemote", () => {
  it("accepts the scp form", () => {
    expect(parseSshRemote("git@github.com:owner/vault.git")).toEqual({
      ok: true,
      remote: { user: "git", host: "github.com", port: 22, path: "owner/vault.git" },
    });
  });
  it("accepts the ssh form with a port and lowercases the host", () => {
    expect(parseSshRemote("ssh://git@Git.Example.com:2222/owner/vault.git")).toEqual({
      ok: true,
      remote: { user: "git", host: "git.example.com", port: 2222, path: "owner/vault.git" },
    });
    const noPort = parseSshRemote("ssh://git@host/x.git");
    expect(noPort.ok && noPort.remote.port).toBe(22);
  });
  const refusal = { ok: false, code: "remote_not_ssh" };
  it("refuses https remotes", () => {
    expect(parseSshRemote("https://github.com/owner/vault.git")).toEqual(refusal);
    expect(parseSshRemote("https://user:tok@github.com/x.git")).toEqual(refusal);
  });
  it("refuses a credential in an ssh url", () => {
    expect(parseSshRemote("ssh://user:secret@host/x.git")).toEqual(refusal);
    expect(parseSshRemote("user:tok@host:x.git")).toEqual(refusal);
  });
  it("refuses everything else with the same object", () => {
    for (const bad of [
      "file:///tmp/x",
      "/srv/vault.git",
      "",
      "ssh://git@host:0/x",
      "ssh://git@host:70000/x",
      "ssh://-oProxyCommand=x@host/x",
      "git@-oProxy:x",
      "-oProxy@host:x",
      "git@host:-x",
      "git@host:/abs",
      "git@host:a b",
      "host:path",
      "git@[::1]:x",
      "ssh://git@[::1]/x",
      "ssh://git@host:+22/x",
    ]) {
      expect(parseSshRemote(bad)).toEqual(refusal);
    }
  });
  it("refuses control, bidi and zero-width characters anywhere", () => {
    for (const bad of [
      "ssh://git@host/x\u0001y",
      "git@host:x\u0085y",
      "git@host:x\u202ey",
      "ssh://git@host/x\u200by",
      "git@host:x\u2066y",
      "git@host:x\ufeffy",
      "git@host:caf\u00e9",
    ]) {
      expect(parseSshRemote(bad)).toEqual(refusal);
    }
  });
  it("never echoes the input", () => {
    expect(JSON.stringify(parseSshRemote("https://user:tok-zqxjkkvv@host/x"))).not.toContain(
      "zqxj",
    );
  });
});
