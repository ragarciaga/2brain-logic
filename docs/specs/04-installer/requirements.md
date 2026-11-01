# Requirements: Installer

Status: approved  |  Date: 2026-11-01  |  Spec: docs/specs/04-installer/
Baseline: unknown
Brief: docs/brief.md  |  ADRs: docs/adr/0017-installer-runs-in-the-container.md (proposed), docs/adr/0005-vault-in-git.md, docs/adr/0007-mcp-auth.md, docs/adr/0010-ingest-bearer-token.md, docs/adr/0015-public-mcp-app.md

## Context
Today a new owner writes `.env` by hand, generates the ingest token and the passphrase hash with
separate commands, sets up Git credentials alone and seeds and pushes the vault themselves
(README.md). This feature ships `setup` and `doctor`, two service CLI subcommands that run inside
the service image through Compose, and one linear install guide. It is core journey 3 of the
brief and ends in journey 1, the brief's success signal: a third party installs from scratch,
following only the README, and saves a note from claude.ai. It makes no LLM call.

## Users
- A third party installing the product: has a Linux Docker host, n8n, a domain and a vault
  repository; answers prompts and adds one deploy key.
- The owner after an update or a problem: runs `doctor` and gets a fix for every failed check.

## Out of scope
- Installing Docker, n8n, DNS or TLS certificates: the target host already runs n8n and a proxy.
- Windows or macOS hosts for the service: the reference and target hosts are Linux Docker hosts.
- A bundled reverse proxy: the reference install shares n8n's Caddy; the guide ships snippets.
- Deploying from CI to anyone's server: hard non-goal (AGENTS.md, Out of scope).
- The n8n workflow templates: features F5 to F7.
- Several owners per install: one owner per install (brief, Security and data).
- A Git credential inside the remote URL (token in URL): not offered (ADR 0017).

## R1: Setup writes a valid .env
As a third party installing the product, I want one command to write my `.env`, so that I never
hand-edit secrets or generate them with separate commands.

- R1.1 When setup runs on a terminal, the system shall ask, in order, for the vault remote, the author
  name, the author email, the public base URL, the proxy hop count and the passphrase (both only when
  a base URL is given) and the Docker network name, showing the current or default value for every
  answer except the passphrase. `[unit]`
- R1.2 When setup finishes, the system shall have written `.env` with `VAULT_REMOTE`, `GIT_AUTHOR_NAME`,
  `GIT_AUTHOR_EMAIL`, `INGEST_TOKEN`, `PUBLIC_BASE_URL`, `OWNER_PASSPHRASE_HASH`, `TRUST_PROXY_HOPS`
  and `N8N_NETWORK`, which the service's startup environment rules accept. `[unit]`
- R1.3 When `.env` has no `INGEST_TOKEN`, the system shall generate one from 32 random bytes as
  base64url (43 characters). `[unit]`
- R1.4 The system shall read the passphrase twice without echo and store only its scrypt hash, in
  single quotes. `[unit]`
- R1.5 The system shall write `.env` with mode 0600 through a temporary file in the same directory
  renamed over the old one. `[integration]`
- R1.6 The system shall never print a value of `INGEST_TOKEN`, `OWNER_PASSPHRASE_HASH` or the
  passphrase. `[unit]`
- R1.7 If `.env` already exists, then the system shall keep every existing value unless the owner
  gives a new answer for it, and keep the lines it does not manage unchanged. `[unit]`
- R1.8 When setup runs again and every answer keeps its value, the system shall leave `.env`
  byte-identical. `[integration]`
- R1.9 If an answer is invalid (email, https origin, whole-number hop count, Docker network name,
  passphrase of 12 characters or more, both passphrase entries equal), then the system shall name
  the field and the rule without the value and ask again. `[unit]`
- R1.10 If the vault remote is not an SSH URL (`git@host:path`, `ssh://user@host[:port]/path`) or
  carries a password or token, then the system shall refuse it with `remote_not_ssh` and store none
  of it. `[unit]`
- R1.11 Where non-interactive mode is selected, the system shall take answers from flags and the
  passphrase only from standard input, and exit 2 naming the missing answers, writing nothing, when
  a required one is absent. `[unit]`
- R1.12 If an answer is invalid in non-interactive mode, then the system shall exit 1 naming the field
  and the rule, writing nothing. `[unit]`

## R2: Deploy key and pinned host key
As a third party installing the product, I want a key that reaches only my vault and a pinned host
key, so that the service pushes safely without a personal token.

- R2.1 When the secrets directory holds no deploy key, the system shall generate an ed25519 key pair
  without passphrase as `secrets/deploy_key` (mode 0600, directory 0700) and `.pub`. `[integration]`
