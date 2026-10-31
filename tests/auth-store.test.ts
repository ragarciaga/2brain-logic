import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename as fsRename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_STORE_FILE,
  AUTH_STORE_LIMITS,
  type AuthStore,
  AuthStoreInvalidError,
  newId,
  type OpenAuthStoreOptions,
  openAuthStore,
  type StoreIo,
  type StoreTx,
  sha256Hex,
} from "../src/auth/oauth/store.js";

const POSIX = process.platform !== "win32";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const roots: string[] = [];
const stores: AuthStore[] = [];
const unmount: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const target of unmount.splice(0)) {
    try {
      execFileSync("umount", [target], { stdio: "ignore" });
    } catch {
      // not mounted
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  vault: string;
  auth: string;
  file: string;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "2brain-authstore-")));
  roots.push(root);
  const vault = join(root, "vault");
  mkdirSync(vault);
  const auth = join(root, "auth");
  return { root, vault, auth, file: join(auth, AUTH_STORE_FILE) };
}

let clockMs = Date.parse("2026-10-31T12:00:00.000Z");
const now = (): Date => new Date(clockMs);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function open(sb: Sandbox, extra: Partial<OpenAuthStoreOptions> = {}): Promise<AuthStore> {
  const store = await openAuthStore({
    dir: sb.auth,
    vaultDir: sb.vault,
    now,
    log: () => undefined,
    ...extra,
  });
  stores.push(store);
  return store;
}

interface Issued {
  clientId: string;
  secret: string;
  grantId: string;
  access: string;
  refresh: string;
}

function issue(): Issued {
  return {
    clientId: newId(),
    secret: newId(),
    grantId: newId(),
    access: newId(),
    refresh: newId(),
  };
}

/** Add a client with a secret and one grant for it. */
function addAll(tx: StoreTx, v: Issued, refreshMs = 30 * DAY): void {
  tx.putClient(v.clientId, {
    authMethod: "client_secret_post",
    secret: v.secret,
    redirectUris: ["https://claude.ai/callback"],
    name: "Fictional client",
  });
  tx.putGrant(v.grantId, {
    clientId: v.clientId,
    resource: "https://brain.example.com/mcp",
    accessToken: v.access,
    accessExpiresAt: new Date(clockMs + HOUR),
    refreshToken: v.refresh,
    refreshExpiresAt: new Date(clockMs + refreshMs),
  });
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

async function expectOpenError(
  sb: Sandbox,
  expected: RegExp,
  forbidden: string[] = [],
): Promise<AuthStoreInvalidError> {
  let caught: unknown;
  try {
    await open(sb);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AuthStoreInvalidError);
  const error = caught as AuthStoreInvalidError;
  expect(error.message).toMatch(expected);
  expect(error.file).toBe("auth.json");
  expect(error.cause).toBeUndefined();
  for (const text of [sb.root, sb.auth, sb.vault, "STOREMARKER", ...forbidden]) {
    expect(error.message).not.toContain(text);
    expect(String(error.stack)).not.toContain(text);
  }
  return error;
}

describe("auth store: round trip and hashing (R5.5, D1)", () => {
  it("finds a client and a grant by id, access token and refresh token after a reopen", async () => {
    const sb = sandbox();
    const v = issue();
    const first = await open(sb);
    expect(await first.update((tx) => addAll(tx, v))).toEqual({ ok: true, value: undefined });
    first.close();

    const store = await open(sb);
    expect(store.clientCount()).toBe(1);
    expect(store.getClient(v.clientId)).toMatchObject({
      authMethod: "client_secret_post",
      redirectUris: ["https://claude.ai/callback"],
      name: "Fictional client",
      secretHash: sha256Hex(v.secret),
    });
    expect(store.getGrant(v.grantId)).toMatchObject({
      clientId: v.clientId,
      revoked: false,
      accessHash: sha256Hex(v.access),
      refreshHash: sha256Hex(v.refresh),
      usedRefreshHashes: [],
    });
    expect(store.findGrantByAccessToken(v.access)).toMatchObject({ id: v.grantId, state: "live" });
    expect(store.findGrantByRefreshToken(v.refresh)).toMatchObject({
      id: v.grantId,
      reused: false,
    });
    expect(store.findGrantByAccessToken(newId())).toBeUndefined();
    expect(store.findGrantByRefreshToken(newId())).toBeUndefined();
    expect(store.verifyClientSecret(v.clientId, v.secret)).toBe(true);
  });

  it("writes only hashes: no raw secret, token or id-less value, and every hash is there", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const text = readFileSync(sb.file, "utf8");
    for (const raw of [v.secret, v.access, v.refresh]) {
      expect(text).not.toContain(raw);
      expect(text).toContain(sha256Hex(raw));
    }
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).version).toBe(1);
  });

  it("verifyClientSecret is false for a wrong, empty or short secret, a public client and an unknown client", async () => {
    const sb = sandbox();
    const v = issue();
    const publicId = newId();
    const store = await open(sb);
    await store.update((tx) => {
      addAll(tx, v);
      tx.putClient(publicId, { authMethod: "none", redirectUris: [] });
    });
    expect(store.verifyClientSecret(v.clientId, v.secret)).toBe(true);
    expect(store.verifyClientSecret(v.clientId, newId())).toBe(false);
    expect(store.verifyClientSecret(v.clientId, "")).toBe(false);
    expect(store.verifyClientSecret(v.clientId, "short")).toBe(false);
    expect(store.verifyClientSecret(publicId, v.secret)).toBe(false);
    expect(store.verifyClientSecret(publicId, "")).toBe(false);
    expect(store.verifyClientSecret(newId(), v.secret)).toBe(false);
  });

  it("answers undefined for ids that name Object.prototype members", async () => {
    const store = await open(sandbox());
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(store.getClient(id)).toBeUndefined();
      expect(store.getGrant(id)).toBeUndefined();
    }
  });

  it("returns copies: changing a result does not change the store", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const client = store.getClient(v.clientId);
    client?.redirectUris.push("https://evil.example.com/");
    const grant = store.getGrant(v.grantId);
    if (grant) grant.revoked = true;
    expect(store.getClient(v.clientId)?.redirectUris).toEqual(["https://claude.ai/callback"]);
    expect(store.getGrant(v.grantId)?.revoked).toBe(false);
  });

  it("classifies an access token as live, expired or revoked", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const at = (ms: number) => store.findGrantByAccessToken(v.access, new Date(clockMs + ms));
    expect(at(HOUR - 1)?.state).toBe("live");
    expect(at(HOUR)?.state).toBe("expired");
    await store.update((tx) => tx.revokeGrant(v.grantId));
    expect(at(0)?.state).toBe("revoked");
    expect(at(2 * HOUR)?.state).toBe("revoked");
  });
});

