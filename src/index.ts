import { openAuthStore } from "./auth/oauth/store.js";
import { loadEnv } from "./config/env.js";
import { ConfigInvalidError, loadVaultConfig } from "./config/vault-config.js";
import { defaultGit, ensureClone } from "./git/index.js";
import { createPublicApp } from "./mcp/app.js";
import { configInvalidLogLine, createApp } from "./server/app.js";
import { startServer } from "./server/start.js";
import { createNoteWriter } from "./vault/write-note.js";

async function main(): Promise<void> {
  const env = loadEnv();
  await ensureClone(env.VAULT_DIR, env.VAULT_REMOTE);
  try {
    await loadVaultConfig(env.VAULT_DIR);
  } catch (error) {
    // An invalid config is not fatal: the owner can fix it from another clone, and the writer
    // reads it again on every write. Until then, writes answer 503.
    if (!(error instanceof ConfigInvalidError)) throw error;
    console.error(configInvalidLogLine(error));
  }
  // The one auth store of this process, opened before any port binds so a bad `auth.json` or a
  // bad AUTH_STORE_DIR exits 1 with nothing listening. The public app takes this handle;
  // nothing else opens the store.
  const authStore =
    env.publicApp === undefined
      ? undefined
      : await openAuthStore({ dir: env.publicApp.AUTH_STORE_DIR, vaultDir: env.VAULT_DIR });
  const writer = createNoteWriter({
    vaultDir: env.VAULT_DIR,
    author: { name: env.GIT_AUTHOR_NAME, email: env.GIT_AUTHOR_EMAIL },
    git: defaultGit,
  });
  const app = createApp({ writer, meetings: writer, ingestToken: env.INGEST_TOKEN });
  await startServer(app, { host: env.HOST, port: env.PORT });
  console.log(`2brain listening on ${env.HOST}:${env.PORT}`);
  if (env.publicApp === undefined) {
    console.log("mcp disabled: PUBLIC_BASE_URL is not set");
    return;
  }
  // Log the port only: `env.publicApp` carries OWNER_PASSPHRASE_HASH.
  const { PUBLIC_BASE_URL, MCP_PORT, ALLOWED_REDIRECT_HOSTS, TRUST_PROXY_HOPS } = env.publicApp;
  if (authStore === undefined) throw new Error("the auth store is not open");
  console.log(`auth store open: ${authStore.clientCount()} clients`);
  const { app: publicApp } = createPublicApp({
    baseUrl: PUBLIC_BASE_URL,
    mcp: { writer, config: { vaultDir: env.VAULT_DIR } },
    auth: {
      store: authStore,
      allowedRedirectHosts: ALLOWED_REDIRECT_HOSTS,
      trustProxyHops: TRUST_PROXY_HOPS,
      ownerPassphraseHash: env.publicApp.OWNER_PASSPHRASE_HASH,
    },
  });
  await startServer(publicApp, { host: env.HOST, port: MCP_PORT });
  console.log(`2brain mcp listening on ${env.HOST}:${MCP_PORT}`);
}

main().catch((error: unknown) => {
  // Print the message only: it names variables or files, never their values.
  console.error(error instanceof Error ? error.message : "startup failed");
  process.exit(1);
});
