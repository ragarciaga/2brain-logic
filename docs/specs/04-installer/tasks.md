# Tasks: Installer
Spec: docs/specs/04-installer/  |  Status: approved  |  Converged: 2026-11-01, 1 round

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
Builds on F1 to F3 (merged): no skeleton task. Order: the git additions, the pure installer modules (answers, env file, prompts, SSH), the vault
bootstrap, the setup command, doctor (core, local checks, git checks, HTTP checks, command), the
compose and ignore-file wiring, the docs, and last the manual checks on a Docker host.
Tier C tasks named by design.md Risk and cost stay alone: T19 and T20
(compose.yaml, .env.example, .gitignore, .dockerignore). Dockerfile needs no change (openssh-client
already ships ssh-keygen and ssh-keyscan); T20 only asserts that, and any task that finds it must
change the Dockerfile stops and escalates instead of editing it.
All installer code takes injected io, runner, resolver and fetch so unit tests need no TTY, no
network and no ssh binaries. Integration git tests use a local bare repository addressed by its
path through tests/helpers/git-fixture.ts (not `file://`, no sshd). No task calls a model.
Manual criteria are grouped by what the owner runs in one sitting (T23, T24), each an
`rb:needs-local` issue that needs the owner's Docker host.
-->

## T1: Add the git functions the installer needs, with exit-code mapping
- Purpose: setup and doctor can clone, list refs, dry-run push, push a branch and read the origin through `runGit`, and every remote failure maps to a fixed code without git output
- Covers: R3.7
- Size: M
- Depends on: none
- Files: src/git/index.ts, tests/git.test.ts, tests/git-install.integration.test.ts
- Verify: `npm test -- tests/git.test.ts tests/git-install.integration.test.ts`; `npm run typecheck`; `npm run lint`; `RunOptions` gains `timeoutMs` (passed to `execFile` `timeout`; a timeout still ends as `GitError(sub, null)`); `GitError` gains an optional third constructor argument and a readonly boolean `permissionDenied`, set by `runGit` only when the exit code is 128 and the child's stderr matches `Permission denied`; the stderr text is never stored, so existing `new GitError("push", 128)` call sites in tests still compile and behave the same; src/git/index.ts exports `cloneInto`, `lsRemote`, `pushDryRun`, `pushBranch` and `originUrl`, each calling `runGit` with an argument array, `lsRemote` and `pushDryRun` with `timeoutMs: 15000`; exported `classifyRemoteError(err)` returns `remote_auth_failed` when `err.permissionDenied` is true, else `remote_unreachable` for any other `GitError` (non-zero exit or timeout); unit cases "maps exit 128 permission denied to remote_auth_failed" (a real failing `runGit` against a stub `git` or a fixture hook that writes `Permission denied` to stderr), "maps timeout to remote_unreachable", "GitError message holds only subcommand and exit code" (a planted stderr marker is absent from `message`, `stack`, `String(err)` and `JSON.stringify(err)`); integration against a bare fixture repo: `cloneInto` clones it, `originUrl` returns its path, `lsRemote` lists `main`, `pushDryRun` succeeds and leaves the bare repo's refs unchanged, `pushBranch` pushes a new commit, and `lsRemote` on a missing path gives `remote_unreachable`; existing tests (tests/git.test.ts, tests/notes.integration.test.ts GitError cases) still pass
- Issue: #146
- Status: done

### Decision log

## T2: Validate installer answers and parse the SSH remote
- Purpose: every answer is checked with a fixed message that names the field and the rule, and only an SSH remote without a credential is accepted
- Covers: R1.9, R1.10, R7.2
- Size: M
- Depends on: none
- Files: src/install/answers.ts, src/config/env.ts, tests/install-answers.test.ts, tests/env.test.ts
- Verify: `npm test -- tests/install-answers.test.ts tests/env.test.ts`; `npm run typecheck`; `npm run lint`; src/config/env.ts exports `isAllowedBaseUrl` with no behavior change (tests/env.test.ts unchanged and green, including "errors name variables, never values"); answers.ts validates email, https origin through `isAllowedBaseUrl`, whole-number hop count (0 to 10), Docker network name (`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`), passphrase of 12 characters or more and both entries equal, each failure an `{ field, rule }` whose rendered message contains neither the input value nor any substring of 4 or more characters of it; `parseSshRemote` accepts `git@github.com:owner/vault.git` (host `github.com`, port 22) and `ssh://git@git.example.com:2222/owner/vault.git` (port 2222), and refuses with `remote_not_ssh` `https://github.com/owner/vault.git`, `https://user:tok@github.com/x.git`, `ssh://user:secret@host/x.git`, `file:///tmp/x`, a bare path and an empty string, the error carrying no part of the input; named cases "refuses https remote", "refuses credential in ssh url", "message omits the value" for every field
- Issue: #147
- Status: done

