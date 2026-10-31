import { loadEnv } from "./config/env.js";
import { loadVaultConfig } from "./config/vault-config.js";
import { defaultGit, ensureClone } from "./git/index.js";
import { createApp } from "./server/app.js";
import { startServer } from "./server/start.js";
import { createNoteWriter } from "./vault/write-note.js";

async function main(): Promise<void> {
  const env = loadEnv();
  await ensureClone(env.VAULT_DIR, env.VAULT_REMOTE);
  const config = await loadVaultConfig(env.VAULT_DIR);
  const writer = createNoteWriter({
    vaultDir: env.VAULT_DIR,
    author: { name: env.GIT_AUTHOR_NAME, email: env.GIT_AUTHOR_EMAIL },
    git: defaultGit,
  });
  const app = createApp({ writer, ingestToken: env.INGEST_TOKEN });
  await startServer(app, { host: env.HOST, port: env.PORT });
  console.log(
    `2brain listening on ${env.HOST}:${env.PORT} (archive folder: ${config.vault.archive_folder})`,
  );
}

main().catch((error: unknown) => {
  // Print the message only: it names variables or files, never their values.
  console.error(error instanceof Error ? error.message : "startup failed");
  process.exit(1);
});
