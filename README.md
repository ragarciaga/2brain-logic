# 2brain-logic

A self-feeding second brain. Meetings, emails, ideas and AI work sessions land as Markdown notes
in an Obsidian vault stored in Git. This repository is the service that writes them: today a
walking skeleton with one thin slice (`GET /health`, `POST /notes` and `PATCH /notes`) from HTTP to a pushed commit.

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
against it, scrubs secrets from the frontmatter and the body (each match is stored as
`[REDACTED:<rule>]`; a path that contains a scrub-rule match is refused with 400 `unsafe_path`
and never rewritten), validates the scrubbed frontmatter again, writes the file, commits as `GIT_AUTHOR_NAME <GIT_AUTHOR_EMAIL>` and pushes. Every route
except `GET /health` needs `Authorization: Bearer <INGEST_TOKEN>`; without it the answer is 401
`unauthorized` and nothing is written. It answers 400 for a bad body or path, 401 for a missing or
wrong token, 409 `note_exists` when the path already holds different content (it never overwrites), 409 `duplicate_source` when another note already has the same `source_id`, 413 for a body over 1 MB, 415
unless the content type is `application/json`, 500 when git fails, 502 `push_pending` when the commit is made but the push does not land
(`{"ok":false,"error":"push_pending","path":"...","commit":"<local sha>"}`), 500 `scrub_failed` when the
scrub cannot finish (nothing is written), and 503 `config_invalid` when
the vault's `.2brain/config.yaml` is invalid (the body names only the file and the key:
`{"ok":false,"error":"config_invalid","file":".2brain/config.yaml","keyPath":"..."}`).

`PATCH /notes` sets properties of an existing note: `{"path":"inbox/hello.md","set":{"title":"New"}}`.
It runs through the same queue, pull, config reload, validation, scrub and retrying push as a
create. The `set` keys replace the same top-level keys of the frontmatter (a nested object replaces
the whole value, `null` sets null, nothing is removed) and the other keys are kept; the result is
validated like a create (400 `invalid_frontmatter`, 400 `wrong_folder`). The body is kept byte for
byte. Only the incoming `set` values are scrubbed (stored text is never rewritten), and the 200 body
carries `redactions` as for a create. A change rewrites the frontmatter block (comments and quoting
are lost; unquoted dates such as `2026-10-31` stay text) and commits `2brain: update <path>`; the
answer is 200 `{"ok":true,"path":"...","commit":"<sha>"}`. If every value in `set` already equals the
stored one, the file is not touched and the answer is 200 `{"ok":true,"path":"...","commit":null,"unchanged":true}`
(pushing only when the branch is ahead). A missing path, or a directory there, is 404 `note_not_found`; a
symlink, or a parent directory that leaves the vault, is 400 `unsafe_path`; a stored note whose
frontmatter cannot be read is 400 `invalid_frontmatter` with empty lists; giving `source_id` the
value of another note is 409 `duplicate_source`. A body with anything but `path` and `set` (`append`
included) is 400 `invalid_body`. The other statuses are those of `POST /notes`.

When the scrub redacted anything, the 201 body also carries `"redactions":[{"rule":"<id>","count":<n>}]`
(rule ids and counts only, sorted by rule id) and the service logs one `redacted: <rule>=<count>` line (several pairs are joined with ", " on that one line);
without redactions the key is absent.

A create is idempotent. If the path already holds a regular file whose bytes equal what this
request would store (compared after the scrub), the answer is 200
`{"ok":true,"path":"...","commit":null,"unchanged":true}` (with `redactions` when the scrub changed
something), with no commit. It pushes only when the branch is ahead of its upstream (a commit left
pending by an earlier `push_pending`), and if that push fails the answer is 502 `push_pending` with
HEAD. An identical file that git does not track yet (the process died between writing and
committing) is committed and pushed like a create, answering 201. Other content at that path is 409 `note_exists`. At a free
path, a `source_id` (the property name comes from the vault config) that another note already has
is 409 `{"ok":false,"error":"duplicate_source","path":"<path of that note>"}` and nothing is
written; a number and its string form count as the same id. The service finds the other note by
reading the frontmatter of the `.md` files in the vault (not dot folders or symlinks), keeps the
result per git HEAD, and answers 500 `write_failed` if the vault is larger than its fixed limits.
A `source_id` that the scrub redacts becomes `[REDACTED:<rule>]`, so two different redacted ids can
collide as `duplicate_source`. If the commit fails before HEAD moves, the new file is unstaged and
removed so the retry starts clean.

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

If the pull before a write stops on a rebase conflict, the service aborts the rebase and keeps both
versions. The remote version stays at its path and each conflicting local version is added next to
it as `<name> (conflict YYYY-MM-DD).md` (the date is the UTC day; a taken name gets ` 2`, ` 3`, ...
inside the parentheses, so nothing is overwritten). The copy goes through the secret scrub like any
note. Everything is committed once as `2brain: keep conflicting versions (<n> files)`; the push of that commit is one attempt that may
fail, because the push at the end of the request delivers it. The service logs `conflicts_kept: <n>` (a count, never names or content), and the original request
then goes on. The local commits are squashed into that one commit. If both versions carry the same
`source_id`, a create with that id at a new path answers 409 `duplicate_source` naming the copy that
sorts first. A pull failure that is not a rebase conflict is still 500 `write_failed`.
If the process died in the middle of that rebuild, the next write puts the vault back at the
commit it had before (a local ref `refs/2brain/rebuild-local` holds it), logs `rebuild_recovered`
and rebuilds again; no version is lost.

