# 0017. The installer runs inside the service image through Compose

Status: accepted
Date: 2026-11-01
Related: docs/specs/04-installer/design.md, docs/adr/0001-stack.md, docs/adr/0005-vault-in-git.md, docs/adr/0007-mcp-auth.md
Approved by: pending (the owner, with docs/specs/04-installer/design.md)

## Context
The brief's success signal is that a third party installs from scratch, following only the README,
and saves a note from claude.ai (docs/brief.md, First milestone). Today an install needs Node 24 on
the host (or a `docker compose run` with a hand-made `.env`), a hand-written `.env`, the ingest token
and the passphrase hash made with separate commands, Git credentials set up alone, and a vault seeded
with `init-vault` and pushed by hand (README.md). The target host is a Linux Docker host that
already runs n8n; it may have no Node and no build tools. The service image already holds Node
24, `git`, `ssh-keygen` and `ssh-keyscan` (Dockerfile, `openssh-client`), the vault template and the
CLI (`dist/cli.js`). Git access from the container must not rely on a token inside the remote URL,
because git echoes URLs and the token would live in `.env` with a broad scope.

## Decision
We will ship the installer as a `setup` subcommand of src/cli.ts, plus a `doctor` subcommand, both
run inside the service image through Compose services in a `tools` profile
(`docker compose run --rm setup`, `docker compose run --rm doctor`) with the project directory
bind-mounted, so the host needs only Docker Engine with Compose v2 and git. Setup is idempotent
(re-running keeps existing values unless the owner changes them), prompts on a terminal and has a
non-interactive mode for tests. Git authenticates with an ed25519 deploy key generated into a
git-ignored `secrets/` directory and a pinned `known_hosts`, checked against GitHub's published
fingerprint for `github.com` and confirmed by the owner for other hosts.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Bash script on the host | Depends on host tools and Node for the hash; shell-string handling of secrets; not covered by the Vitest suite or the Biome checks |
| `npx` package | Needs Node 24 and npm on the host and a published package, while the image already has every tool |
| HTTPS remote with a token in the URL | Long-lived credential in `.env`, echoed by git, usually scoped to every repository of the account |
| Bundled reverse proxy (Caddy) | Competes with n8n's proxy for ports 80 and 443 on the reference host; TLS and DNS stay out of scope |
| Interactive steps only in the guide (no installer) | Every owner repeats error-prone secret handling; the success signal needs a short, checkable path |

## Consequences
- Positive: one tested code path in TypeScript with the same validation as startup (`loadEnv`,
  `hashPassphrase`, `loadVaultConfig`); the host needs nothing beyond Docker, Compose and git; the
  deploy key reaches only the vault repository; `doctor` gives a repeatable check after updates.
- Negative: files created in the bind mount must have owners that both the host user and the
  container's `node` user (uid 1000) can work with; `env_file` with `required: false` needs
  Compose 2.24.0 or later; the image is built before setup can run, which takes a few minutes on a
  small host.
- Revisit when: published container images exist (docs/v2.md), installs on hosts without Docker
  are requested, or a Git host other than GitHub becomes the common case and needs its own pinned
  fingerprint.
