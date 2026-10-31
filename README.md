# 2brain-logic

A self-feeding second brain. Meetings, emails, ideas and AI work sessions land as Markdown notes
in an Obsidian vault stored in Git. This repository is the service that writes them: today a
walking skeleton with one thin slice (`GET /health` and `POST /notes`) from HTTP to a pushed commit.

Product context: [docs/brief.md](docs/brief.md). Decisions: [docs/adr/](docs/adr/).

## Run locally

Requires Node 24 (see `.nvmrc`), git, and a Git repository that holds your vault.

```bash
npm ci
cp .env.example .env   # then set VAULT_REMOTE, GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
npm start
```

`npm start` builds, clones `VAULT_REMOTE` into `VAULT_DIR` when it is empty, and listens on
`127.0.0.1:3000` (loopback only; set `HOST` to change it).

```bash
curl http://127.0.0.1:3000/health
# {"ok":true}

curl -X POST http://127.0.0.1:3000/notes \
  -H 'content-type: application/json' \
  -d '{"path":"Inbox/hello.md","frontmatter":{"title":"Hello"},"body":"First note.\n"}'
# {"ok":true,"path":"Inbox/hello.md","commit":"<sha>"}
```

`POST /notes` pulls with rebase, writes the file, commits as `GIT_AUTHOR_NAME <GIT_AUTHOR_EMAIL>`
and pushes. It answers 400 for a bad body or path, 409 when the path already exists (it never
overwrites), 415 unless the content type is `application/json`, and 500 when git fails.

> **Do not connect real n8n flows to `/notes` yet.** The endpoint has no authentication and no
> secret scrubbing (both arrive with the vault safety work in
> [ADR 0008](docs/adr/0008-vault-safety.md)). Until then, use it only with a throwaway vault.

SSH remotes: pin the host key in `known_hosts` and never use `StrictHostKeyChecking=no`.

## Configuration

Environment variables (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `VAULT_DIR` | Directory of the vault clone. Required. |
| `VAULT_REMOTE` | Repository to clone when `VAULT_DIR` is not a repository yet. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Identity on commits. Required. |
| `PORT` | Listening port. Default `3000`. |
| `HOST` | Listening address. Default `127.0.0.1`. |
| `ANTHROPIC_API_KEY` | Listed for later work; the skeleton does not read it. |
| `N8N_NETWORK` | Compose only: name of the external Docker network. Default `n8n`. |

The vault may hold `.2brain/config.yaml`; today only `vault.archive_folder` (default `Archive`)
is read.

## Docker

```bash
cp .env.example .env            # set the variables above
docker network create n8n       # once, unless n8n already runs on a network of that name
docker compose up --build
```

The service joins the external network named by `N8N_NETWORK` (default `n8n`) and publishes no
ports, so only containers on that network can reach it. The memory limit is 512 MB. Compose
overrides `VAULT_DIR` to `/data/vault` (a named volume) and `HOST` to `0.0.0.0` inside the
container. The image includes git and ripgrep.

## Develop

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run evals   # offline, mock provider only; not part of CI yet
```
