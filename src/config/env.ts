import { z } from "zod";

const EnvSchema = z.object({
  VAULT_DIR: z.string().min(1),
  VAULT_REMOTE: z.string().min(1).optional(),
  GIT_AUTHOR_NAME: z.string().min(1),
  GIT_AUTHOR_EMAIL: z.email(),
  INGEST_TOKEN: z.string().min(32),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Read the service environment. Errors name the variables, never their values.
 * INGEST_TOKEN is required and at least 32 characters; it is taken as given, not trimmed.
 * ANTHROPIC_API_KEY is deliberately not read: nothing in the skeleton calls a real model.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  // An empty value in .env (`VAULT_REMOTE=`) means "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid environment: ${problems.join("; ")}`);
  }
  return parsed.data;
}