- R2.2 If a deploy key already exists, then the system shall keep it and generate none. `[unit]`
- R2.3 When the key is ready, the system shall print the public key and the steps to add it to the
  vault repository as a deploy key with write access, and on a terminal wait for confirmation. `[unit]`
- R2.4 When the remote host is `github.com`, the system shall pin its ed25519 key only if the key's
  SHA256 fingerprint equals GitHub's published one. `[unit]`
- R2.5 If the `github.com` fingerprint differs, then the system shall exit 1 with `host_key_mismatch`,
  print the seen and expected fingerprints and write no known hosts file. `[unit]`
- R2.6 When the remote host is another host, the system shall show its fingerprint and pin it only
  after the owner types `yes`, or, non-interactive, when `--host-fingerprint` equals it. `[unit]`
- R2.7 If the owner does not confirm the fingerprint, then the system shall exit 1 with
  `host_key_rejected` and write no known hosts file. `[unit]`
- R2.8 The system shall write the known hosts file (mode 0600) with only the pinned key of the
  remote host and port. `[unit]`
- R2.9 Every SSH connection of setup, doctor and the service shall use only the deploy key, the
  pinned known hosts file, strict host key checking and batch mode, and no file of this feature
  shall turn host key checking off. `[unit]`
- R2.10 If the host key cannot be fetched within 10 seconds, then the system shall exit 1 with
  `host_unreachable` and a fix line. `[unit]`

## R3: Vault bootstrap
As a third party installing the product, I want setup to prepare my vault repository, so that the
service starts on a valid vault whether the repository is new or already in use.

- R3.1 When the vault directory holds no clone, the system shall clone the remote into it.
  `[integration]`
- R3.2 When the remote has no commit, the system shall copy the vault template, commit it as the
  configured author with the message `2brain: seed vault template` and push it to `main`. `[integration]`
- R3.3 When the clone has commits but no `.2brain/config.yaml`, the system shall copy only the missing
  template files, commit them with the same message and push. `[integration]`
- R3.4 When the clone has a valid `.2brain/config.yaml`, the system shall change no file and make no
  commit. `[integration]`
- R3.5 If the existing config is invalid, then the system shall exit 1 with `config_invalid` naming the
  file and the key path, making no commit. `[integration]`
- R3.6 If the push is refused, then the system shall exit 1 with `push_refused` and the deploy key
  write access fix, and a re-run shall push the kept commit. `[integration]`
- R3.7 If the remote cannot be reached or refuses the key, then the system shall exit 1 with
  `remote_unreachable` or `remote_auth_failed` and a fix line, printing no git output. `[unit]`
- R3.8 If the vault directory holds a clone of another origin, then the system shall exit 1 with
  `vault_remote_mismatch` and change nothing. `[integration]`

## R4: Doctor
As the owner, I want one command that checks the whole install and says how to fix what is wrong,
so that I find a broken step without reading logs.

- R4.1 When doctor runs, the system shall run the checks `env`, `env_file`, `secrets`, `network`,
  `remote_reachable`, `remote_pushable`, `vault_config`, `ingest_health`, `mcp_internal`,
  `proxy_metadata`, `proxy_mcp` in order, printing per check its id, `pass`, `fail` or `skip`, and
  for a failure one fix line. `[unit]`
- R4.2 The system shall exit 0 when no check failed and 1 when any failed. `[unit]`
- R4.3 If `.env` breaks the service's startup rules, then `env` shall fail naming the variables, never
  their values. `[unit]`
- R4.4 If `.env` or a secrets file is readable or writable by group or others, then `env_file` or
  `secrets` shall fail. `[unit]`
- R4.5 If the service host name does not resolve on the Docker network, then `network` shall fail
  with the network create and `docker compose up -d` fix. `[unit]`
- R4.6 If the remote does not list its refs within 15 seconds, then `remote_reachable` shall fail.
  `[integration]`
- R4.7 If a dry-run push is refused, then `remote_pushable` shall fail with the write access fix.
  `[integration]`
- R4.8 If the vault clone is missing or its config is invalid, then `vault_config` shall fail naming
  the file and the key path. `[integration]`
- R4.9 If `GET /health` on the ingest port does not answer 200 within 5 seconds, then
  `ingest_health` shall fail. `[integration]`
- R4.10 While `PUBLIC_BASE_URL` is empty, the system shall report `mcp_internal`, `proxy_metadata` and
  `proxy_mcp` as `skip` with a note that claude.ai cannot connect. `[unit]`
