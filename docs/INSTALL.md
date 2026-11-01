# Install 2brain

This guide takes you from a fresh Linux host with Docker to a note saved in your vault from
claude.ai. Follow the sections in order. The examples use `brain.example.com`; use your own domain.

Nothing is installed on the host beyond Docker, Compose and git. Setup and the health check run in
the same container image as the service.

## Prerequisites

- A Linux host with Docker Engine.
- Docker Compose 2.24.0 or later. The compose file reads `.env` with `required: false`, and older
  versions reject that. Check with `docker compose version`.
- git.
- A domain name that points at the host, for example `brain.example.com`, and a reverse proxy
  that terminates HTTPS for it (Caddy and nginx examples are below).
- An empty repository on an SSH-capable git host (GitHub, for example) that will hold your vault.
  Create it first and keep its SSH address at hand, such as `git@github.com:your-user/vault.git`.

## Get the code

```bash
git clone <repository URL> 2brain
cd 2brain
```

## Create the Docker network

The service and your reverse proxy talk over a shared Docker network. The default name is `n8n`.
If n8n or your proxy already runs on a network, skip the command and give that network's name
when setup asks for it (it is stored as `N8N_NETWORK`). Otherwise create it:

```bash
docker network create n8n
```

Until this network exists, `docker compose run --rm doctor` and `docker compose up` fail with an
error about a missing external network.

## Run setup

```bash
docker compose run --rm setup
```

Run this before `docker compose up`, so the `secrets/` directory is created with the right owner.
Setup asks, in this order:

1. The vault repository address (SSH form only).
2. The author name for commits.
3. The author email for commits.
4. The public base URL, for example `https://brain.example.com`. Leave it empty to keep MCP off.
5. How many reverse proxies sit in front of the service (normally `1`). Asked only when you gave
   a public base URL.
6. Whether to keep the current passphrase. Asked only when you gave a public base URL and a
   passphrase is already stored.
7. The owner passphrase and a repeat. Nothing is echoed. Use at least 12 characters. Asked only
   when you gave a public base URL and are not keeping the stored passphrase.
8. The Docker network name.
9. A host fingerprint confirmation (only for hosts other than github.com).
10. A pause until you have added the deploy key (next section).

Setup writes `.env` (readable only by you) and a `secrets/` directory, generates the ingest token
and stores only a hash of your passphrase. It never prints the token. It is safe to run again: it
keeps your answers and key, and changes nothing when nothing changed.

For scripted installs, add flags after the service name. To see the flags, give an option setup
does not know:

```bash
docker compose run --rm setup --non-interactive --help
```

It prints one line in this form (without the first two words if you run `node dist/cli.js setup`
directly) and exits with code 2:

```text
setup: missing_answers: usage: node dist/cli.js setup [--project-dir <dir>] [--vault-dir <dir>] | node dist/cli.js setup --non-interactive --remote <git-ssh-url> --author-name <name> --author-email <email> [--public-base-url <url> (--passphrase-stdin | --keep-passphrase)] [--host-fingerprint <SHA256:...>]
```

## Add the deploy key

Setup creates a key pair in `secrets/`, prints the public key and waits. In your vault repository
settings, open Deploy keys, add the printed key and tick the box that allows write access. Then
press Enter in the setup window.

For github.com, setup checks the host key against GitHub's published fingerprint. For any other
host it shows the fingerprint it received. Compare it with the one your host publishes and type
`yes` only if they match.

After the key is accepted, setup clones the vault. If the vault has no configuration yet, it adds
the default template in one commit and pushes it. It finishes with `setup: done`.

## Start the service

```bash
docker compose up -d --build
docker compose ps
```

Wait until `brain` shows as running.

## Proxy

Run your reverse proxy on the same Docker network (`N8N_NETWORK`) and forward the whole public
origin to `brain:3001` over plain HTTP, ending HTTPS at the proxy. Setup already stored
`TRUST_PROXY_HOPS=1` if you answered `1`; change it in `.env` if you chain more proxies.

Forward every path, not only `/mcp`. Sign-in needs all of these:

- `/mcp`
- `/authorize`
- `/token`
- `/register`
- `/revoke`
- `/.well-known/`

See [GUIDE-mcp.md](GUIDE-mcp.md) for what each does.

Caddy:

```caddyfile
brain.example.com {
    reverse_proxy brain:3001
}
```

nginx (add your own certificate lines):

```nginx
server {
    listen 443 ssl;
    server_name brain.example.com;

    location / {
        proxy_pass http://brain:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Reload the proxy after editing its configuration.

## Run doctor

```bash
docker compose run --rm doctor
```

Doctor checks each link from `.env` to your public address, one line per check:

- `pass` means the check succeeded.
- `fail` means it did not, followed by a `fix:` line saying what to do.
- `skip` means the check does not apply. The last three checks (`mcp_internal`, `proxy_metadata`
  and `proxy_mcp`) are skipped while `PUBLIC_BASE_URL` is empty.

The last line is a summary such as `doctor: 0 failed, 11 passed, 0 skipped`. The exit code is 0
when no check failed. Fix any failure using the Troubleshooting section, then run doctor again.

## Connect claude.ai

In claude.ai, add a custom connector and paste `https://brain.example.com/mcp` (the full endpoint,
not the bare domain). A sign-in page of your service opens; enter your owner passphrase. For
Claude Code, Codex and ChatGPT, see [GUIDE-mcp.md](GUIDE-mcp.md).

