# 2brain-logic

A self-feeding second brain. Meetings, emails, ideas and AI work sessions land as Markdown notes
in an Obsidian vault stored in Git. This repository is the service that writes them: today a
walking skeleton with one thin slice (`GET /health` and `POST /notes`) from HTTP to a pushed commit.

Product context: [docs/brief.md](docs/brief.md). Decisions: [docs/adr/](docs/adr/).

## Run locally

Requires Node 24 (see `.nvmrc`), git, and a Git repository that holds your vault.

```bash
npm ci
cp .env.example .env   # then set VAULT_REMOTE, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL and INGEST_TOKEN
npm start
```

`npm start` builds, clones `VAULT_REMOTE` into `VAULT_DIR` when `VAULT_DIR` is not a git repository yet (the
directory must be missing or empty, or the clone fails), and listens on
`127.0.0.1:3000` (loopback only; set `HOST` to change it).

```bash
curl http://127.0.0.1:3000/health
# {"ok":true}

curl -X POST http://127.0.0.1:3000/notes \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"path":"inbox/hello.md","frontmatter":{"type":"idea","area":"personal","date":"2026-10-31","source":"manual","title":"Hello"},"body":"First note.\n"}'
# {"ok":true,"path":"inbox/hello.md","commit":"<sha>"}
```

`POST /notes` pulls with rebase, reads the vault config, validates the frontmatter and the path
against it, writes the file, commits as `GIT_AUTHOR_NAME <GIT_AUTHOR_EMAIL>` and pushes. Every route
except `GET /health` needs `Authorization: Bearer <INGEST_TOKEN>`; without it the answer is 401
`unauthorized` and nothing is written. It answers 400 for a bad body or path, 401 for a missing or
wrong token, 409 when the path already exists (it never overwrites), 413 for a body over 1 MB, 415
unless the content type is `application/json`, 500 when git fails, and 503 `config_invalid` when
the vault's `.2brain/config.yaml` is invalid (the body names only the file and the key:
`{"ok":false,"error":"config_invalid","file":".2brain/config.yaml","keyPath":"..."}`).

A note needs the four canonical properties (`type`, `area`, `date`, `source` by default; the vault
config can rename them). `type` must be one of the configured type values, `area` one of the
configured areas, `date` a real calendar date as `YYYY-MM-DD`, and `source` a non-empty string
(one of the configured sources when the config lists any). A note that fails answers 400
`invalid_frontmatter` with the property names that are absent in `missing` and the ones with a
rejected value in `invalid`: `{"ok":false,"error":"invalid_frontmatter","missing":[...],"invalid":[...]}`.
When the type has a folder in the config (`{area}` is replaced by the note's area), the path must be
inside it, or the answer is 400 `wrong_folder` with `{"ok":false,"error":"wrong_folder","expected":"<folder>"}`.
A type without a folder accepts any safe path. The answers carry only property names and the
configured folder, the log line only the code, and nothing is written. The default type folders are listed in
`vault-template/.2brain/config.yaml`.
Each write reads the vault config right after the pull, so a config change pushed from another
clone applies to the next write without a restart.

> **Do not connect real n8n flows to `/notes` yet.** The endpoint requires the ingest token
> ([ADR 0010](docs/adr/0010-ingest-bearer-token.md)) but still has no secret scrubbing (it arrives
> with the vault safety work in [ADR 0008](docs/adr/0008-vault-safety.md)). Until then, use it only
> with a throwaway vault.

SSH remotes: pin the host key in `known_hosts` and never use `StrictHostKeyChecking=no`.

## Configuration

Environment variables (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `VAULT_DIR` | Directory of the vault clone. Required. |
| `VAULT_REMOTE` | Repository to clone when `VAULT_DIR` is not a repository yet. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Identity on commits. Required. |
| `INGEST_TOKEN` | Required, at least 32 characters; the service exits at startup without it. Every request except `GET /health` must send it as `Authorization: Bearer <token>`; the value is compared exactly, so do not pad it with spaces. |
| `PORT` | Listening port. Default `3000`. |
| `HOST` | Listening address. Default `127.0.0.1`. |
| `ANTHROPIC_API_KEY` | Listed for later work; the skeleton does not read it. |
| `N8N_NETWORK` | Compose only: name of the external Docker network. Default `n8n`. |

The vault holds its own settings in `.2brain/config.yaml` (format version 1): the archive and
inbox folders (`vault.archive_folder`, default `archive`; `vault.inbox_folder`, default `inbox`),
the owner's names for the canonical properties (`properties`), the areas (`areas`), an optional
allow-list of sources (`sources`) and the note types with their stored value, folder and body rule
(`types`). Every key is optional and a missing key takes its default; a section you write under
`areas` or `types` replaces the default one, while `vault` and `properties` fill the keys you
leave out. The file is strict: an unknown key, a wrong type or an unsafe folder or area name (a
`..` segment, an absolute path, a backslash) is an error that names the file and the key.

The service reads the file again after every pull, inside the write queue, so you edit the config
from any clone and push it; there is no restart and no cache. An invalid file does not stop the
service: it logs `config_invalid` with the file and the key, `GET /health` keeps answering, and
every write answers 503 until a fixing commit reaches the remote.

`vault-template/` is the default vault: a ready `.2brain/config.yaml` with the default values, and
a `README.md` in every folder the config names (git does not track empty folders). Seed a vault
with `node dist/cli.js init-vault <dir>` (run `npm run build` first). It copies each template file
the directory does not have yet, never overwrites a file, and lists the copied and the skipped
files. It does not run git: commit and push the result yourself.

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