- R4.11 When `PUBLIC_BASE_URL` is set, `proxy_metadata` shall pass only when the authorization server
  metadata fetched over https through the public origin answers 200 with an issuer equal to
  `PUBLIC_BASE_URL`. `[integration]`
- R4.12 If the proxy does not forward to the service (TLS error, non-200, another issuer, redirect to
  http), then `proxy_metadata` shall fail with a fix pointing to the guide's proxy section. `[integration]`
- R4.13 If `<PUBLIC_BASE_URL>/mcp` without a token answers anything but 401, then `proxy_mcp` shall
  fail listing the paths the proxy must forward. `[integration]`
- R4.14 Doctor output shall contain no secret value and no remote credential. `[unit]`
- R4.15 Doctor shall change no file in the project, the secrets directory or the vault, and push
  nothing. `[integration]`

## R5: Compose wiring
As a third party installing the product, I want setup and doctor to run with Docker alone, so that
the host needs only Docker Engine, Compose v2 and git.

- R5.1 The compose file shall define `setup` and `doctor` services built from the service image, in a
  profile that `docker compose up` does not start. `[unit]`
- R5.2 The `setup` service shall bind-mount only the project directory and the vault volume. `[unit]`
- R5.3 The `brain` and `doctor` services shall mount the secrets directory read-only. `[unit]`
- R5.4 The `brain`, `setup` and `doctor` services shall give git an SSH command with the deploy key,
  `IdentitiesOnly=yes`, the pinned known hosts file, `StrictHostKeyChecking=yes` and `BatchMode=yes`.
  `[unit]`
- R5.5 The `doctor` service shall join the network named by `N8N_NETWORK`. `[unit]`
- R5.6 The secrets directory shall be ignored by git and by the Docker build context. `[unit]`
- R5.7 When `docker compose run --rm setup` runs on a host with no `.env`, it shall start. `[manual]`
  (reason: needs Docker Engine and Compose; CI only builds the image)
- R5.8 If the Docker network does not exist, then `docker compose run --rm doctor` shall stop with
  Compose's network error, and the guide shall give the command that creates it. `[manual]` (reason:
  same as R5.7)

## R6: Install guide and README
As a third party installing the product, I want one guide from a fresh host to a saved note, so that
I follow a single path.

- R6.1 The system shall provide `docs/INSTALL.md` with, in order: prerequisites, code, network, setup,
  deploy key, start, proxy, doctor, claude.ai, first note, n8n credential, updates, troubleshooting,
  linking docs/GUIDE-mcp.md and docs/GUIDE-plugin.md. `[unit]`
- R6.2 The guide shall hold a Caddy and an nginx snippet forwarding every path that docs/GUIDE-mcp.md
  lists to the service on `MCP_PORT`. `[unit]`
- R6.3 The guide shall explain the n8n Header Auth credential for the ingest token, with the credential
  name the future templates use and the internal ingest URL. `[unit]`
- R6.4 The guide shall give the update steps `git pull`, `docker compose up -d --build`, doctor. `[unit]`
- R6.5 The README shall have an Install section pointing to docs/INSTALL.md and no longer carry the
  warning about real n8n flows and a throwaway vault. `[unit]`
- R6.6 The guide and the README shall contain no owner data and no em dash character. `[unit]`
- R6.7 When a third party follows only the README and docs/INSTALL.md on a fresh Linux host and saves
  a note from claude.ai, the note shall appear as a commit in their vault repository. `[manual]`
  (reason: needs a fresh host, a domain, a proxy and a claude.ai account; run once before release)
- R6.8 When doctor runs on the reference install, every check shall pass. `[manual]` (reason: needs
  the owner's server)

## R7: Preserve existing behavior
As the owner, I want the installer to keep every guarantee the service gives, so that installing
does not weaken it.

- R7.1 `init-vault` shall never overwrite a file and shall list copied and skipped files
  (tests/cli.integration.test.ts). `[integration]`
- R7.2 Environment errors shall name variables, never values (tests/env.test.ts). `[unit]`
- R7.3 While `PUBLIC_BASE_URL` is empty, the service shall start with MCP disabled
  (tests/start.test.ts). `[integration]`
- R7.4 No service in the compose file shall publish a host port (tests/compose.test.ts). `[unit]`
- R7.5 `hash-passphrase` shall keep refusing a terminal and printing only the hash
  (tests/cli.integration.test.ts). `[unit]`
- R7.6 Setup and doctor shall make no LLM call and contact only the Git host, the public origin and
  the service. `[unit]`

## Verification summary
| Tag | Count |
|---|---|
| unit | 43 |
| integration | 20 |
| e2e | 0 |
| eval | 0 |
| manual | 4 |