A push that fails is retried 3 times, after 1 s, 2 s and 4 s. A push rejected because the remote
moved (git exit 1) is not retried: the answer is 502 `push_pending` at once, and the next write
pulls, rebases and pushes the pending commit with its own. A push that never lands gives the same
502 with the local commit id; the commit stays in the vault and is pushed by the next write. The
body and the log carry no remote URL.

> **Do not connect real n8n flows to `/notes` yet.** The endpoint requires the ingest token
> ([ADR 0010](docs/adr/0010-ingest-bearer-token.md)) and scrubs secrets on create and a retry of
> the same request is idempotent, and a rebase conflict keeps both versions, and a failed push
> is retried, but this is still an early version. Use it only with a throwaway vault.

SSH remotes: pin the host key in `known_hosts` and never use `StrictHostKeyChecking=no`.

## Configuration

Environment variables (see `.env.example`):

| Variable                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VAULT_DIR`                           | Directory of the vault clone. Required.                                                                                                                                                                                                                                                                                                                                                                                  |
| `VAULT_REMOTE`                        | Repository to clone when `VAULT_DIR` is not a repository yet.                                                                                                                                                                                                                                                                                                                                                            |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Identity on commits. Required.                                                                                                                                                                                                                                                                                                                                                                                           |
| `INGEST_TOKEN`                        | Required, at least 32 characters; the service exits at startup without it. Every request except `GET /health` must send it as `Authorization: Bearer <token>`; the value is compared exactly, so do not pad it with spaces.                                                                                                                                                                                              |
| `PORT`                                | Listening port. Default `3000`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `HOST`                                | Listening address. Default `127.0.0.1`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PUBLIC_BASE_URL`                     | Origin of the public MCP endpoint (https, or http for `localhost` or `127.0.0.1`; no path, query or credentials). Empty or unset: MCP stays disabled and the five variables below are not read.                                                                                                                                                                                                                          |
| `OWNER_PASSPHRASE_HASH`               | Required when `PUBLIC_BASE_URL` is set: `scrypt$N$r$p$salt$key` (16 byte salt and 32 byte key in base64url; N a power of two from 2^14 to 2^20 and below 2^(16r), r 1 to 32, p 1 to 16, and one scrypt call within 64 MiB: 128 * r * (N + 2 + p) bytes). Create it with `node dist/cli.js hash-passphrase`, which reads the passphrase (12 characters or more) from standard input. Quote it in `.env`, it contains `$`. |
| `MCP_PORT`                            | Port of the MCP listener. Default `3001`.                                                                                                                                                                                                                                                                                                                                                                                |
| `AUTH_STORE_DIR`                      | Directory for the OAuth state. Default `/data/auth`. Must not be inside `VAULT_DIR`.                                                                                                                                                                                                                                                                                                                                     |
| `TRUST_PROXY_HOPS`                    | Number of reverse proxies in front of the service. Default `0`.                                                                                                                                                                                                                                                                                                                                                          |
| `ALLOWED_REDIRECT_HOSTS`              | Comma separated bare host names an OAuth client may redirect to. Default `claude.ai,claude.com,chatgpt.com`.                                                                                                                                                                                                                                                                                                             |
| `ANTHROPIC_API_KEY`                   | Listed for later work; the skeleton does not read it.                                                                                                                                                                                                                                                                                                                                                                    |
| `N8N_NETWORK`                         | Compose only: name of the external Docker network. Default `n8n`.                                                                                                                                                                                                                                                                                                                                                        |

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
ports, so only containers on that network can reach it, including the public MCP app on
`MCP_PORT`. The memory limit is 512 MB, and the image caps the V8 heap at 192 MB through
`NODE_OPTIONS=--max-old-space-size=192`. Compose overrides `VAULT_DIR` to `/data/vault` (a named
volume), `AUTH_STORE_DIR` to `/data/auth` (a second named volume, `auth`, so OAuth tokens survive
a restart and stay out of the vault repository) and `HOST` to `0.0.0.0` inside the container.
The image creates `/data/auth` owned by `node` with mode 0700; the store refuses a directory
writable by others. Do not bind mount a vault subfolder at `/data/auth`: the container cannot
detect that, and the OAuth state would be committed with the vault. The image includes git and ripgrep, and the default vault template, so
`node dist/cli.js init-vault <dir>` works inside the container.

Compose runs a healthcheck every 30 seconds: `node` inside the container sends `GET /health` to
`127.0.0.1` on `PORT` (default 3000), with no token. The container shows as `unhealthy` after
three failed checks, once a 15 second start period has passed.

## Develop

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run evals   # offline, mock provider only; not part of CI yet
```
