# Requirements: Vault core

Status: approved  |  Date: 2026-10-31  |  Spec: docs/specs/01-vault-core/
Baseline: unknown
Approved by: the owner's standing instruction in the build session (2026-10-31): "fusiona el tier c, solo detente si involucra costos, de resto sigue" and "Fusiona y continúa, quiero la versión terminada". No cost items in this feature.
Brief: docs/brief.md  |  ADRs: docs/adr/0005-vault-in-git.md, docs/adr/0006-configuration-driven.md, docs/adr/0007-mcp-auth.md, docs/adr/0008-vault-safety.md, docs/adr/0010-ingest-bearer-token.md, docs/adr/0011-note-write-operations.md, docs/adr/0012-vault-config-mapping.md

## Context
The walking skeleton writes any note to any safe path with no authentication, no validation of frontmatter, no secret scrub and no recovery from git conflicts, so no real source can be connected yet. This feature makes the internal ingest API safe to connect: authenticated callers, notes validated against the owner's own vault conventions, secrets removed before they reach Git history, idempotent and updatable writes, archive instead of delete, and a clone that never stays stuck. Every later feature (MCP, plugin, meetings, capture, routines) writes through this core.

## Users
- n8n workflows and the Claude Code plugin (machine callers on the internal network): create, update and archive notes and get a clear status for every outcome.
- The vault owner: notes land in the right folder with the right properties, secrets never reach the repository, nothing is ever lost.
- A third party installing the product: a default vault template and configuration that work without editing code.

## Out of scope
- Search, read and MCP tools: feature F2 (docs/specs, next spec).
- Alerts by Telegram: feature F6; until then alerts are log lines (brief, open items).
- Semantic dedupe (same idea in different words): docs/v2.md, semantic search.
- Host header allowlist and pinned image digests from #9: they belong to the installer and CI hardening (F4).

## Existing behavior to preserve
- 415 unless the content type is `application/json` (charset allowed): verified by tests/app.test.ts `[unit]`
- 413 above 1 MiB: verified by tests/app.test.ts `[unit]`
- Path rules (relative, `.md`, no dot segments, no control characters, no backslash, drive letter or empty segment, at most 255 characters): verified by tests/app.test.ts and tests/notes.integration.test.ts D5 `[integration]`
- Body stored verbatim and a body cannot forge frontmatter: verified by tests/frontmatter.test.ts and integration D3, D16 `[integration]`
- 409 when creating a path that exists with different content: verified by integration D6 `[integration]`
- GitError redaction (only subcommand and exit code reach logs and responses): verified by integration D19 `[integration]`
- HOST defaults to 127.0.0.1; writes serialized; pull with rebase before each write: verified by tests/start.test.ts and integration D4, D7 `[integration]`

## R1: Authenticated ingest
As the vault owner, I want only callers holding the ingest token to write, so that no other container on the network can change the vault.

- R1.1 When a request to any endpoint other than `GET /health` has no `Authorization: Bearer <token>` header equal to the configured ingest token, the system shall respond 401 `unauthorized` without running any git command. `[unit]`
- R1.2 When `GET /health` is called without a token, the system shall respond 200 `{ "ok": true }`. `[unit]`
- R1.3 If the ingest token is missing or shorter than 32 characters at startup, then the system shall exit with a non-zero code and a message that names the variable and never its value. `[unit]`
- R1.4 The system shall never write the ingest token or the received Authorization header value to a log line or a response body. `[unit]`

## R2: Owner configuration
As a third-party owner, I want my vault's own folder names, property names and note types to drive validation, so that the product fits my vault without code changes.

- R2.1 When `.2brain/config.yaml` is absent, the system shall apply the default configuration shipped in `vault-template/.2brain/config.yaml`. `[unit]`
- R2.2 When the configuration maps a canonical property (`type`, `area`, `date`, `source`, `source_id`) to an owner name, the system shall read and validate that property under the owner name. `[unit]`
- R2.3 If the configuration has an unknown key or a value of the wrong type, then the system shall respond 503 `config_invalid` to write requests, name the file and the key path in the response, and write nothing. `[integration]`
- R2.4 When a pushed commit changes `.2brain/config.yaml`, the system shall apply the new configuration to the next write after its pull, without a restart. `[integration]`

## R3: Validated frontmatter
As the vault owner, I want every new note to carry the properties my vault relies on, so that Bases and search keep working.