### Decision log

## T3: Merge and render the .env file with a generated ingest token
- Purpose: setup produces a complete `.env` that the service accepts, keeps every existing value and line it does not manage, and creates the ingest token when absent
- Covers: R1.2, R1.3, R1.7
- Size: M
- Depends on: none
- Files: src/install/env-file.ts, tests/install-env-file.test.ts
- Verify: `npm test -- tests/install-env-file.test.ts`; `npm run typecheck`; `npm run lint`; `mergeEnv(existingText, answers)` and `renderEnv` are pure (the token generator is injected); a render from fixture answers holds exactly the managed keys `VAULT_REMOTE`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `INGEST_TOKEN`, `PUBLIC_BASE_URL`, `OWNER_PASSPHRASE_HASH`, `TRUST_PROXY_HOPS`, `N8N_NETWORK`, and parsing it with `node:util` `parseEnv`, adding `VAULT_DIR=/data/vault` (supplied by compose, not managed), then calling `loadEnv` from src/config/env.ts succeeds (case "rendered env passes startup rules", with and without a base URL); `TRUST_PROXY_HOPS` defaults to `1` with a base URL and `0` without, `N8N_NETWORK` to `n8n`; with no `INGEST_TOKEN` the generated one matches `^[A-Za-z0-9_-]{43}$` and two runs differ; an existing token is kept; case "keeps existing values": an existing file with `GIT_AUTHOR_NAME`, `VAULT_REMOTE` and `OWNER_PASSPHRASE_HASH` and answers that omit those fields keeps them byte for byte, while a new answer replaces only its own key; `OWNER_PASSPHRASE_HASH` is rendered in single quotes and round-trips through `parseEnv`; case "keeps unmanaged lines": comments, blank lines and an unknown `FOO=bar` keep their bytes and order; a managed key missing from an existing file is appended under `# Written by 2brain setup`; rendering the same input twice gives identical text
- Issue: #148
- Status: done

### Decision log

## T4: Write .env atomically with mode 0600
- Purpose: the secrets file is never half-written or readable by others, and a re-run with unchanged answers leaves it untouched
- Covers: R1.5, R1.8
- Size: S
- Depends on: T3
- Files: src/install/env-file.ts, tests/install-env-file.integration.test.ts
- Verify: `npm test -- tests/install-env-file.integration.test.ts`; `npm run typecheck`; in a temp project dir: `writeEnvFile` writes `.env.tmp-<random>` in the same directory with mode 0600 and renames it over `.env`, after which `.env` mode is 0600 (POSIX, skipped on Windows) and no `.env.tmp-*` file remains; case "temp file removed on failure": a rename forced to fail leaves the old `.env` unchanged and no temp file; case "byte-identical re-run": a second write with the same answers leaves `.env` content and mtime unchanged (no write happens); a non-writable project dir gives `project_not_writable` and no file
- Issue: #149
- Status: done

### Decision log

## T5: Ask the setup questions on a terminal with hidden passphrase input
- Purpose: an owner answers a short, ordered set of prompts with visible defaults, and the passphrase is never echoed and only its hash is kept
- Covers: R1.1, R1.4, R1.9
- Size: M
- Depends on: T2
- Files: src/install/prompt.ts, tests/install-prompt.test.ts
- Verify: `npm test -- tests/install-prompt.test.ts`; `npm run typecheck`; `npm run lint`; with a scripted io: case "prompt order" asks vault remote, author name, author email, public base URL, proxy hop count, keep current passphrase (only when a hash exists), passphrase, repeat, Docker network name, in that order; with an empty base URL the hop count and passphrase prompts are not asked; every prompt but the passphrase shows the current or default value in brackets; case "hidden input": the scripted output stream receives none of the passphrase characters and raw mode is set and restored (also on error); the passphrase is passed to `hashPassphrase` (src/auth/owner.ts, imported, unchanged) and the returned answers hold only the hash; mismatched entries or one shorter than 12 characters re-ask with the field and rule message; an invalid email re-asks naming `author email`; case "re-asks a non-SSH remote": on a terminal an https remote is refused with `remote_not_ssh` and asked again, and the second (SSH) answer is accepted
- Issue: #150
- Status: done

