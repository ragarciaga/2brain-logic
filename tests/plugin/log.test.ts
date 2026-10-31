import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLog } from "../../plugin/scripts/lib/log.mjs";

const NOW = Date.parse("2026-10-31T21:04:05.123Z");
const ID = "1a2b3c4d-0000-4000-8000-000000000000";

let dir: string;
let log: ReturnType<typeof createLog>["log"];
const file = () => join(dir, "logs", "capture.log");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-test-"));
  log = createLog({ dataDir: dir, now: () => NOW }).log;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createLog", () => {
  it("writes the design example line", () => {
    log(ID, "saved", {
      notes: ["work/sessions/2026-10-31 api 1a2b3c4d.md"],
      recipes: 1,
    });
    expect(readFileSync(file(), "utf8")).toBe(
      "2026-10-31T21:04:05.123Z 1a2b3c4d saved notes=work/sessions/2026-10-31 api 1a2b3c4d.md recipes=1\n",
    );
  });

  it("writes exit only", () => {
    log(ID, "headless_failed", { exit: 1 });
    expect(readFileSync(file(), "utf8")).toBe(
      "2026-10-31T21:04:05.123Z 1a2b3c4d headless_failed exit=1\n",
    );
  });

  it("writes no fields", () => {
    log(ID, "gave_up");
    expect(readFileSync(file(), "utf8")).toBe("2026-10-31T21:04:05.123Z 1a2b3c4d gave_up\n");
  });

  it("uses a dash when the session id is invalid", () => {
    log("../etc/passwd", "invalid_input");
    log(undefined, "invalid_input");
    expect(readFileSync(file(), "utf8")).toBe(
      "2026-10-31T21:04:05.123Z - invalid_input\n2026-10-31T21:04:05.123Z - invalid_input\n",
    );
  });

  it.each(["Saved", "a-b", ""])("rejects the code %j", (code) => {
    expect(() => log(ID, code)).toThrow(TypeError);
    expect(existsSync(file())).toBe(false);
  });

  it("never writes fields outside the allowlist", () => {
    log(ID, "saved", {
      transcript: "SECRET-TRANSCRIPT-TEXT",
      prompt: "SECRET-PROMPT",
      env: "SECRET-ENV-VALUE",
      token: "SECRET-TOKEN",
      exit: "SECRET-WRONG-TYPE",
      recipes: -1,
      notes: "SECRET-NOT-AN-ARRAY",
    });
    const text = readFileSync(file(), "utf8");
    expect(text).not.toContain("SECRET");
    expect(text).toBe("2026-10-31T21:04:05.123Z 1a2b3c4d saved\n");
  });

  it("keeps a note with control characters on one line", () => {
    log(ID, "saved", { notes: ["a\nb\r\nc", "d"] });
    const text = readFileSync(file(), "utf8");
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("notes=a b  c,d\n");
  });

  it("rotates a file of exactly 1048576 bytes and replaces the old .1", () => {
    mkdirSync(join(dir, "logs"));
    writeFileSync(file(), "x".repeat(1048576));
    writeFileSync(`${file()}.1`, "older");
    log(ID, "saved");
    expect(readFileSync(file(), "utf8")).toBe("2026-10-31T21:04:05.123Z 1a2b3c4d saved\n");
    expect(readFileSync(`${file()}.1`, "utf8")).toBe("x".repeat(1048576));
  });

  it("does not rotate a file of 1048575 bytes", () => {
    mkdirSync(join(dir, "logs"));
    writeFileSync(file(), "x".repeat(1048575));
    log(ID, "saved");
    expect(existsSync(`${file()}.1`)).toBe(false);
    expect(readFileSync(file(), "utf8").length).toBeGreaterThan(1048575);
  });
});