describe("auth store: rotation, revocation and the transaction rules (S2, S4)", () => {
  function next() {
    return {
      accessToken: newId(),
      accessExpiresAt: new Date(clockMs + HOUR),
      refreshToken: newId(),
      refreshExpiresAt: new Date(clockMs + 30 * DAY),
    };
  }

  it("rotates, keeps the old refresh token as reused across a reopen and drops the old access token", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const n = next();
    const done = await store.update((tx) => tx.rotateGrant(v.grantId, v.refresh, n));
    expect(done).toEqual({ ok: true, value: { ok: true } });
    store.close();

    const again = await open(sb);
    expect(again.findGrantByRefreshToken(n.refreshToken)).toMatchObject({ reused: false });
    expect(again.findGrantByRefreshToken(v.refresh)).toMatchObject({
      id: v.grantId,
      reused: true,
    });
    expect(again.findGrantByAccessToken(v.access)).toBeUndefined();
    expect(again.findGrantByAccessToken(n.accessToken)?.state).toBe("live");
    const text = readFileSync(sb.file, "utf8");
    expect(text).not.toContain(n.refreshToken);
    expect(text).not.toContain(v.refresh);
    expect(text).toContain(sha256Hex(v.refresh));
  });

  it("rotateGrant fails typed and changes nothing: reused, invalid, revoked, expired, unknown grant", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const n1 = next();
    await store.update((tx) => tx.rotateGrant(v.grantId, v.refresh, n1));
    const before = readFileSync(sb.file, "utf8");
    const attempt = async (grantId: string, presented: string) => {
      const outcome = await store.update((tx) => tx.rotateGrant(grantId, presented, next()));
      return outcome.ok ? outcome.value : outcome;
    };
    expect(await attempt(v.grantId, v.refresh)).toEqual({ ok: false, reason: "reused" });
    expect(await attempt(v.grantId, newId())).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt(newId(), n1.refreshToken)).toEqual({ ok: false, reason: "invalid" });
    expect(readFileSync(sb.file, "utf8")).toBe(before);
    expect(store.findGrantByRefreshToken(n1.refreshToken)).toMatchObject({ reused: false });

    // Revoked: the current token of a revoked grant is refused and the file stays as it was.
    const w = issue();
    await store.update((tx) => addAll(tx, w));
    await store.update((tx) => tx.revokeGrant(w.grantId));
    const revokedBytes = readFileSync(sb.file, "utf8");
    expect(await attempt(w.grantId, w.refresh)).toEqual({ ok: false, reason: "invalid" });
    expect(readFileSync(sb.file, "utf8")).toBe(revokedBytes);
    expect(store.getGrant(w.grantId)?.refreshHash).toBe(sha256Hex(w.refresh));

    // Expired: the current token exactly at its expiry is refused (the update then prunes it).
    clockMs += 30 * DAY;
    expect(await attempt(v.grantId, n1.refreshToken)).toEqual({ ok: false, reason: "invalid" });
    clockMs -= 30 * DAY;
  });

  it("keeps the newest 64 rotated-out hashes and drops the oldest", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const refreshTokens = [v.refresh];
    await store.update((tx) => {
      for (let i = 0; i < 70; i++) {
        const n = next();
        const last = refreshTokens[refreshTokens.length - 1] as string;
        expect(tx.rotateGrant(v.grantId, last, n)).toEqual({ ok: true });
        refreshTokens.push(n.refreshToken);
      }
    });
    const grant = store.getGrant(v.grantId);
    expect(grant?.usedRefreshHashes).toHaveLength(64);
    expect(grant?.usedRefreshHashes).toEqual(
      refreshTokens.slice(6, 70).map((token) => sha256Hex(token)),
    );
    expect(store.findGrantByRefreshToken(refreshTokens[5] as string)).toBeUndefined();
    expect(store.findGrantByRefreshToken(refreshTokens[6] as string)?.reused).toBe(true);
  });

  it("revokeGrant marks the grant, clears its history and says whether it existed", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    await store.update((tx) => tx.rotateGrant(v.grantId, v.refresh, next()));
    expect(store.getGrant(v.grantId)?.usedRefreshHashes).toHaveLength(1);
    const outcome = await store.update((tx) => [
      tx.revokeGrant(v.grantId),
      tx.revokeGrant(newId()),
    ]);
    expect(outcome).toEqual({ ok: true, value: [true, false] });
    expect(store.getGrant(v.grantId)).toMatchObject({ revoked: true, usedRefreshHashes: [] });
    store.close();
    expect((await open(sb)).getGrant(v.grantId)).toMatchObject({ revoked: true });
  });

  it("putClient and putGrant are insert-only and check their input", async () => {
    const sb = sandbox();
    const v = issue();
    const store = await open(sb);
    await store.update((tx) => addAll(tx, v));
    const before = readFileSync(sb.file, "utf8");
    const marker = "RAWMARKER";
    await expect(
      store.update((tx) => tx.putClient(v.clientId, { authMethod: "none", redirectUris: [] })),
    ).rejects.toThrow("client already exists");
    await expect(
      store.update((tx) => addAll(tx, { ...issue(), clientId: v.clientId })),
    ).rejects.toThrow("client already exists");
    await expect(
      store.update((tx) =>
        tx.putGrant(v.grantId, {
          clientId: v.clientId,
          resource: "https://brain.example.com/mcp",
          accessToken: newId(),
          accessExpiresAt: new Date(clockMs + HOUR),
          refreshToken: newId(),
          refreshExpiresAt: new Date(clockMs + DAY),
        }),
      ),
    ).rejects.toThrow("grant already exists");
    await expect(
      store.update((tx) =>
        tx.putGrant(newId(), {
          clientId: newId(),
          resource: "https://brain.example.com/mcp",
          accessToken: newId(),
          accessExpiresAt: new Date(clockMs + HOUR),
          refreshToken: newId(),
          refreshExpiresAt: new Date(clockMs + DAY),
        }),
      ),
    ).rejects.toThrow("unknown client");
    // A raw value that is not 43 base64url characters is refused, and never echoed.
    for (const run of [
      (tx: StoreTx) => tx.putClient(marker, { authMethod: "none", redirectUris: [] }),
      (tx: StoreTx) =>
        tx.putClient(newId(), {
          authMethod: "client_secret_post",
          secret: marker,
          redirectUris: [],
        }),
      (tx: StoreTx) =>
        tx.putClient(newId(), { authMethod: "client_secret_post", redirectUris: [] }),
      (tx: StoreTx) =>
        tx.putClient(newId(), { authMethod: "none", secret: newId(), redirectUris: [] }),
      (tx: StoreTx) =>
        tx.putGrant(newId(), {
          clientId: v.clientId,
          resource: "https://brain.example.com/mcp",
          accessToken: marker,
          accessExpiresAt: new Date(clockMs),
          refreshToken: newId(),
          refreshExpiresAt: new Date(clockMs),
        }),
      (tx: StoreTx) => tx.rotateGrant(v.grantId, v.refresh, { ...next(), refreshToken: marker }),
      (tx: StoreTx) =>
        tx.rotateGrant(v.grantId, v.refresh, { ...next(), accessExpiresAt: new Date(Number.NaN) }),
    ]) {
      const error = await store.update(run).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).not.toContain(marker);
    }
    expect(readFileSync(sb.file, "utf8")).toBe(before);
  });

  it("rejects a callback that returns a promise, keeps the data and does not poison the queue", async () => {
    const sb = sandbox();
    const store = await open(sb);
    const id = newId();
    await expect(
      store.update((tx) => {
        tx.putClient(id, { authMethod: "none", redirectUris: [] });
        return Promise.reject(new Error("late failure")) as unknown as number;
      }),
    ).rejects.toThrow(TypeError);
    expect(store.getClient(id)).toBeUndefined();
    expect(existsSync(sb.file)).toBe(false);
    expect(await store.update(() => 5)).toEqual({ ok: true, value: 5 });
  });

  it("a callback that throws rejects the call, writes nothing and does not poison the queue", async () => {
    const sb = sandbox();
    const store = await open(sb);
    const id = newId();
    await expect(
      store.update((tx) => {
        tx.putClient(id, { authMethod: "none", redirectUris: [] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.getClient(id)).toBeUndefined();
    expect(existsSync(sb.file)).toBe(false);
    const ok = await store.update((tx) =>
      tx.putClient(id, { authMethod: "none", redirectUris: [] }),
    );
    expect(ok.ok).toBe(true);
    expect(store.getClient(id)).toBeDefined();
  });

  it("a transaction kept after its update ended cannot change anything", async () => {
    const sb = sandbox();
    const store = await open(sb);
    let kept: StoreTx | undefined;
    await store.update((tx) => {
      kept = tx;
    });
    expect(() => kept?.putClient(newId(), { authMethod: "none", redirectUris: [] })).toThrow(
      "ended",
    );
    expect(store.clientCount()).toBe(0);
  });
});

describe("auth store: atomic writes (D2, D3)", () => {
  it("a rename that fails returns server_error and keeps the old bytes, data and queue", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    let failRename = false;
    const store = await open(sb, {
      log: (line) => lines.push(line),
      io: {
        rename: async (from, to) => {
          if (failRename) {
            throw Object.assign(new Error(`EIO ${from} ${to} STOREMARKER`), { code: "EIO" });
          }
          await fsRename(from, to);
        },
      },
    });
    const a = issue();
    await store.update((tx) => addAll(tx, a));
    const bytes = readFileSync(sb.file);

    failRename = true;
    const b = issue();
    expect(await store.update((tx) => addAll(tx, b))).toEqual({ ok: false, error: "server_error" });
    expect(readFileSync(sb.file).equals(bytes)).toBe(true);
    expect(store.getClient(b.clientId)).toBeUndefined();
    expect(store.getGrant(b.grantId)).toBeUndefined();
    expect(store.clientCount()).toBe(1);
    expect(tempFiles(sb.auth)).toEqual([]);
    expect(lines).toEqual(["auth_store_write_failed: EIO"]);

    failRename = false;
    expect((await store.update((tx) => addAll(tx, b))).ok).toBe(true);
    store.close();
    const again = await open(sb);
    expect(again.getClient(a.clientId)).toBeDefined();
    expect(again.getClient(b.clientId)).toBeDefined();
  });

  it("a temp write that fails after creating the file returns server_error and leaves no temp", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    let fail = false;
    const store = await open(sb, {
      log: (line) => lines.push(line),
      io: {
        writeTemp: async (file, data) => {
          await writeFile(file, fail ? data.slice(0, 10) : data, { flag: "wx", mode: 0o600 });
          if (fail) throw new Error(`disk full ${file} STOREMARKER`);
        },
      },
    });
    const a = issue();
    await store.update((tx) => addAll(tx, a));
    const bytes = readFileSync(sb.file);

    fail = true;
    expect(await store.update((tx) => addAll(tx, issue()))).toEqual({
      ok: false,
      error: "server_error",
    });
    expect(readFileSync(sb.file).equals(bytes)).toBe(true);
    expect(store.clientCount()).toBe(1);
    expect(tempFiles(sb.auth)).toEqual([]);
    expect(lines).toEqual(["auth_store_write_failed: unknown"]);

    fail = false;
    const b = issue();
    expect((await store.update((tx) => addAll(tx, b))).ok).toBe(true);
    expect(tempFiles(sb.auth)).toEqual([]);
    store.close();
    const again = await open(sb);
    expect(again.getClient(a.clientId)).toBeDefined();
    expect(again.getClient(b.clientId)).toBeDefined();
  });

  it("does not delete a temp file it did not create when the name is taken", async () => {
    const sb = sandbox();
    let taken = "";
    const store = await open(sb, {
      io: {
        writeTemp: async (file) => {
          taken = file;
          writeFileSync(file, "someone else");
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
      },
    });
    expect((await store.update((tx) => addAll(tx, issue()))).ok).toBe(false);
    expect(readFileSync(taken, "utf8")).toBe("someone else");
  });

  it("the error code in the log is only an upper-case errno, never message text", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    const store = await open(sb, {
      log: (line) => lines.push(line),
      io: {
        rename: async () => {
          throw Object.assign(new Error("STOREMARKER"), { code: "bad code STOREMARKER" });
        },
      },
    });
    await store.update((tx) => addAll(tx, issue()));
    expect(lines).toEqual(["auth_store_write_failed: unknown"]);
  });

  it("20 parallel updates never overlap and all land", async () => {
    const sb = sandbox();
    let inFlight = 0;
    let peak = 0;
    const io: Partial<StoreIo> = {
      writeTemp: async (file, data) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        await writeFile(file, data, { flag: "wx", mode: 0o600 });
      },
      rename: async (from, to) => {
        await new Promise((r) => setTimeout(r, 2));
        try {
          await fsRename(from, to);
        } finally {
          inFlight--;
        }
      },
    };
    const store = await open(sb, { io });
    const ids = Array.from({ length: 20 }, () => newId());
    const outcomes = await Promise.all(
      ids.map((id) =>
        store.update((tx) => tx.putClient(id, { authMethod: "none", redirectUris: [] })),
      ),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(peak).toBe(1);
    expect(store.clientCount()).toBe(20);
    store.close();
    const again = await open(sb);
    for (const id of ids) expect(again.getClient(id)).toBeDefined();
  });

  it("a failure in the middle of a queue fails only that call", async () => {
    const sb = sandbox();
    let calls = 0;
    const store = await open(sb, {
      io: {
        rename: async (from, to) => {
          calls++;
          if (calls === 2) throw new Error("fail the second write");
          await fsRename(from, to);
        },
      },
    });
    const ids = [newId(), newId(), newId()];
    const outcomes = await Promise.all(
      ids.map((id) =>
        store.update((tx) => tx.putClient(id, { authMethod: "none", redirectUris: [] })),
      ),
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(store.getClient(ids[0] as string)).toBeDefined();
    expect(store.getClient(ids[1] as string)).toBeUndefined();
    expect(store.getClient(ids[2] as string)).toBeDefined();
  });

  it("writes nothing when nothing changed", async () => {
    const sb = sandbox();
    let writes = 0;
    const store = await open(sb, {
      io: {
        writeTemp: async (file, data) => {
          writes++;
          await writeFile(file, data, { flag: "wx", mode: 0o600 });
        },
      },
    });
    const v = issue();
    await store.update((tx) => addAll(tx, v));
    expect(writes).toBe(1);
    const before = statSync(sb.file, { bigint: true });
    const outcome = await store.update((tx) => tx.getClient(v.clientId)?.name);
    expect(outcome).toEqual({ ok: true, value: "Fictional client" });
    await store.update((tx) => tx.revokeGrant(newId()));
    await store.update((tx) =>
      tx.rotateGrant(newId(), newId(), {
        accessToken: newId(),
        accessExpiresAt: new Date(clockMs),
        refreshToken: newId(),
        refreshExpiresAt: new Date(clockMs),
      }),
    );
    expect(writes).toBe(1);
    const after = statSync(sb.file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("with no file at all, a no-change update still writes no file", async () => {
    const sb = sandbox();
    const store = await open(sb);
    await store.update(() => 1);
    expect(existsSync(sb.file)).toBe(false);
  });

  it("returns server_error and writes nothing when another process replaced auth.json", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    const store = await open(sb, { log: (line) => lines.push(line) });
    const v = issue();
    await store.update((tx) => addAll(tx, v));
    // Another process: write a different file and rename it over auth.json (new inode).
    const foreign = join(sb.auth, "foreign");
    writeFileSync(foreign, '{"version":1,"clients":{},"grants":{}}\n');
    await fsRename(foreign, sb.file);
    const foreignBytes = readFileSync(sb.file);

    const other = issue();
    expect(await store.update((tx) => addAll(tx, other))).toEqual({
      ok: false,
      error: "server_error",
    });
    expect(lines).toEqual(["auth_store_conflict"]);
    expect(readFileSync(sb.file).equals(foreignBytes)).toBe(true);
    expect(store.getClient(other.clientId)).toBeUndefined();
    expect(tempFiles(sb.auth)).toEqual([]);
  });

  it("detects a file created by another process after an open with no file", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    const store = await open(sb, { log: (line) => lines.push(line) });
    writeFileSync(sb.file, '{"version":1,"clients":{},"grants":{}}\n');
    expect(await store.update((tx) => addAll(tx, issue()))).toEqual({
      ok: false,
      error: "server_error",
    });
    expect(lines).toEqual(["auth_store_conflict"]);
  });
});

describe("auth store: validation of what is written (S3)", () => {
  it("returns invalid_data and writes nothing for a value over its bound", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    const store = await open(sb, { log: (line) => lines.push(line) });
    const tooLong = "n".repeat(AUTH_STORE_LIMITS.maxNameLength + 1);
    expect(
      await store.update((tx) =>
        tx.putClient(newId(), { authMethod: "none", redirectUris: [], name: tooLong }),
      ),
    ).toEqual({ ok: false, error: "invalid_data" });
    const uris = Array.from(
      { length: AUTH_STORE_LIMITS.maxRedirectUris + 1 },
      () => "https://a.example.com/",
    );
    expect(
      await store.update((tx) => tx.putClient(newId(), { authMethod: "none", redirectUris: uris })),
    ).toEqual({ ok: false, error: "invalid_data" });
    const longUri = "https://a.example.com/".padEnd(
      AUTH_STORE_LIMITS.maxRedirectUriLength + 1,
      "x",
    );
    expect(
      await store.update((tx) =>
        tx.putClient(newId(), { authMethod: "none", redirectUris: [longUri] }),
      ),
    ).toEqual({ ok: false, error: "invalid_data" });
    expect(existsSync(sb.file)).toBe(false);
    expect(store.clientCount()).toBe(0);
    expect(lines).toEqual(Array(3).fill("auth_store_invalid_data"));
  });

  it("returns invalid_data past 50 clients and past 500 grants", async () => {
    const sb = sandbox();
    const store = await open(sb);
    const outcome = await store.update((tx) => {
      for (let i = 0; i <= AUTH_STORE_LIMITS.maxClients; i++) {
        tx.putClient(newId(), { authMethod: "none", redirectUris: [] });
      }
    });
    expect(outcome).toEqual({ ok: false, error: "invalid_data" });
    expect(store.clientCount()).toBe(0);

    const clientId = newId();
    await store.update((tx) => tx.putClient(clientId, { authMethod: "none", redirectUris: [] }));
    const grants = (count: number) => (tx: StoreTx) => {
      for (let i = 0; i < count; i++) {
        tx.putGrant(newId(), {
          clientId,
          resource: "https://brain.example.com/mcp",
          accessToken: newId(),
          accessExpiresAt: new Date(clockMs + HOUR),
          refreshToken: newId(),
          refreshExpiresAt: new Date(clockMs + DAY),
        });
      }
    };
    expect(await store.update(grants(AUTH_STORE_LIMITS.maxGrants + 1))).toEqual({
      ok: false,
      error: "invalid_data",
    });
    expect(store.grantCount()).toBe(0);
    expect((await store.update(grants(AUTH_STORE_LIMITS.maxGrants))).ok).toBe(true);
  });

  it("every value the store accepts reopens, with every bound at its maximum", async () => {
    const sb = sandbox();
    const store = await open(sb);
    const ids: string[] = [];
    const first = issue();
    const outcome = await store.update((tx) => {
      for (let i = 0; i < AUTH_STORE_LIMITS.maxClients; i++) {
        const id = i === 0 ? first.clientId : newId();
        ids.push(id);
        tx.putClient(id, {
          authMethod: "client_secret_basic",
          secret: newId(),
          redirectUris: Array.from({ length: AUTH_STORE_LIMITS.maxRedirectUris }, (_, k) =>
            `https://a.example.com/${k}`.padEnd(AUTH_STORE_LIMITS.maxRedirectUriLength, "x"),
          ),
          name: "n".repeat(AUTH_STORE_LIMITS.maxNameLength),
        });
      }
      for (let i = 0; i < AUTH_STORE_LIMITS.maxGrants; i++) {
        const grantId = newId();
        const refresh = newId();
        tx.putGrant(grantId, {
          clientId: first.clientId,
          resource: "https://brain.example.com/".padEnd(AUTH_STORE_LIMITS.maxResourceLength, "r"),
          accessToken: newId(),
          accessExpiresAt: new Date(clockMs + HOUR),
          refreshToken: refresh,
          refreshExpiresAt: new Date(clockMs + 30 * DAY),
        });
        let current = refresh;
        for (let k = 0; k < AUTH_STORE_LIMITS.maxUsedRefreshHashes + 1; k++) {
          const nextRefresh = newId();
          tx.rotateGrant(grantId, current, {
            accessToken: newId(),
            accessExpiresAt: new Date(clockMs + HOUR),
            refreshToken: nextRefresh,
            refreshExpiresAt: new Date(clockMs + 30 * DAY),
          });
          current = nextRefresh;
        }
      }
    });
    expect(outcome.ok).toBe(true);
    expect(statSync(sb.file).size).toBeLessThan(AUTH_STORE_LIMITS.maxFileBytes);
    store.close();
    const again = await open(sb);
    expect(again.clientCount()).toBe(AUTH_STORE_LIMITS.maxClients);
    expect(again.grantCount()).toBe(AUTH_STORE_LIMITS.maxGrants);
  }, 60000);

  it("refuses a draft over 8 MiB of UTF-8 bytes even when every bound holds, and keeps working", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    const store = await open(sb, { log: (line) => lines.push(line) });
    const first = issue();
    await store.update((tx) => addAll(tx, first));
    const bytes = readFileSync(sb.file);

    // Control characters count as one UTF-16 unit each but JSON writes them as 6 bytes (\u0001).
    const escapes = "\u0001";
    const heavy = await store.update((tx) => {
      for (let i = 0; i < AUTH_STORE_LIMITS.maxClients - 1; i++) {
        tx.putClient(newId(), {
          authMethod: "none",
          redirectUris: Array.from({ length: AUTH_STORE_LIMITS.maxRedirectUris }, () =>
            escapes.repeat(AUTH_STORE_LIMITS.maxRedirectUriLength),
          ),
          name: escapes.repeat(AUTH_STORE_LIMITS.maxNameLength),
        });
      }
      for (let i = 0; i < AUTH_STORE_LIMITS.maxGrants - 1; i++) {
        tx.putGrant(newId(), {
          clientId: first.clientId,
          resource: escapes.repeat(AUTH_STORE_LIMITS.maxResourceLength),
          accessToken: newId(),
          accessExpiresAt: new Date(clockMs + HOUR),
          refreshToken: newId(),
          refreshExpiresAt: new Date(clockMs + 30 * DAY),
        });
      }
    });
    expect(heavy).toEqual({ ok: false, error: "invalid_data" });
    expect(readFileSync(sb.file).equals(bytes)).toBe(true);
    expect(store.clientCount()).toBe(1);
    expect(store.grantCount()).toBe(1);
    expect(tempFiles(sb.auth)).toEqual([]);
    expect(lines).toEqual(["auth_store_invalid_data"]);

    const next = issue();
    expect((await store.update((tx) => addAll(tx, next))).ok).toBe(true);
    store.close();
    const again = await open(sb);
    expect(again.getClient(first.clientId)).toBeDefined();
    expect(again.getClient(next.clientId)).toBeDefined();
  }, 60000);
});