### Decision log

## T6: Take setup answers from flags and stdin in non-interactive mode
- Purpose: setup runs unattended in CI and scripts, and fails without writing anything when an answer is missing or invalid
- Covers: R1.11, R1.12
- Size: S
- Depends on: T5
- Files: src/install/prompt.ts, tests/install-noninteractive.test.ts
- Verify: `npm test -- tests/install-noninteractive.test.ts`; `npm run typecheck`; `npm run lint`; `readNonInteractive(argv, stdin)` returns answers or a result `{ code, exitCode, fields }` and takes no writer, io or file API, so it cannot write; it maps `--remote`, `--author-name`, `--author-email`, `--public-base-url`, `--trust-proxy-hops` (default 1 with a base URL, 0 without), `--passphrase-stdin`, `--keep-passphrase`, `--n8n-network`, `--host-fingerprint`; the required flags are `--remote`, `--author-name` and `--author-email`; the passphrase comes only from stdin with `--passphrase-stdin` (read once, hashed through `hashPassphrase`, answers hold only the hash), and a `--passphrase` flag or any unknown flag is a usage error with exit code 2; case "missing answers": without `--remote` and `--author-email` the result is `missing_answers` with exit code 2 naming `remote` and `author-email` and not `author-name`; a base URL with neither `--passphrase-stdin` nor `--keep-passphrase` is `missing_answers` naming `passphrase`; case "invalid answer": a bad email gives exit code 1 `invalid_answer` naming the field and rule, not the value; a non-SSH remote gives `remote_not_ssh` with exit code 1 and no part of the input in the result; both failure results are returned before the passphrase is read from stdin (case "no stdin read on failure")
- Issue: #151
- Status: todo

### Decision log