- R3.1 If a created note lacks the configured `type`, `area`, `date` or `source` property, then the system shall respond 400 `invalid_frontmatter` listing the missing owner property names, and write nothing. `[unit]`
- R3.2 If the `type` value is not a configured note type, or the `area` value is not a configured area, then the system shall respond 400 `invalid_frontmatter` naming the property. `[unit]`
- R3.3 If the `date` value is not a valid calendar date in `YYYY-MM-DD` form, then the system shall respond 400 `invalid_frontmatter` naming the property. `[unit]`
- R3.4 If the note type declares a folder and the path is not inside that folder (with `{area}` replaced by the note's area), then the system shall respond 400 `wrong_folder` with the expected folder. `[unit]`

## R4: Secret scrub
As the vault owner, I want secrets removed before anything is committed, so that they never enter Git history.

- R4.1 When a note is created or text is appended, the system shall replace every match of a scrub rule in the body and in every string frontmatter value with `[REDACTED:<rule>]` before writing; a path that contains a scrub-rule match is refused with `unsafe_path` and never rewritten. `[unit]`
- R4.2 The scrub rules shall detect private key blocks, AWS access key ids, GitHub tokens, Slack tokens, Anthropic and OpenAI style API keys, Google API keys, Stripe secret keys, JSON Web Tokens, `Authorization: Bearer` values, labeled password, secret, token and API key assignments, card numbers that pass the Luhn check, and IBANs, with 0 misses on the positive fixtures and 0 matches on the negative fixtures (at least one of each per rule). `[unit]`
- R4.3 When a write redacts anything, the system shall return `redactions` as a list of `{ rule, count }` and log only rule names and counts. `[unit]`
- R4.4 If the scrubber fails, then the system shall respond 500 `scrub_failed` and write nothing. `[unit]`

## R5: Idempotent create
As a machine caller, I want retries to be safe, so that a network error never creates duplicates or false conflicts.

- R5.1 When a create targets a path that holds byte-identical content, the system shall respond 200 with `unchanged: true` and make no commit. `[integration]`
- R5.2 If a create carries a `source_id` equal to the `source_id` of another note in the vault, then the system shall respond 409 `duplicate_source` with that note's path and write nothing. `[integration]`

## R6: Update an existing note
As a machine caller, I want to change properties of a note or add text to it, so that people, topics and projects are updated instead of duplicated.

- R6.1 When `PATCH /notes` sets properties on an existing note, the system shall merge them into its frontmatter, validate the result as in R3, commit and push. `[integration]`
- R6.2 When `PATCH /notes` appends text to an existing note, the system shall add it after the current body separated by one blank line, leaving every earlier byte of the body unchanged. `[integration]`
- R6.3 If the note's type is configured with an immutable body, then the system shall reject an append with 409 `immutable_body` while still accepting property changes. `[unit]`
- R6.4 If the note does not exist, then the system shall respond 404 `note_not_found`. `[unit]`
- R6.5 If a property change or append leaves the file identical, then the system shall respond 200 with `unchanged: true` and make no commit. `[unit]`

## R7: Archive instead of delete
As the vault owner, I want removed notes moved to the archive folder, so that nothing is ever lost.

- R7.1 When `POST /notes/archive` names an existing note, the system shall move it to `<archive folder>/<original path>` with its content byte-identical, commit and push, and respond 200 with the new path. `[integration]`
- R7.2 If the note is already inside the archive folder or the target path exists, then the system shall respond 409 and move nothing. `[unit]`
- R7.3 The system shall expose no operation that deletes a vault file. `[unit]`

## R8: Git sync that never sticks
As the vault owner, I want conflicts and push failures handled automatically, so that one bad sync never blocks every later write.

- R8.1 If the pull before a write stops on a rebase conflict, then the system shall abort the rebase, keep each conflicting local version as `<name> (conflict YYYY-MM-DD).md` next to the remote version, commit, push, log the number of conflicting files without names or content, and complete the original request. `[integration]`
- R8.2 When a write follows a conflict, the system shall complete it normally (no rebase left in progress). `[integration]`
- R8.3 If the push fails, then the system shall retry it 3 times with 1 s, 2 s and 4 s waits, and if it still fails respond 502 `push_pending` with the local commit id. `[integration]`
- R8.4 When a write follows a `push_pending`, the system shall push the pending commit together with the new one. `[integration]`
- R8.5 If a note path starts with `:` or contains a character or name that Windows cannot check out (`<>:"|?*`, a segment ending in a dot or space, a reserved device name), then the system shall respond 400 and run no git command. `[unit]`

## R9: Vault template
As a third-party owner, I want a ready vault structure and configuration, so that a new vault works on day one.

- R9.1 The repository shall ship `vault-template/` with a `.2brain/config.yaml` that the configuration schema accepts and a folder for every configured note type. `[unit]`
- R9.2 When `init-vault <dir>` runs on a missing or empty directory, the system shall copy the template there; when files already exist, it shall copy only the missing ones and list the skipped ones. `[integration]`
- R9.3 The template shall contain no owner data (no personal names, domains or emails other than `example.com`). `[unit]`

## R10: Health of the running service
As the operator, I want Docker to know when the service is down, so that a crashed service is visible.

- R10.1 The compose file shall declare a healthcheck that calls `GET /health` inside the container. `[unit]`

## Verification summary
| Tag | Count |
|---|---|
| unit | 23 |
| integration | 12 |
| e2e | 0 |
| eval | 0 |
| manual | 0 |