describe("auth store: expiry on write (D4)", () => {
  it("removes grants whose refresh token expired at or before now, keeps live and revoked-unexpired ones", async () => {
    const sb = sandbox();
    const store = await open(sb);
    const client = issue();
    const mk = (refreshMs: number) => ({
      id: newId(),
      access: newId(),
      refresh: newId(),
      refreshMs,
    });
    const grants = {
      past: mk(HOUR),
      exact: mk(2 * HOUR),
      future: mk(2 * HOUR + 1),
      revoked: mk(DAY),
    };
    await store.update((tx) => {
      tx.putClient(client.clientId, { authMethod: "none", redirectUris: [] });
      for (const g of Object.values(grants)) {
        tx.putGrant(g.id, {
          clientId: client.clientId,
          resource: "https://brain.example.com/mcp",
          accessToken: g.access,
          accessExpiresAt: new Date(clockMs + 60_000),
          refreshToken: g.refresh,
          refreshExpiresAt: new Date(clockMs + g.refreshMs),
        });
      }
      tx.revokeGrant(grants.revoked.id);
    });
    expect(store.grantCount()).toBe(4);

    clockMs += 2 * HOUR; // "past" is 1 hour old, "exact" expires exactly now, "future" 1 ms later
    // An update that changes nothing else still writes, because it pruned.
    expect(await store.update(() => "pruned")).toEqual({ ok: true, value: "pruned" });
    expect(store.getGrant(grants.past.id)).toBeUndefined();
    expect(store.getGrant(grants.exact.id)).toBeUndefined();
    expect(store.getGrant(grants.future.id)).toBeDefined();
    expect(store.getGrant(grants.revoked.id)?.revoked).toBe(true);
    store.close();
    const again = await open(sb);
    expect(again.grantCount()).toBe(2);
    expect(JSON.parse(readFileSync(sb.file, "utf8")).grants[grants.exact.id]).toBeUndefined();
    clockMs -= 2 * HOUR;
  });
});