## T7: Compute host key fingerprints, pin GitHub's key and build the SSH command
- Purpose: the service only ever talks to the real Git host with the deploy key, and nothing in the installer turns host key checking off
- Covers: R2.4, R2.5, R2.8, R2.9
- Size: M
- Depends on: none
- Files: src/install/ssh.ts, tests/install-ssh.test.ts, tests/fixtures/ssh/keyscan-github.txt, tests/fixtures/ssh/keyscan-other.txt
- Verify: `npm test -- tests/install-ssh.test.ts`; `npm run typecheck`; `npm run lint`; `fingerprintSha256(base64Key)` computed with `node:crypto` matches the `ssh-keygen -lf` value recorded in the fixture; the GitHub ed25519 constant equals `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` with the docs.github.com source URL in a comment; case "github match pins": a keyscan fixture with that key yields a known_hosts line `github.com ssh-ed25519 <base64>`; case "github mismatch": a different key gives `host_key_mismatch` with both fingerprints in the message and no known_hosts written; a non-22 port renders `[host]:2222 ssh-ed25519 <base64>`; the known_hosts file has exactly one line and is written with mode 0600; `gitSshCommand(dir)` contains `-i <dir>/deploy_key`, `IdentitiesOnly=yes`, `UserKnownHostsFile=<dir>/known_hosts`, `StrictHostKeyChecking=yes` and `BatchMode=yes`; case "no file disables host key checking": a scan of src/install/**, compose.yaml and docs/INSTALL.md (when present) finds no `StrictHostKeyChecking=no`, `StrictHostKeyChecking=accept-new` or `UserKnownHostsFile=/dev/null`
- Issue: #152
- Status: done

### Decision log

## T8: Fetch and confirm the host key of a non-GitHub host
- Purpose: an owner with a self-hosted Git server pins its key only after checking the fingerprint, and a dead host fails fast with a fix
- Covers: R2.6, R2.7, R2.10
- Size: S
- Depends on: T7, T5
- Files: src/install/ssh.ts, tests/install-ssh-confirm.test.ts
- Verify: `npm test -- tests/install-ssh-confirm.test.ts`; `npm run typecheck`; `ssh-keyscan` runs through an injected runner with argument array `["-t", "ed25519", "-p", <port>, <host>]` and a 10 s timeout; case "typed yes pins": the scripted io shows the fingerprint and pins on `yes`; case "anything else rejects": `y`, `no` and empty give `host_key_rejected` with no known_hosts; case "non-interactive fingerprint": `--host-fingerprint` equal to the seen one pins, a different one gives `host_key_rejected`; case "keyscan timeout": a runner that never resolves gives `host_unreachable` with a fix line after the 10 s timer (fake timers) and no known_hosts
- Issue: #153
- Status: todo

### Decision log

## T9: Generate the ed25519 deploy key once
- Purpose: setup creates a passphrase-less deploy key with tight modes, and never replaces one that already exists
- Covers: R2.1, R2.2
- Size: S
- Depends on: T7
- Files: src/install/ssh.ts, tests/install-keygen.test.ts, tests/install-keygen.integration.test.ts
- Verify: `npm test -- tests/install-keygen.test.ts tests/install-keygen.integration.test.ts`; `npm run typecheck`; unit: with an existing `secrets/deploy_key` the runner is not called (case "keeps existing key"); a runner failure gives `keygen_failed` and removes partial `deploy_key` and `deploy_key.pub` (case "cleans partial key"); integration (real `ssh-keygen`, skipped when the binary is absent and on Windows): `ensureDeployKey` creates `secrets/` 0700, `deploy_key` 0600 and `deploy_key.pub` with type `ssh-ed25519` and comment `2brain deploy key`, and `ssh-keygen -y -P "" -f deploy_key` succeeds (no passphrase)
- Issue: #154
- Status: done

### Decision log

## T10: Clone the vault and seed an empty remote with the template
- Purpose: a brand-new vault repository ends up with the template pushed to `main`, a failed clone maps to a fixed code without git output, and the existing `init-vault` copy keeps its never-overwrite rule
- Covers: R3.1, R3.2, R3.7, R7.1
- Size: M
- Depends on: T1
- Files: src/install/vault-bootstrap.ts, src/cli.ts, tests/install-bootstrap.integration.test.ts, tests/cli.integration.test.ts
- Verify: `npm test -- tests/install-bootstrap.integration.test.ts tests/cli.integration.test.ts`; `npm run typecheck`; `npm run lint`; src/cli.ts exports the `init-vault` copy function (`initVault`) with no behavior change and bootstrap learns which files were copied from its `copied <path>` output lines through an injected `CliIo`; the existing `init-vault` cases (never overwrites, lists copied and skipped files) pass unchanged; integration against an empty bare fixture repo: `bootstrapVault` clones it into an empty vault dir (case "clones when no clone"), copies the template, stages only the copied files, makes one commit with message `2brain: seed vault template` and the configured author name and email, and pushes it so the bare repo's `main` points at that commit even when the clone's default branch is not `main` (case "seeds empty remote"); case "clone failure codes": a missing remote path gives `remote_unreachable`, a stubbed runner failing with exit 128 and `Permission denied` gives `remote_auth_failed`, each with a fix line, no commit, and no git stderr marker in the result or output
- Issue: #155
- Status: done

### Decision log


## T11: Handle an existing vault: fill missing files, keep a valid config, refuse a mismatch
- Purpose: setup works on a vault already in use without touching notes, and stops on an invalid config or a clone of another repository
- Covers: R3.3, R3.4, R3.5, R3.8
- Size: M
- Depends on: T10
- Files: src/install/vault-bootstrap.ts, tests/install-bootstrap-existing.integration.test.ts
- Verify: `npm test -- tests/install-bootstrap-existing.integration.test.ts`; `npm run typecheck`; case "fills missing template files": a remote with one note and no `.2brain/config.yaml` gets one commit `2brain: seed vault template` adding only template files, the note unchanged, pushed to the current branch; case "valid config is a no-op": a vault with a valid config has the same HEAD, no new commit and a clean `git status` after bootstrap; case "invalid config": a config failing `loadVaultConfig` gives `config_invalid` naming `.2brain/config.yaml` and the key path, no commit; case "origin mismatch": a clone of another bare repo gives `vault_remote_mismatch` and the clone's HEAD, files and remote config are unchanged
- Issue: #156
- Status: todo

### Decision log

## T12: Report a refused push and push the kept commit on re-run
- Purpose: a deploy key without write access gives a clear fix, and fixing it and re-running finishes the seed without a duplicate commit
- Covers: R3.6
- Size: S
- Depends on: T10, T11
- Files: src/install/vault-bootstrap.ts, tests/install-bootstrap-push.integration.test.ts
- Verify: `npm test -- tests/install-bootstrap-push.integration.test.ts`; `npm run typecheck`; with a bare fixture repo whose `pre-receive` hook exits 1 (POSIX, skipped on Windows): bootstrap gives `push_refused` with the deploy key write access fix and the local seed commit is kept; after removing the hook, a re-run pushes that same commit (bare `main` equals the earlier local HEAD) and makes no new commit; case "re-run goes through the existing-vault path": the re-run starts from an existing clone with a valid config and a clone ahead of origin, pushes it, and T11's "valid config is a no-op" case still passes when the clone is level with origin; no git stderr text (a marker echoed by the hook) appears in the result or the output
- Issue: #157
- Status: todo

### Decision log


## T13: Wire the setup command end to end
- Purpose: `node dist/cli.js setup` runs answers, `.env`, deploy key, host pin, deploy key instructions and vault bootstrap in order, prints no secret, and exits with the documented codes
- Covers: R1.6, R2.3, R1.11, R7.5
- Size: M
- Depends on: T4, T6, T8, T9, T11, T12
- Files: src/install/setup.ts, src/cli.ts, tests/install-setup.test.ts, tests/install-setup.integration.test.ts, tests/cli.integration.test.ts
- Verify: `npm test -- tests/install-setup.test.ts tests/install-setup.integration.test.ts tests/cli.integration.test.ts`; `npm run typecheck`; `npm run lint`; `npm run build`; unit with injected io and runners: case "prints public key and steps": after the key is ready the output holds the `.pub` content and the steps to add it as a deploy key with write access, and on a TTY setup waits for Enter before the vault steps (no git call before the scripted Enter); non-interactive does not wait; case "no secret in output": with planted `INGEST_TOKEN`, passphrase and hash values, none of them (nor any 8-character substring) appears in stdout, stderr or any thrown message, across a success run and every failure code; every result line matches `setup: <code>: <fix>` with a code from design.md; integration (non-interactive, temp project dir, bare fixture repo addressed by path, ssh steps injected): `main(["setup", "--non-interactive", ...])` exits 0 with `setup: done`, missing answers exit 2, an invalid answer exits 1; `usage` lists `setup` (the `doctor` usage line is added by T18); the existing `hash-passphrase` cases (refuses a terminal, prints only the hash) pass unchanged; after an exit 1 or exit 2 run no `.env`, `.env.tmp-*` or `secrets/` entry exists in the project dir; case "file ownership": when run as root, setup sets `.env` to the owner of the project directory and `secrets/` plus its files to uid 1000 (the image user), and runs every git and ssh call as uid 1000 (injected chown and runner spies; skipped when not root)
- Issue: #158
- Status: todo

### Decision log

## T14: Build the doctor check runner and its output
- Purpose: doctor runs its checks in a fixed order, prints one line per check with a fix for every failure, skips the public checks when MCP is off, and leaks no secret
- Covers: R4.1, R4.2, R4.10, R4.14
- Size: M
- Depends on: none
- Files: src/install/doctor.ts, tests/install-doctor.test.ts
- Verify: `npm test -- tests/install-doctor.test.ts`; `npm run typecheck`; `npm run lint`; with stubbed checks: case "order" runs and prints `env`, `env_file`, `secrets`, `network`, `remote_reachable`, `remote_pushable`, `vault_config`, `ingest_health`, `mcp_internal`, `proxy_metadata`, `proxy_mcp` in that order, each line `pass  <id>`, `fail  <id>` followed by `      fix: <line>`, or `skip  <id> (<note>)`, and a summary `doctor: <n> failed, <n> passed, <n> skipped`; a failing check does not stop the next one; exit code 0 when none failed, 1 when any failed; case "skip without base URL": with `PUBLIC_BASE_URL` empty the last three are `skip` with the note `PUBLIC_BASE_URL is empty: claude.ai cannot connect` and their probes are never called; case "no secrets": planted `INGEST_TOKEN`, `OWNER_PASSPHRASE_HASH` and a `VAULT_REMOTE` with a `user:pass@` part never appear in the output, even when a check's fix or error text contains them (the runner prints only fixed strings, ids, codes and paths)
- Issue: #159
- Status: todo

### Decision log

## T15: Add the doctor env, file mode, secrets and network checks
- Purpose: doctor catches a broken `.env`, loose file modes, missing keys and a service that is not on the Docker network
- Covers: R4.3, R4.4, R4.5
- Size: S
- Depends on: T14
- Files: src/install/doctor.ts, tests/install-doctor-local.test.ts
- Verify: `npm test -- tests/install-doctor-local.test.ts`; `npm run typecheck`; case "env names variables": an environment missing `INGEST_TOKEN` and with a bad `PUBLIC_BASE_URL` fails `env` naming both variables and containing neither value; `env_file` fails for a missing `.env` and for modes 0640 and 0604, passes for 0600 (POSIX, skipped on Windows); `secrets` fails when `deploy_key` or `known_hosts` is missing or has group or other bits, passes at 0600; case "network": an injected resolver that rejects for `brain` fails `network` with a fix holding `docker network create <N8N_NETWORK>` and `docker compose up -d`; a resolving stub passes
- Issue: #160
- Status: todo

### Decision log

## T16: Add the doctor git and vault checks without changing anything
- Purpose: doctor shows whether the remote is reachable and writable and the vault config valid, and these checks leave the project, the secrets and the vault exactly as they were
- Covers: R4.6, R4.7, R4.8, R4.15
- Size: M
- Depends on: T14, T1
- Files: src/install/doctor.ts, tests/install-doctor-git.integration.test.ts
- Verify: `npm test -- tests/install-doctor-git.integration.test.ts`; `npm run typecheck`; against bare fixture repos: `remote_reachable` passes on a live remote and fails on a missing path, and fails after a 15 s timeout with an injected hanging runner (fake timers); `remote_pushable` passes on a writable remote and fails with the write access fix when the bare repo's `pre-receive` hook exits 1 (POSIX, skipped on Windows); `vault_config` fails for a missing clone and for an invalid `.2brain/config.yaml` naming the file and key path, passes for a valid one; case "git checks change nothing": after running `remote_reachable`, `remote_pushable` and `vault_config`, a recursive snapshot (paths, contents, modes, mtimes) of the project dir, `secrets/` and the clone (including `.git`), plus the bare repo's refs, is identical to the one taken before
- Issue: #161
- Status: todo

### Decision log

## T17: Add the doctor HTTP checks for ingest, MCP and the proxy
- Purpose: doctor proves the service answers internally and that the public proxy forwards OAuth metadata and `/mcp` correctly
- Covers: R4.9, R4.11, R4.12, R4.13
- Size: M
- Depends on: T14
- Files: src/install/doctor.ts, tests/install-doctor-http.integration.test.ts
- Verify: `npm test -- tests/install-doctor-http.integration.test.ts`; `npm run typecheck`; against local servers: `ingest_health` passes on 200 `{"ok":true}` and fails on 500 and on no answer within 5 s; `mcp_internal` and `proxy_metadata` pass against the real public MCP app (src/mcp/app.ts) whose metadata issuer equals `PUBLIC_BASE_URL`; `proxy_metadata` fails with the INSTALL.md Proxy section fix for another issuer, a 500, a 302 to an `http://` URL (redirect not followed) and an injected fetch that throws a TLS error; `proxy_mcp` passes when `/mcp` without a token answers 401 (the real app) and fails for 200 and 404 with a fix listing `/mcp`, `/authorize`, `/token`, `/register`, `/revoke` and `/.well-known/`; `proxy_metadata` and `proxy_mcp` pass cases use an injected fetch that maps the https `PUBLIC_BASE_URL` origin onto a local server running the real public app (`createPublicApp`); `mcp_internal` fails on a non-200 answer and on an issuer that differs from `PUBLIC_BASE_URL`
- Issue: #162
- Status: todo

### Decision log

## T18: Wire the doctor command and guard the installer's boundaries
- Purpose: `node dist/cli.js doctor` runs every check against the real environment without changing anything, and the installer never calls a model or any host other than the Git host, the public origin and the service
- Covers: R4.2, R4.15, R7.3, R7.6
- Size: S
- Depends on: T13, T15, T16, T17
- Files: src/cli.ts, tests/cli.integration.test.ts, tests/install-boundaries.test.ts, tests/start.test.ts
- Verify: `npm test -- tests/cli.integration.test.ts tests/install-boundaries.test.ts tests/start.test.ts`; `npm run typecheck`; `npm run build`; `usage` lists `doctor`; `main(["doctor", "--project-dir", <tmp>])` with injected probes exits 1 when one check fails and 0 when all pass or skip; case "full doctor changes nothing": a recursive snapshot (paths, contents, modes, mtimes) of the project dir, `secrets/` and the vault clone, plus the bare fixture repo's refs, is identical before and after a full `main(["doctor", ...])` run with all eleven checks; case "no LLM": no file under src/install imports `@anthropic-ai/sdk`, `src/llm` or `../llm`; case "only allowed hosts": a fetch spy over a full setup and doctor run sees only `PUBLIC_BASE_URL` and `http://brain:<port>` URLs, and every runner call is `git`, `ssh-keygen` or `ssh-keyscan` against the remote host; the existing tests/start.test.ts case "starts with MCP disabled while PUBLIC_BASE_URL is empty" passes unchanged
- Issue: #163
- Status: todo

### Decision log

## T19: Add the setup and doctor services to compose.yaml
- Purpose: an owner runs setup and doctor with Docker alone, without them starting on `docker compose up`, each with only the mounts it needs
- Covers: R5.1, R5.2, R5.3, R5.5
- Size: S
- Depends on: T13, T18
- Files: compose.yaml, tests/compose.test.ts
- Verify: `npm test -- tests/compose.test.ts`; `docker compose config --quiet` in CI (or the parsed YAML when Docker is absent); compose.test.ts: `setup` and `doctor` have `build: .` and `profiles: [tools]`, `brain` has no profile; `setup` command is `node dist/cli.js setup` and its volumes are exactly `.:/project` and `vault:/data/vault`; `doctor` command is `node dist/cli.js doctor`, volumes exactly `.:/project:ro`, `./secrets:/run/2brain:ro`, `vault:/data/vault:ro`, and `networks` is `[n8n]` (the external network named by `N8N_NETWORK`); `brain` mounts `./secrets:/run/2brain:ro` in addition to its existing volumes; no service mounts `/var/run/docker.sock`
- Issue: #164
- Status: todo

### Decision log

## T20: Share the strict SSH command in compose, make env_file optional, ignore secrets
- Purpose: every git call in every container uses the deploy key with pinned host keys, no port is published, and the secrets directory never reaches git or the image
- Covers: R5.4, R5.6, R7.4, R2.9
- Size: S
- Depends on: T19
- Files: compose.yaml, .env.example, .gitignore, .dockerignore, tests/compose.test.ts, tests/ignore-files.test.ts
- Verify: `npm test -- tests/compose.test.ts tests/ignore-files.test.ts tests/install-ssh.test.ts`; `npm run lint`; compose.test.ts: `brain`, `setup` and `doctor` set `GIT_SSH_COMMAND` with `-i <dir>/deploy_key`, `IdentitiesOnly=yes`, `UserKnownHostsFile=<dir>/known_hosts`, `StrictHostKeyChecking=yes` and `BatchMode=yes` (`/run/2brain` for brain and doctor through the `x-git-ssh` anchor, `/project/secrets` for setup); `brain` and `doctor` use `env_file` `[{ path: .env, required: false }]`; the existing "no service publishes a host port" case passes for all three services; ignore-files.test.ts: `.gitignore` and `.dockerignore` each have a `secrets/` line, `git check-ignore secrets/deploy_key` succeeds, the Dockerfile text still contains `openssh-client` and `git diff --exit-code Dockerfile` exits 0 (any needed Dockerfile change stops this task and escalates instead), and `.env.example` gains only comment lines (every added line starts with `#`) for the `TRUST_PROXY_HOPS` default and `docker compose run --rm setup`, and compose.yaml, .env.example, .gitignore and .dockerignore contain no em dash; T7's "no file disables host key checking" case passes with compose.yaml present
- Issue: #165
- Status: todo

### Decision log

## T21: Write the linear install guide
- Purpose: a third party follows one document from a fresh host to a working install, with proxy snippets, the n8n credential and the update steps
- Covers: R6.1, R6.2, R6.3, R6.4
- Size: M
- Depends on: T20
- Files: docs/INSTALL.md, tests/guide-install.test.ts
- Verify: `npm test -- tests/guide-install.test.ts`; guide-install.test.ts: the `##` headings of docs/INSTALL.md appear in the order prerequisites, code, network, setup, deploy key, start, proxy, doctor, claude.ai, first note, n8n credential, updates, troubleshooting, and the guide links `GUIDE-mcp.md` and `GUIDE-plugin.md`; prerequisites state Compose 2.24.0 or later; the Proxy section has a Caddy block and an nginx block, each forwarding to `brain:<MCP_PORT>` (default 3001), and the test reads every path docs/GUIDE-mcp.md lists for the proxy and finds it forwarded by both snippets (a `location /` or a catch-all `reverse_proxy` counts for all); the n8n section names a Header Auth credential `2brain ingest`, header `Authorization`, value `Bearer <INGEST_TOKEN>` and URL `http://brain:3000`; the updates section lists `git pull`, `docker compose up -d --build` and `docker compose run --rm doctor` in that order; troubleshooting lists every setup result code and every doctor check id; the network section gives `docker network create`
- Issue: #166
- Status: todo

### Decision log

## T22: Point the README to the install guide and scan both for owner data
- Purpose: the README sends a new owner to the one guide and no longer warns them off real flows, and neither document leaks owner data
- Covers: R6.5, R6.6
- Size: S
- Depends on: T21
- Files: README.md, tests/guide-install.test.ts
- Verify: `npm test -- tests/guide-install.test.ts`; README.md has an `## Install` section with a relative link to `docs/INSTALL.md`; the test asserts the strings `throwaway` and `real n8n flows` are absent from README.md; the README Install section does not contain `cp .env.example .env` (setup writes `.env`) and mentions `docker compose run --rm setup`; case "no owner data": README.md and docs/INSTALL.md contain no email outside `example.com`, no host other than `example.com`, `github.com`, `docs.github.com` and the stack doc hosts, and no name from tests/plugin/fixtures/person-names.json (reusing `scanOwnerData` from tests/plugin/helpers/plugin-scan.ts); neither file contains the em dash character
- Issue: #167
- Status: todo

### Decision log

## T23: Run setup and doctor through Compose on a Docker host (manual check)
- Purpose: the owner confirms the Compose wiring starts with no `.env` and fails clearly without the network
- Covers: R5.7, R5.8
- Size: S
- Depends on: T20, T21
- Files: docs/INSTALL.md
- Verify: `[manual]` (reason: needs Docker Engine and Compose; CI only builds the image; raised as an `rb:needs-local` issue that needs the owner's host, with the exact steps): on a Linux host with Docker Engine and Compose 2.24.0 or later, in a fresh clone with no `.env`: (1) `docker compose run --rm setup` starts and shows the first prompt (vault remote); interrupt it; (2) with the network named by `N8N_NETWORK` absent (`docker network rm` on a test host, or a fresh name), `docker compose run --rm doctor` stops with Compose's network error, and the command in the INSTALL.md Network section creates the network so the same doctor command then starts; a guide step that failed is corrected in docs/INSTALL.md; a failure in code is filed as an `rb:bug` issue
- Issue: #168
- Status: todo

### Decision log

## T24: Install from scratch and run doctor on the reference install (manual check)
- Purpose: the owner confirms the brief's success signal: a third party installs following only the docs and saves a note from claude.ai, and doctor is all green on the reference server
- Covers: R6.7, R6.8
- Size: S
- Depends on: T22, T23
- Files: docs/INSTALL.md
- Verify: `[manual]` (reasons: R6.7 needs a fresh host, a domain, a proxy and a claude.ai account, run once before release; R6.8 needs the owner's server; raised as an `rb:needs-local` issue that needs the owner's host, with the exact steps): (1) on a fresh Linux host with n8n and a proxy, following only README.md and docs/INSTALL.md, a tester runs setup, adds the deploy key, starts the service, adds the proxy snippet, connects claude.ai and saves a note, and `git log` in a fresh clone of their vault repository shows that note's commit; every step the tester had to guess is corrected in docs/INSTALL.md; (2) on the reference install, after `git pull` and `docker compose up -d --build`, `docker compose run --rm doctor` prints `pass` for all eleven checks and exits 0
- Issue: #169
- Status: todo

### Decision log
