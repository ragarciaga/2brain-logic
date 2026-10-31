import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isInside } from "../../config/env.js";

/**
 * The auth store: OAuth clients and grants in `<AUTH_STORE_DIR>/auth.json` (R5.5, R5.6).
 *
 * - Callers hand over raw tokens and client secrets; only SHA-256 hashes are kept or written, so
 *   no caller can persist a raw value.
 * - One open store per real directory in a process (a second open of the same directory fails until
 *   `close`). `src/index.ts` opens it once and passes the handle on.
 * - Every change goes through `update`: calls run one at a time on a clone of the data, the clone
 *   is validated, written to a temp file, renamed over `auth.json`, and only then becomes the
 *   data readers see. A failed write keeps the old file and the old data.
 * - Errors and log lines are fixed strings. They never carry file content, a path or a value.
 */

export const AUTH_STORE_FILE = "auth.json";

/** Bounds the schema enforces on every read and every write. T6 uses the same ones. */
export const AUTH_STORE_LIMITS = Object.freeze({
  maxClients: 50,
  maxGrants: 500,
  maxRedirectUris: 10,
  maxRedirectUriLength: 2048,
  maxNameLength: 200,
  maxResourceLength: 2048,
  maxUsedRefreshHashes: 64,
  maxFileBytes: 8 * 1024 * 1024,
});

/** 32 random bytes in base64url: the shape of an id, a token and a client secret. */
const RAW_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TEMP_PATTERN = /^auth\.json\.[0-9a-f]{16}\.tmp$/;

const idSchema = z.string().regex(RAW_PATTERN);
const hashSchema = z.string().regex(HASH_PATTERN);
const dateSchema = z.iso.datetime();

const clientSchema = z.strictObject({
  secretHash: hashSchema.optional(),
  authMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]),
  redirectUris: z
    .array(z.string().min(1).max(AUTH_STORE_LIMITS.maxRedirectUriLength))
    .max(AUTH_STORE_LIMITS.maxRedirectUris),
  name: z.string().max(AUTH_STORE_LIMITS.maxNameLength).optional(),
  createdAt: dateSchema,
});

const grantSchema = z.strictObject({
  clientId: idSchema,
  resource: z.string().min(1).max(AUTH_STORE_LIMITS.maxResourceLength),
  createdAt: dateSchema,
  revoked: z.boolean(),
  accessHash: hashSchema,
  accessExpiresAt: dateSchema,
  refreshHash: hashSchema,
  refreshExpiresAt: dateSchema,
  usedRefreshHashes: z.array(hashSchema).max(AUTH_STORE_LIMITS.maxUsedRefreshHashes),
});

/** The one schema behind both reading `auth.json` and validating every draft before a write. */
export const authStoreSchema = z.strictObject({
  version: z.literal(1),
  clients: z
    .record(idSchema, clientSchema)
    .refine((clients) => Object.keys(clients).length <= AUTH_STORE_LIMITS.maxClients),
  grants: z
    .record(idSchema, grantSchema)
    .refine((grants) => Object.keys(grants).length <= AUTH_STORE_LIMITS.maxGrants),
});

export type StoredClient = z.output<typeof clientSchema>;
export type StoredGrant = z.output<typeof grantSchema>;
export type AuthStoreData = z.output<typeof authStoreSchema>;

export type ClientAuthMethod = StoredClient["authMethod"];

/** SHA-256 of a UTF-8 string, lower-case hex: how a token or a client secret is stored. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A new random id, token or client secret: 32 random bytes, 43 base64url characters. */
export function newId(): string {
  return randomBytes(32).toString("base64url");
}

const MESSAGES = Object.freeze({
  unreadable: "Invalid auth store: auth.json in AUTH_STORE_DIR cannot be read",
  notJson: "Invalid auth store: auth.json in AUTH_STORE_DIR is not valid JSON",
  version: "Invalid auth store: auth.json in AUTH_STORE_DIR has an unsupported version",
  format: "Invalid auth store: auth.json in AUTH_STORE_DIR does not match the store format",
  notRegular: "Invalid auth store: auth.json in AUTH_STORE_DIR is not a regular file",
  dirUnusable: "AUTH_STORE_DIR cannot be created or is not a directory",
  dirNotWritable: "AUTH_STORE_DIR is not writable",
  dirOthersWritable: "AUTH_STORE_DIR must not be writable by other users",
  insideVault: "AUTH_STORE_DIR: must not be inside VAULT_DIR",
  vaultUnresolved: "VAULT_DIR cannot be resolved to check AUTH_STORE_DIR",
  alreadyOpen: "AUTH_STORE_DIR is already open in this process",
});