describe("auth store: opening (D5, D6, D7)", () => {
  it("opens empty when the file is missing and creates a missing directory 0700, the file 0600", async () => {
    const sb = sandbox();
    const nested = { ...sb, auth: join(sb.root, "deep", "er", "auth") };
    nested.file = join(nested.auth, AUTH_STORE_FILE);
    const store = await open(nested);
    expect(store.clientCount()).toBe(0);
    expect(store.grantCount()).toBe(0);
    expect(existsSync(nested.file)).toBe(false);
    if (POSIX) {
      expect(statSync(nested.auth).mode & 0o777).toBe(0o700);
      expect(statSync(join(sb.root, "deep", "er")).mode & 0o777).toBe(0o700);
      expect(statSync(join(sb.root, "deep")).mode & 0o777).toBe(0o700);
    }
    await store.update((tx) => addAll(tx, issue()));
    if (POSIX) expect(statSync(nested.file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)("sets 0600 on an existing auth.json that is more open", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    writeFileSync(sb.file, '{"version":1,"clients":{},"grants":{}}\n', { mode: 0o644 });
    chmodSync(sb.file, 0o644);
    await open(sb);
    expect(statSync(sb.file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)("does not change the mode of an existing directory", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth);
    chmodSync(sb.auth, 0o755);
    await open(sb);
    expect(statSync(sb.auth).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!POSIX)(
    "warns for a group-writable directory and refuses one others can write",
    async () => {
      const sb = sandbox();
      mkdirSync(sb.auth);
      chmodSync(sb.auth, 0o770);
      const lines: string[] = [];
      await open(sb, { log: (line) => lines.push(line) });
      expect(lines).toEqual(["auth_store_dir_group_writable"]);
      for (const s of stores.splice(0)) s.close();

      chmodSync(sb.auth, 0o777);
      await expectOpenError(sb, /^AUTH_STORE_DIR must not be writable by other users$/);
    },
  );

  it.skipIf(!POSIX || IS_ROOT)("refuses a directory this process cannot write", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth);
    chmodSync(sb.auth, 0o500);
    try {
      await expectOpenError(sb, /^AUTH_STORE_DIR is not writable$/);
    } finally {
      chmodSync(sb.auth, 0o700);
    }
  });

  it("refuses a store directory that is a file or sits below a file", async () => {
    const sb = sandbox();
    writeFileSync(sb.auth, "not a directory STOREMARKER");
    await expectOpenError(sb, /^AUTH_STORE_DIR cannot be created or is not a directory$/);
    const below = { ...sb, auth: join(sb.auth, "inner") };
    await expectOpenError(below, /^AUTH_STORE_DIR cannot be created or is not a directory$/);
  });

  it.skipIf(!POSIX)("refuses a store directory that is a dangling symlink", async () => {
    const sb = sandbox();
    symlinkSync(join(sb.root, "nowhere"), sb.auth);
    await expectOpenError(sb, /^AUTH_STORE_DIR cannot be created or is not a directory$/);
    expect(existsSync(join(sb.root, "nowhere"))).toBe(false);
  });

  it("removes a stale auth.json.<16 hex>.tmp at open, never reads it, and leaves other files", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    const stale = join(sb.auth, "auth.json.0123456789abcdef.tmp");
    const others = [
      "auth.json.0123456789abcde.tmp",
      "auth.json.0123456789abcdefg.tmp",
      "notes.tmp",
    ];
    writeFileSync(stale, "STOREMARKER not a store");
    for (const name of others) writeFileSync(join(sb.auth, name), "keep");
    const store = await open(sb);
    expect(existsSync(stale)).toBe(false);
    for (const name of others) expect(existsSync(join(sb.auth, name))).toBe(true);
    expect(store.clientCount()).toBe(0);
    expect(existsSync(sb.file)).toBe(false);
  });

  const invalidFiles: Array<[string, string, RegExp]> = [
    ["invalid JSON", "STOREMARKER not json", /is not valid JSON$/],
    ["a JSON array", "[]", /does not match the store format$/],
    ["null", "null", /does not match the store format$/],
    [
      "a wrong version",
      '{"version":2,"clients":{},"grants":{},"x":"STOREMARKER"}',
      /unsupported version$/,
    ],
    ["a missing version", '{"clients":{},"grants":{},"x":"STOREMARKER"}', /unsupported version$/],
    ["a string version", '{"version":"1","clients":{},"grants":{}}', /unsupported version$/],
    ["a missing grants table", '{"version":1,"clients":{}}', /does not match the store format$/],
    [
      "an unknown key",
      '{"version":1,"clients":{},"grants":{},"extra":"STOREMARKER"}',
      /does not match the store format$/,
    ],
  ];
  it.each(invalidFiles)(
    "throws AuthStoreInvalidError naming auth.json for %s",
    async (_name, content, pattern) => {
      const sb = sandbox();
      mkdirSync(sb.auth, { mode: 0o700 });
      writeFileSync(sb.file, content);
      const error = await expectOpenError(sb, /^Invalid auth store: auth\.json in AUTH_STORE_DIR /);
      expect(error.message).toMatch(pattern);
    },
  );

  it("throws for a client or grant whose shape is wrong, whatever the field", async () => {
    const good = {
      authMethod: "none",
      redirectUris: ["https://a.example.com/"],
      createdAt: "2026-10-31T12:00:00.000Z",
    };
    const goodGrant = {
      clientId: "c".repeat(43),
      resource: "https://brain.example.com/mcp",
      createdAt: "2026-10-31T12:00:00.000Z",
      revoked: false,
      accessHash: "a".repeat(64),
      accessExpiresAt: "2026-10-31T13:00:00.000Z",
      refreshHash: "b".repeat(64),
      refreshExpiresAt: "2026-11-30T13:00:00.000Z",
      usedRefreshHashes: [],
    };
    const id = "k".repeat(43);
    const cases: unknown[] = [
      { clients: { [id]: { ...good, authMethod: "STOREMARKER" } } },
      { clients: { [id]: { ...good, secretHash: "STOREMARKER" } } },
      { clients: { [id]: { ...good, createdAt: "STOREMARKER" } } },
      { clients: { [id]: { ...good, extra: "STOREMARKER" } } },
      { clients: { [id]: { ...good, name: "n".repeat(201) } } },
      { clients: { [id]: { ...good, redirectUris: Array(11).fill("https://a.example.com/") } } },
      { clients: { [`${"k".repeat(42)}!`]: good } },
      { clients: { [`${"k".repeat(44)}`]: good } },
      { grants: { [id]: { ...goodGrant, accessHash: "STOREMARKER" } } },
      { grants: { [id]: { ...goodGrant, revoked: "false" } } },
      { grants: { [id]: { ...goodGrant, usedRefreshHashes: Array(65).fill("c".repeat(64)) } } },
      { grants: { [id]: { ...goodGrant, usedRefreshHashes: ["STOREMARKER"] } } },
      { grants: { [id]: { ...goodGrant, refreshExpiresAt: "STOREMARKER" } } },
      {
        grants: Object.fromEntries(
          Array.from({ length: 501 }, (_, i) => [String(i).padStart(43, "g"), goodGrant]),
        ),
      },
      {
        clients: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [String(i).padStart(43, "g"), good]),
        ),
      },
    ];
    for (const part of cases) {
      const sb = sandbox();
      mkdirSync(sb.auth, { mode: 0o700 });
      writeFileSync(
        sb.file,
        JSON.stringify({ version: 1, clients: {}, grants: {}, ...(part as object) }),
      );
      await expectOpenError(sb, /does not match the store format$/);
    }
  });

  it("accepts the same good shapes it refuses when altered", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    const id = "k".repeat(43);
    writeFileSync(
      sb.file,
      JSON.stringify({
        version: 1,
        clients: {
          [id]: {
            authMethod: "none",
            redirectUris: ["https://a.example.com/"],
            createdAt: "2026-10-31T12:00:00.000Z",
          },
        },
        grants: {},
      }),
    );
    expect((await open(sb)).getClient(id)?.authMethod).toBe("none");
  });

  it("refuses a __proto__ key and a key that is not 43 base64url characters", async () => {
    for (const table of ["clients", "grants"]) {
      const sb = sandbox();
      mkdirSync(sb.auth, { mode: 0o700 });
      const entry =
        '{"authMethod":"none","redirectUris":[],"createdAt":"2026-10-31T12:00:00.000Z"}';
      writeFileSync(
        sb.file,
        `{"version":1,"clients":${table === "clients" ? `{"__proto__":${entry}}` : "{}"},"grants":${table === "grants" ? `{"__proto__":${entry}}` : "{}"}}`,
      );
      await expectOpenError(sb, /does not match the store format$/);
    }
  });

  it("refuses a __proto__ key at the top level and inside an entry", async () => {
    const entry = (extra: string) =>
      `{"authMethod":"none","redirectUris":[],"createdAt":"2026-10-31T12:00:00.000Z"${extra}}`;
    const id = "k".repeat(43);
    for (const text of [
      '{"version":1,"clients":{},"grants":{},"__proto__":{}}',
      `{"version":1,"clients":{"${id}":${entry(',"__proto__":{"x":1}')}},"grants":{}}`,
      `{"version":1,"clients":{"${id}":${entry(',"redirectUris":[{"__proto__":1}]')}},"grants":{}}`,
    ]) {
      const sb = sandbox();
      mkdirSync(sb.auth, { mode: 0o700 });
      writeFileSync(sb.file, text);
      await expectOpenError(sb, /does not match the store format$/);
    }
  });

  it("a huge array in auth.json is the fixed format error naming auth.json, not a stack overflow", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    const numbers = Array.from({ length: 500_000 }, (_, i) => i % 10).join(",");
    writeFileSync(sb.file, `{"version":1,"clients":{},"grants":{},"junk":[${numbers}]}\n`);
    expect(statSync(sb.file).size).toBeLessThan(AUTH_STORE_LIMITS.maxFileBytes);
    const error = await expectOpenError(sb, /does not match the store format$/);
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it("refuses a file above 8 MiB without parsing it", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    writeFileSync(sb.file, " ".repeat(AUTH_STORE_LIMITS.maxFileBytes + 1));
    await expectOpenError(sb, /does not match the store format$/);
  });

  it.skipIf(!POSIX)("refuses a symlinked auth.json without reading its target", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    const target = join(sb.root, "target.json");
    writeFileSync(target, '{"version":1,"clients":{},"grants":{}}\n');
    symlinkSync(target, sb.file);
    await expectOpenError(sb, /is not a regular file$/);
    rmSync(sb.file);
    symlinkSync(join(sb.root, "does-not-exist"), sb.file);
    await expectOpenError(sb, /is not a regular file$/);
  });

  it.skipIf(!POSIX)("refuses a hard-linked auth.json", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    const target = join(sb.root, "target.json");
    writeFileSync(target, '{"version":1,"clients":{},"grants":{}}\n');
    linkSync(target, sb.file);
    await expectOpenError(sb, /is not a regular file$/);
  });

  it.skipIf(!POSIX)("refuses a FIFO or a directory as auth.json instead of blocking", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    execFileSync("mkfifo", [sb.file]);
    await expectOpenError(sb, /is not a regular file$/);
    rmSync(sb.file);
    mkdirSync(sb.file);
    await expectOpenError(sb, /is not a regular file$/);
  });

  it.skipIf(!POSIX || IS_ROOT)(
    "an unreadable auth.json is 'cannot be read' with no path",
    async () => {
      const sb = sandbox();
      mkdirSync(sb.auth, { mode: 0o700 });
      writeFileSync(sb.file, '{"version":1,"clients":{},"grants":{}}\n');
      chmodSync(sb.file, 0o000);
      try {
        await expectOpenError(sb, /cannot be read$/);
      } finally {
        chmodSync(sb.file, 0o600);
      }
    },
  );

  it("one store per directory: a second open fails until the first is closed, also when concurrent", async () => {
    const sb = sandbox();
    const first = await open(sb);
    await expectOpenError(sb, /^AUTH_STORE_DIR is already open in this process$/);
    first.close();
    await open(sb);
    for (const s of stores.splice(0)) s.close();

    const results = await Promise.allSettled([open(sb), open(sb)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("a failed open releases the directory", async () => {
    const sb = sandbox();
    mkdirSync(sb.auth, { mode: 0o700 });
    writeFileSync(sb.file, "STOREMARKER");
    await expectOpenError(sb, /not valid JSON$/);
    writeFileSync(sb.file, '{"version":1,"clients":{},"grants":{}}\n');
    expect((await open(sb)).clientCount()).toBe(0);
  });

  it("update after close fails", async () => {
    const store = await open(sandbox());
    store.close();
    await expect(store.update(() => 1)).rejects.toThrow("closed");
  });
});

describe("auth store: the directory must not be inside the vault (D8)", () => {
  const INSIDE = /^AUTH_STORE_DIR: must not be inside VAULT_DIR$/;

  it("refuses the vault, a folder in it, <vault>/..auth and a path that climbs back in", async () => {
    const sb = sandbox();
    for (const dir of [
      sb.vault,
      join(sb.vault, "auth"),
      join(sb.vault, "..auth"),
      join(sb.vault, "a", "b", "c"),
      join(sb.vault, "x", "..", "auth"),
    ]) {
      await expectOpenError({ ...sb, auth: dir }, INSIDE);
    }
    expect(readdirSync(sb.vault)).toEqual([]);
  });

  it.skipIf(!POSIX)(
    "refuses a symlink that resolves into the vault, also through a chain and a missing tail",
    async () => {
      const sb = sandbox();
      const link = join(sb.root, "link-to-vault");
      symlinkSync(sb.vault, link);
      const chain = join(sb.root, "chain");
      symlinkSync(link, chain);
      mkdirSync(join(sb.vault, "inside"));
      const deep = join(sb.root, "deep-link");
      symlinkSync(join(sb.vault, "inside"), deep);
      for (const dir of [
        join(link, "auth"),
        link,
        join(chain, "auth"),
        join(chain, "a", "b"),
        join(deep, "auth"),
      ]) {
        await expectOpenError({ ...sb, auth: dir }, INSIDE);
      }
      expect(readdirSync(sb.vault)).toEqual(["inside"]);
      expect(readdirSync(join(sb.vault, "inside"))).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    "refuses a store directory symlinked into the vault even when it already exists as a link",
    async () => {
      const sb = sandbox();
      symlinkSync(sb.vault, sb.auth);
      await expectOpenError(sb, INSIDE);
    },
  );

  it("accepts a sibling that shares a name prefix, the parent of the vault and a path elsewhere", async () => {
    const sb = sandbox();
    const sibling = join(sb.root, "vault-auth");
    const store = await open({ ...sb, auth: sibling });
    expect(store.clientCount()).toBe(0);
    store.close();
    const parent = await open({ ...sb, auth: sb.root });
    expect(parent.clientCount()).toBe(0);
  });

  it.skipIf(!POSIX || !IS_ROOT)(
    "refuses a second path to the vault (bind mount) by device and inode",
    async () => {
      const sb = sandbox();
      const alias = join(sb.root, "alias");
      mkdirSync(alias);
      try {
        execFileSync("mount", ["--bind", sb.vault, alias], { stdio: "ignore" });
      } catch {
        return; // this environment cannot mount: nothing to prove here
      }
      unmount.push(alias);
      await expectOpenError({ ...sb, auth: join(alias, "auth") }, INSIDE);
      await expectOpenError({ ...sb, auth: alias }, INSIDE);
      expect(readdirSync(sb.vault)).toEqual([]);
    },
  );

  it("names the variables and never a path when the vault cannot be resolved", async () => {
    const sb = sandbox();
    await expectOpenError(
      { ...sb, vault: join(sb.root, "no-such-vault") },
      /^VAULT_DIR cannot be resolved to check AUTH_STORE_DIR$/,
    );
  });
});