## Save a first note

In a claude.ai chat that has the connector enabled, ask Claude to save a short test note with
`save_note`. Then open your vault repository and check that a new commit with the note appears.
To capture your Claude Code sessions as notes too, see [GUIDE-plugin.md](GUIDE-plugin.md).

## n8n credential

Workflows in n8n call the ingest API with one shared credential. In n8n, create a credential of
type Header Auth:

- Name: `2brain ingest`
- Header name: `Authorization`
- Header value: `Bearer <INGEST_TOKEN>`

Replace `<INGEST_TOKEN>` with the value of `INGEST_TOKEN` from your `.env` file; setup never prints
it. The ingest URL in your workflows is `http://brain:3000`, which works when n8n is on the same
Docker network.

## Updates

```bash
git pull
docker compose up -d --build
docker compose run --rm doctor
```

Your `.env`, `secrets/` and vault are kept.

## Troubleshooting

Setup prints one line per result in the form `setup: <code>: <fix>`. Doctor prints `fail`, then
the check id after two spaces, then a `fix:` line. Below, each doctor check is listed as
`fail  <id>` with the same two spaces. Find the code or id below.

### Setup codes

- `setup: invalid_answer`: an answer broke a rule, or a directory flag is wrong. Read the field
  named in the message and run setup again.
- `setup: remote_not_ssh`: the vault address must be SSH, such as `git@github.com:owner/repo.git`
  or `ssh://user@host:port/path`. Web addresses and addresses with a password or token are refused.
- `setup: missing_answers`: a non-interactive run lacks answers, or input ended early. The message
  lists what is missing.
- `setup: project_not_writable`: setup cannot write to the project directory. Make the directory
  writable by your user and run setup again. If `secrets/` is owned by root because `brain` started
  first, re-running setup repairs the owner. If the message mentions a lock, a previous setup left
  `secrets/.setup.lock` behind: remove that file when no setup is running, then run setup again.
- `setup: keygen_failed`: the deploy key could not be created, or something in `secrets/` is not a
  plain file. Delete the broken file under `secrets/` and run setup again.
- `setup: host_unreachable`: setup could not fetch the host key within 10 seconds. Check the
  host name, the port and the host's network access.
- `setup: host_key_mismatch`: the host key does not match GitHub's published fingerprint. Do not
  continue; check your network, then run setup again.
- `setup: host_key_rejected`: you did not confirm the fingerprint, or it differs from the one you
  gave. Run setup again and confirm only a fingerprint you have checked.
- `setup: remote_unreachable`: the vault repository could not be reached. Check the address, the
  network and that the repository exists.
- `setup: remote_auth_failed`: the host refused the key. Add `secrets/deploy_key.pub` to the
  repository as a deploy key, with write access, then run setup again.
- `setup: vault_remote_mismatch`: the stored vault clone points at a different address than your
  answer. Use the original address, or move the `vault` volume aside on purpose. A global git
  `insteadOf` rule can also rewrite the address and trigger this on every re-run. Check with
  `git config --global --get-regexp insteadof`.
- `setup: config_invalid`: the vault's `.2brain/config.yaml` is invalid. The message names the
  file and key. Fix it in the vault repository and run setup again.
- `setup: push_refused`: the vault host refused the push. Give the deploy key write access, and
  check for branch protection or a pre-receive hook that blocks it. The seed commit is kept and
  re-running setup pushes it.
- `setup: done`: not an error. Continue with the next section of this guide.

### Doctor checks

- `fail  env`: a variable in `.env` is missing or invalid. The fix line names it. Correct `.env` or
  re-run setup.
- `fail  env_file`: `.env` is missing or readable by others. Run `chmod 600 .env`.
- `fail  secrets`: a file in `secrets/` is missing or too open. Re-run setup, or `chmod 600` the
  files.
- `fail  network`: the name `brain` does not resolve. Create the network with
  `docker network create n8n` (or your `N8N_NETWORK`) and run `docker compose up -d`.
- `fail  remote_reachable`: the vault repository could not be reached. Check the deploy key and the
  host key in `secrets/known_hosts`.
- `fail  remote_pushable`: the deploy key has no write access. Enable write access on the deploy
  key. This check uses `git push --dry-run`, which cannot see branch protection or pre-receive
  hooks, so those refusals appear later as `push_refused` on the first real push.
- `fail  vault_config`: there is no vault clone, or its config is invalid. Fix the file named, or
  re-run setup.
- `fail  ingest_health`: the service does not answer on its internal port. Run `docker compose ps`
  and `docker compose logs brain`.
- `fail  mcp_internal`: the MCP listener does not answer or reports another address. Check
  `PUBLIC_BASE_URL` and the logs.
- `fail  proxy_metadata`: the public address did not serve the sign-in metadata over HTTPS. Check
  the certificate and the proxy rules in the Proxy section. If your host cannot reach its own
  public address from inside a container, run the same request from another machine.
- `fail  proxy_mcp`: the public `/mcp` did not answer 401 without a token. Forward all six paths
  listed in the Proxy section to `brain:3001`.

### Other problems

- Compose says `required` is not allowed or the file is invalid: your Compose is older than 2.24.
  Upgrade it.
- `docker compose run --rm doctor` stops with a missing network error: create the network from
  the "Create the Docker network" section first.
- Doctor itself reports an unexpected error: run it again, and read `docker compose logs brain`.