/** An unusable store: a bad `auth.json` or a bad store directory. Fixed message, no `cause`. */
export class AuthStoreInvalidError extends Error {
  readonly file = AUTH_STORE_FILE;
  constructor(message: string) {
    super(message);
    this.name = "AuthStoreInvalidError";
  }
}

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: "server_error" | "invalid_data" };

export type RotateResult = { ok: true } | { ok: false; reason: "reused" | "invalid" };

export type AccessState = "live" | "expired" | "revoked";

/** Reads, over the committed data (on the store) or over the draft (inside `update`). */
export interface StoreReads {
  getClient(clientId: string): StoredClient | undefined;
  clientCount(): number;
  grantCount(): number;
  getGrant(grantId: string): StoredGrant | undefined;
  /** The grant an access token belongs to, with its state at `now` (the store clock by default). */
  findGrantByAccessToken(
    rawToken: string,
    now?: Date,
  ): { id: string; grant: StoredGrant; state: AccessState } | undefined;
  /**
   * The grant a refresh token belongs to; `reused` when it is an older, rotated-out token of that
   * grant. The caller checks revocation and expiry.
   */
  findGrantByRefreshToken(
    rawToken: string,
  ): { id: string; grant: StoredGrant; reused: boolean } | undefined;
  /** True when `rawSecret` is the secret of a client that has one. Constant-time compare. */
  verifyClientSecret(clientId: string, rawSecret: string): boolean;
}

export interface NewClient {
  authMethod: ClientAuthMethod;
  /** Raw client secret, required for the two `client_secret_*` methods and absent for `none`. */
  secret?: string;
  redirectUris: string[];
  name?: string;
}

export interface NewGrant {
  clientId: string;
  resource: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface RotationTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** What `update` hands to `mutate`: reads of the draft plus the only ways to change it. */
export interface StoreTx extends StoreReads {
  /** Insert only. Hashes the secret. Throws when the id exists. */
  putClient(clientId: string, client: NewClient): void;
  /** Insert only. Hashes both tokens; `revoked` is false and the history is empty. */
  putGrant(grantId: string, grant: NewGrant): void;
  /**
   * Replace the tokens of a grant when `presentedRefreshToken` is its current refresh token, the
   * grant is not revoked and not expired; the old refresh hash goes to the history. Otherwise
   * change nothing and say why: `reused` when the token is an older one of this grant.
   */
  rotateGrant(grantId: string, presentedRefreshToken: string, next: RotationTokens): RotateResult;
  /** Mark a grant revoked and clear its history. False when the id is unknown. */
  revokeGrant(grantId: string): boolean;
}

export interface AuthStore extends StoreReads {
  /**
   * Run `mutate` on a copy of the data, then write it. Calls never overlap. `mutate` must be
   * synchronous (a promise result rejects the call) and its changes happen only through `tx`.
   * Expired grants are removed on every write; nothing is written when nothing changed. A failed
   * write returns `server_error` and leaves the file and the data as they were.
   */
  update<T>(mutate: (tx: StoreTx) => T): Promise<WriteOutcome<T>>;
  /** Release the directory so it can be opened again in this process. */
  close(): void;
}

/** Test seam for the two steps whose failure the store must survive. */
export interface StoreIo {
  /** Create `file` exclusively with mode 0600, write `data`, flush it and close. */
  writeTemp(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface OpenAuthStoreOptions {
  /** `AUTH_STORE_DIR`. */
  dir: string;
  /** `VAULT_DIR`: the store directory must not be inside it. */
  vaultDir: string;
  now?: () => Date;
  io?: Partial<StoreIo>;
  /** Where one-line fixed records go. Defaults to `console.error`. */
  log?: (line: string) => void;
}

interface Tables {
  clients: Map<string, StoredClient>;
  grants: Map<string, StoredGrant>;
}

interface Signature {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? code : "unknown";
}

function assertRaw(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RAW_PATTERN.test(value)) {
    throw new TypeError("a raw id, token or secret must be 43 base64url characters");
  }
}

function assertDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("expected a valid Date");
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function toPlain(tables: Tables): AuthStoreData {
  return {
    version: 1,
    clients: Object.fromEntries(tables.clients),
    grants: Object.fromEntries(tables.grants),
  };
}

function toTables(data: AuthStoreData): Tables {
  return {
    clients: new Map(Object.entries(data.clients)),
    grants: new Map(Object.entries(data.grants)),
  };
}

function makeReads(tables: () => Tables, clock: () => Date): StoreReads {
  return {
    getClient(clientId) {
      const client = tables().clients.get(clientId);
      return client === undefined ? undefined : structuredClone(client);
    },
    clientCount: () => tables().clients.size,
    grantCount: () => tables().grants.size,
    getGrant(grantId) {
      const grant = tables().grants.get(grantId);
      return grant === undefined ? undefined : structuredClone(grant);
    },
    findGrantByAccessToken(rawToken, now = clock()) {
      const hash = sha256Hex(rawToken);
      for (const [id, grant] of tables().grants) {
        if (grant.accessHash !== hash) continue;
        let state: AccessState = "live";
        if (grant.revoked) state = "revoked";
        else if (Date.parse(grant.accessExpiresAt) <= now.getTime()) state = "expired";
        return { id, grant: structuredClone(grant), state };
      }
      return undefined;
    },
    findGrantByRefreshToken(rawToken) {
      const hash = sha256Hex(rawToken);
      for (const [id, grant] of tables().grants) {
        if (grant.refreshHash === hash) return { id, grant: structuredClone(grant), reused: false };
        if (grant.usedRefreshHashes.includes(hash)) {
          return { id, grant: structuredClone(grant), reused: true };
        }
      }
      return undefined;
    },
    verifyClientSecret(clientId, rawSecret) {
      // Hash first so a missing client costs the same as a wrong secret.
      const hash = sha256Hex(rawSecret);
      const client = tables().clients.get(clientId);
      if (client === undefined || client.authMethod === "none" || client.secretHash === undefined) {
        return false;
      }
      return hexEqual(hash, client.secretHash);
    },
  };
}

function makeTx(draft: Tables, clock: () => Date, isActive: () => boolean, touch: () => void) {
  const reads = makeReads(() => draft, clock);
  const live = (): void => {
    if (!isActive()) throw new Error("the store transaction has ended");
  };
  const tx: StoreTx = {
    ...reads,
    putClient(clientId, client) {
      live();
      assertRaw(clientId);
      if (draft.clients.has(clientId)) throw new Error("client already exists");
      const hasSecret = client.secret !== undefined;
      if (hasSecret !== (client.authMethod !== "none")) {
        throw new TypeError("a client secret is required exactly when authMethod is not none");
      }
      const stored: StoredClient = {
        authMethod: client.authMethod,
        redirectUris: [...client.redirectUris],
        createdAt: clock().toISOString(),
      };
      if (client.secret !== undefined) {
        assertRaw(client.secret);
        stored.secretHash = sha256Hex(client.secret);
      }
      if (client.name !== undefined) stored.name = client.name;
      draft.clients.set(clientId, stored);
      touch();
    },
    putGrant(grantId, grant) {
      live();
      assertRaw(grantId);
      assertRaw(grant.clientId);
      assertRaw(grant.accessToken);
      assertRaw(grant.refreshToken);
      assertDate(grant.accessExpiresAt);
      assertDate(grant.refreshExpiresAt);
      if (draft.grants.has(grantId)) throw new Error("grant already exists");
      if (!draft.clients.has(grant.clientId)) throw new Error("grant refers to an unknown client");
      draft.grants.set(grantId, {
        clientId: grant.clientId,
        resource: grant.resource,
        createdAt: clock().toISOString(),
        revoked: false,
        accessHash: sha256Hex(grant.accessToken),
        accessExpiresAt: grant.accessExpiresAt.toISOString(),
        refreshHash: sha256Hex(grant.refreshToken),
        refreshExpiresAt: grant.refreshExpiresAt.toISOString(),
        usedRefreshHashes: [],
      });
      touch();
    },
    rotateGrant(grantId, presentedRefreshToken, next) {
      live();
      assertRaw(next.accessToken);
      assertRaw(next.refreshToken);
      assertDate(next.accessExpiresAt);
      assertDate(next.refreshExpiresAt);
      const grant = draft.grants.get(grantId);
      if (grant === undefined) return { ok: false, reason: "invalid" };
      const presented = sha256Hex(presentedRefreshToken);
      if (!hexEqual(presented, grant.refreshHash)) {
        const older = grant.usedRefreshHashes.some((used) => hexEqual(used, presented));
        return { ok: false, reason: older ? "reused" : "invalid" };
      }
      if (grant.revoked || Date.parse(grant.refreshExpiresAt) <= clock().getTime()) {
        return { ok: false, reason: "invalid" };
      }
      const history = [...grant.usedRefreshHashes, grant.refreshHash];
      grant.usedRefreshHashes = history.slice(-AUTH_STORE_LIMITS.maxUsedRefreshHashes);
      grant.accessHash = sha256Hex(next.accessToken);
      grant.accessExpiresAt = next.accessExpiresAt.toISOString();
      grant.refreshHash = sha256Hex(next.refreshToken);
      grant.refreshExpiresAt = next.refreshExpiresAt.toISOString();
      touch();
      return { ok: true };
    },
    revokeGrant(grantId) {
      live();
      const grant = draft.grants.get(grantId);
      if (grant === undefined) return false;
      grant.revoked = true;
      grant.usedRefreshHashes = [];
      touch();
      return true;
    },
  };
  return tx;
}

/** Real path of the deepest existing ancestor of `target`, and the missing tail below it. */
async function resolveDeepest(target: string): Promise<{ existing: string; real: string }> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(current);
      return { existing, real: path.join(existing, ...tail.reverse()) };
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
      const parent = path.dirname(current);
      if (parent === current) throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `start` or one of its ancestors is the vault itself (same device and inode). */
async function sitsInVault(
  start: string,
  vault: { dev: bigint; ino: bigint },
  failure: string,
): Promise<boolean> {
  if (vault.ino === 0n) return false;
  let current = start;
  for (;;) {
    let info: BigIntStats;
    try {
      info = await stat(current, { bigint: true });
    } catch {
      throw new AuthStoreInvalidError(failure);
    }
    if (info.dev === vault.dev && info.ino === vault.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function defaultWriteTemp(file: string, data: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The rename has happened; a failed directory flush only weakens durability.
  }
}

/**
 * True when any object in the parsed JSON has an own `__proto__` key. Zod drops that key without
 * an error, so the schema alone would accept it; a store file never has one.
 */
function hasProtoKey(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (!Array.isArray(value) && Object.hasOwn(value, "__proto__")) return true;
    // A loop, not a spread: a huge array would overflow the call stack as arguments.
    for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

/** Read and validate `auth.json`. Fixed errors only. A missing file is an empty store. */
async function readStoreFile(
  file: string,
): Promise<{ tables: Tables; signature: Signature | null }> {
  const empty = { tables: { clients: new Map(), grants: new Map() }, signature: null };
  if (process.platform === "win32") {
    try {
      if (!(await lstat(file)).isFile()) throw new AuthStoreInvalidError(MESSAGES.notRegular);
    } catch (error) {
      if (error instanceof AuthStoreInvalidError) throw error;
      if (errnoCode(error) === "ENOENT") return empty;
      throw new AuthStoreInvalidError(MESSAGES.unreadable);
    }
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return empty;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new AuthStoreInvalidError(MESSAGES.notRegular);
    }
    throw new AuthStoreInvalidError(MESSAGES.unreadable);
  }
  let bytes: Buffer;
  let signature: Signature;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n) throw new AuthStoreInvalidError(MESSAGES.notRegular);
    if (info.size > BigInt(AUTH_STORE_LIMITS.maxFileBytes)) {
      throw new AuthStoreInvalidError(MESSAGES.format);
    }
    if (process.platform !== "win32" && (info.mode & 0o077n) !== 0n) {
      // Best effort: new writes are 0600 anyway.
      await handle.chmod(0o600).catch(() => undefined);
    }
    bytes = await handle.readFile();
    signature = { ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
  } catch (error) {
    if (error instanceof AuthStoreInvalidError) throw error;
    throw new AuthStoreInvalidError(MESSAGES.unreadable);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.length > AUTH_STORE_LIMITS.maxFileBytes) {
    throw new AuthStoreInvalidError(MESSAGES.format);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AuthStoreInvalidError(MESSAGES.notJson);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthStoreInvalidError(MESSAGES.format);
  }
  if (!Object.hasOwn(parsed, "version") || (parsed as { version: unknown }).version !== 1) {
    throw new AuthStoreInvalidError(MESSAGES.version);
  }
  try {
    if (hasProtoKey(parsed)) throw new AuthStoreInvalidError(MESSAGES.format);
    const checked = authStoreSchema.safeParse(parsed);
    if (!checked.success) throw new AuthStoreInvalidError(MESSAGES.format);
    return { tables: toTables(checked.data), signature };
  } catch (error) {
    // Anything unexpected while checking the content is the same fixed error, with no cause.
    if (error instanceof AuthStoreInvalidError) throw error;
    throw new AuthStoreInvalidError(MESSAGES.format);
  }
}

/** Directories (real paths) this process has open. One store per directory. */
const openDirectories = new Set<string>();

/**
 * Open the store. Order: resolve the vault and the store directory to real paths; refuse a store
 * directory inside the vault (by path and by device and inode of every ancestor); create it
 * 0700 when missing; check it is a directory this process can write that others cannot; remove
 * stale temp files; read and validate `auth.json`. Throws `AuthStoreInvalidError`, fixed message.
 */
export async function openAuthStore(options: OpenAuthStoreOptions): Promise<AuthStore> {
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const io: StoreIo = { writeTemp: defaultWriteTemp, rename, ...options.io };

  let realVault: string;
  let vaultId: { dev: bigint; ino: bigint };
  try {
    realVault = await realpath(path.resolve(options.vaultDir));
    const info = await stat(realVault, { bigint: true });
    vaultId = { dev: info.dev, ino: info.ino };
  } catch {
    throw new AuthStoreInvalidError(MESSAGES.vaultUnresolved);
  }

  const { existing, real } = await resolveDeepest(options.dir);
  if (isInside(real, realVault)) throw new AuthStoreInvalidError(MESSAGES.insideVault);
  if (await sitsInVault(existing, vaultId, MESSAGES.dirUnusable)) {
    throw new AuthStoreInvalidError(MESSAGES.insideVault);
  }
  // Check and add with no await between, so two concurrent opens cannot both pass.
  if (openDirectories.has(real)) throw new AuthStoreInvalidError(MESSAGES.alreadyOpen);
  openDirectories.add(real);

  let initial: Awaited<ReturnType<typeof readStoreFile>>;
  try {
    let createdFrom: string | undefined;
    try {
      createdFrom = await mkdir(real, { recursive: true, mode: 0o700 });
    } catch {
      throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
    }
    if (createdFrom !== undefined && process.platform !== "win32") {
      // mkdir's mode is subject to the umask: set 0700 on every directory this call created.
      for (let dir = real; ; dir = path.dirname(dir)) {
        await chmod(dir, 0o700).catch(() => undefined);
        if (dir === createdFrom || path.dirname(dir) === dir) break;
      }
    }
    let again: string;
    try {
      again = await realpath(real);
    } catch {
      throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
    }
    if (again !== real) throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
    if (isInside(real, realVault) || (await sitsInVault(real, vaultId, MESSAGES.dirUnusable))) {
      throw new AuthStoreInvalidError(MESSAGES.insideVault);
    }
    const dirInfo = await stat(real).catch(() => undefined);
    if (dirInfo === undefined || !dirInfo.isDirectory()) {
      throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
    }
    if (process.platform !== "win32") {
      if ((dirInfo.mode & 0o002) !== 0) throw new AuthStoreInvalidError(MESSAGES.dirOthersWritable);
      if ((dirInfo.mode & 0o020) !== 0) log("auth_store_dir_group_writable");
    }
    try {
      await access(real, constants.W_OK);
    } catch {
      throw new AuthStoreInvalidError(MESSAGES.dirNotWritable);
    }
    let names: string[];
    try {
      names = await readdir(real);
    } catch {
      throw new AuthStoreInvalidError(MESSAGES.dirUnusable);
    }
    for (const name of names) {
      if (TEMP_PATTERN.test(name)) await unlink(path.join(real, name)).catch(() => undefined);
    }
    initial = await readStoreFile(path.join(real, AUTH_STORE_FILE));
  } catch (error) {
    openDirectories.delete(real);
    throw error;
  }

  const file = path.join(real, AUTH_STORE_FILE);
  let committed: Tables = initial.tables;
  let lastSignature: Signature | null = initial.signature;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();

  async function currentSignature(): Promise<Signature | null> {
    try {
      const info = await lstat(file, { bigint: true });
      return { ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  function same(a: Signature | null, b: Signature | null): boolean {
    if (a === null || b === null) return a === b;
    return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
  }

  /** Temp file, flush, conflict check, rename, directory flush. True when `auth.json` changed. */
  async function persist(content: string): Promise<boolean> {
    const temp = path.join(real, `${AUTH_STORE_FILE}.${randomBytes(8).toString("hex")}.tmp`);
    let ownsTemp = true;
    let conflict = false;
    try {
      try {
        await io.writeTemp(temp, content);
      } catch (error) {
        // `wx` failed because the name was taken: that file is not ours to delete.
        if (errnoCode(error) === "EEXIST") ownsTemp = false;
        throw error;
      }
      const written = await lstat(temp, { bigint: true });
      const signature = { ino: written.ino, size: written.size, mtimeNs: written.mtimeNs };
      // Another process replaced auth.json since this one read or wrote it: do not overwrite.
      if (!same(await currentSignature(), lastSignature)) {
        conflict = true;
        throw new Error("conflict");
      }
      await io.rename(temp, file);
      lastSignature = signature;
    } catch (error) {
      if (ownsTemp) await unlink(temp).catch(() => undefined);
      log(conflict ? "auth_store_conflict" : `auth_store_write_failed: ${errnoCode(error)}`);
      return false;
    }
    await syncDirectory(real);
    return true;
  }

  async function runUpdate<T>(mutate: (tx: StoreTx) => T): Promise<WriteOutcome<T>> {
    if (closed) throw new Error("the auth store is closed");
    const at = clock();
    const draft: Tables = structuredClone(committed);
    let active = true;
    let dirty = false;
    const tx = makeTx(
      draft,
      () => at,
      () => active,
      () => {
        dirty = true;
      },
    );
    let value: T;
    try {
      value = mutate(tx);
    } finally {
      active = false;
    }
    if (isThenable(value)) {
      // Keep a later rejection of the stray promise from becoming an unhandled rejection.
      try {
        (value as unknown as PromiseLike<unknown>).then(undefined, () => undefined);
      } catch {
        // a hostile thenable: nothing more to do
      }
      throw new TypeError("the update callback must be synchronous");
    }
    for (const [id, grant] of draft.grants) {
      if (Date.parse(grant.refreshExpiresAt) <= at.getTime()) {
        draft.grants.delete(id);
        dirty = true;
      }
    }
    if (!dirty) return { ok: true, value };
    const plain = toPlain(draft);
    const content = `${JSON.stringify(plain, null, 2)}\n`;
    // The schema counts UTF-16 units; the cap is on UTF-8 bytes, and JSON escapes (`\u0001` is 6
    // bytes) and multi-byte characters can push a draft past it. Refuse what open would refuse.
    if (
      !authStoreSchema.safeParse(plain).success ||
      Buffer.byteLength(content, "utf8") > AUTH_STORE_LIMITS.maxFileBytes
    ) {
      log("auth_store_invalid_data");
      return { ok: false, error: "invalid_data" };
    }
    if (!(await persist(content))) return { ok: false, error: "server_error" };
    committed = draft;
    return { ok: true, value };
  }

  const reads = makeReads(() => committed, clock);
  return {
    ...reads,
    update<T>(mutate: (tx: StoreTx) => T): Promise<WriteOutcome<T>> {
      const run = chain.then(() => runUpdate(mutate));
      chain = run.catch(() => undefined);
      return run;
    },
    close() {
      if (closed) return;
      closed = true;
      openDirectories.delete(real);
    },
  };
}
