# Requirements: Claude Code plugin

Status: approved  |  Date: 2026-10-31  |  Spec: docs/specs/03-claude-code-plugin/
Baseline: unknown
Brief: docs/brief.md  |  ADRs: docs/adr/0004-meetings-without-llm.md, docs/adr/0006-configuration-driven.md, docs/adr/0007-mcp-auth.md, docs/adr/0009-session-end-hook.md, docs/adr/0012-vault-config-mapping.md, docs/adr/0015-public-mcp-app.md, docs/adr/0016-session-capture-with-headless-claude.md

## Context
Decisions, findings and commands that worked in a Claude Code session are lost when the session
ends. This feature ships the Claude Code plugin in `plugin/`: a SessionEnd hook that hands the
finished session to a detached worker, which runs one short headless `claude -p` session on the
owner's subscription; that session writes a session note, validated recipes and person
properties to the vault through the owner's MCP server (F2). The plugin also ships a generic
`analizar-reunion` skill that analyzes a stored meeting transcript and writes the analysis back
over MCP. It is core journey 2 of the brief and costs no Anthropic API spend (ADR 0016).

## Users
- The vault owner, working in Claude Code on any project: ends sessions as usual and finds the
  session's decisions and recipes in the vault minutes later, with no extra step and no slower exit.
- The vault owner, after a meeting: asks Claude Code to analyze it and gets the analysis saved
  next to the transcript.
- A third party installing the product: installs the plugin from this repository, sets an area
  and the MCP server name, and signs in to the MCP server once.

## Out of scope
- Writing through the ingest HTTP API: it listens only on the internal Docker network
  (ADR 0007, ADR 0015); the plugin writes only through MCP.
- Calling the Anthropic API from the plugin or the service for summaries: rejected in ADR 0016
  (cost against the USD 20 cap).
- Writing to `docs/progress.md` or any file in the project: ADR 0009 (the plugin only reads it).
- Creating person notes, storing tasks, archiving or deleting notes: person notes stay
  owner-curated, tasks belong to the owner's task tool (AGENTS.md), and no MCP tool deletes or
  moves files (F2 R9.5).
- Capture from other coding clients (Codex, Cursor) and from claude.ai chats: tracked in
  docs/v2.md (added on approval).
- Automatic meeting analysis without the owner asking: docs/v2.md (ADR 0004).
- Per-project area routing beyond one environment variable: docs/v2.md (added on approval).

## R1: Plugin package and install
As a third party installing the product, I want to install the plugin from this repository with
standard Claude Code commands, so that I need no build step and no copy of anyone's settings.

- R1.1 The system shall provide a plugin directory `plugin/` whose manifest names the plugin
  `2brain`, declares a SessionEnd hook, the `analizar-reunion` skill and the settings `area`,
  `server_name` (default `brain`), `model` (default `sonnet`), `min_user_prompts` (default 3),
  `note_language` (default `en`) and `enabled` (default true). `[unit]`
- R1.2 The system shall provide a marketplace file at the repository root that lists the
  `2brain` plugin with the relative source `./plugin`. `[unit]`
- R1.3 The plugin files shall contain no owner data: no person names, email addresses, domains
  other than `example.com`, area names or folder names other than the canonical defaults. `[unit]`
- R1.4 The plugin scripts shall import only Node.js built-in modules and shall need no install
  step. `[unit]`
- R1.5 When `claude plugin validate plugin --strict` runs on the plugin directory, it shall
  report `Validation passed`. `[manual]` (reason: needs the Claude Code CLI, which CI does not
  install; run before each plugin release)
- R1.6 When the owner adds this repository as a marketplace and installs `2brain`, or starts
  Claude Code with `--plugin-dir plugin`, the SessionEnd hook and the skill shall be loaded.
  `[manual]` (reason: needs a logged-in Claude Code on the owner's machine)

## R2: Fast, detached SessionEnd hook
As the owner, I want exiting Claude Code to stay as fast as without the plugin, so that capture
never gets in my way.

- R2.1 When a SessionEnd event arrives, the hook shall store the event as a job file in the
  plugin data directory, start the capture worker as a detached process and exit with code 0
  within 1 second, without waiting for the worker. `[integration]`
- R2.2 When the hook process and the process that started it have exited, the worker shall keep
  running until its capture finishes. `[integration]`
- R2.3 If the hook input is not valid JSON or lacks `session_id`, `transcript_path` or `cwd`, then
  the hook shall log `invalid_input` and exit with code 0 without storing a job. `[unit]`
- R2.4 If any error occurs in the hook, then the hook shall log the error code and exit with code
  0, writing nothing to standard output or standard error. `[unit]`
- R2.5 While the `enabled` setting is false, the hook shall exit with code 0 without storing a job
  or starting a worker. `[unit]`
- R2.6 The hook and the worker shall start every process without a shell, with argument arrays,
  and with a hidden window on Windows. `[unit]`
- R2.7 The hook shall exit within 1 second and the worker shall finish a capture on macOS and
  Windows as it does on Linux. `[manual]` (reason: CI runs Linux only; checked on the owner's
  machines before the first release)

## R3: Recursion guard
As the owner, I want the headless summary session never to capture itself, so that one session
produces one capture and no loop.

- R3.1 The worker shall start the headless session with the environment variable
  `TWOBRAIN_CAPTURE` set to `1`. `[unit]`
- R3.2 While `TWOBRAIN_CAPTURE` is `1` in the hook environment, the hook shall exit with code 0
  without storing a job or starting a worker. `[unit]`
- R3.3 The worker shall start the headless session with session persistence turned off. `[unit]`
- R3.4 When the fake headless session itself fires the hook with `TWOBRAIN_CAPTURE=1`, the system
  shall start no second worker. `[integration]`

## R4: Skip trivial and already captured sessions
As the owner, I want only sessions with real work to be captured, once, so that the vault holds
no noise and no duplicates and my plan quota is not wasted.

- R4.1 Before reading the transcript, the worker shall wait until the transcript file size has
  not changed for 2 seconds, for at most 10 seconds. `[unit]`
- R4.2 If the transcript has fewer user prompts than `min_user_prompts` (tool results and
  command output do not count as prompts), then the worker shall log `skipped_trivial` and shall
  not start a headless session. `[unit]`
- R4.3 If the transcript file is missing or unreadable, then the worker shall log
  `transcript_missing`, delete the job and shall not start a headless session. `[unit]`
- R4.4 When a capture succeeds, the worker shall record the session id, the transcript lineage
  key (the id of the first user entry) and the number of user prompts covered, in a state file in
  the plugin data directory. `[unit]`
- R4.5 If a session id or lineage key was already captured and the transcript has fewer than
  `min_user_prompts` new user prompts since, then the worker shall log `skipped_duplicate` and
  shall not start a headless session. `[unit]`
- R4.6 When a captured session or lineage has at least `min_user_prompts` new user prompts (a
  resumed session), the worker shall capture only the new part, as part n with the source id
  `claude-code:<session id>:<n>`. `[unit]`
- R4.7 The worker shall give the first part of a session the source id
  `claude-code:<session id>`. `[unit]`
- R4.8 If the headless session reports that the note already exists (`unchanged` or
  `duplicate_source`), then the worker shall log `already_saved` and record the session as
  captured. `[integration]`
- R4.9 When the session ended with reason `logout`, the worker shall keep the job queued without
  starting a headless session, and shall run it with the next capture. `[integration]`

## R5: Capture input
As the owner, I want the summary built from what happened in the session and in the project's
progress file, within a fixed size, with secrets removed, so that it is accurate and safe.

- R5.1 The worker shall build a digest of the transcript that keeps user prompts, assistant text,
  each tool call's name with its command or file path, and at most the first 2,000 characters of
  each tool result. `[unit]`
- R5.2 If the digest is longer than 150,000 characters, then the worker shall keep the first
  30,000 and the last 120,000 characters with one marker line that states how many characters
  were left out. `[unit]`
- R5.3 If a transcript line is not valid JSON or has an unknown shape, then the worker shall skip
  that line and keep the rest. `[unit]`
- R5.4 When `docs/progress.md` exists as a regular file inside the session's `cwd`, the worker
  shall add its first 20,000 characters to the input, marked as the project's progress file.
  `[unit]`
- R5.5 The plugin shall never create, change or delete a file inside the session's `cwd`.
  `[integration]`
- R5.6 The worker shall replace secret-shaped strings in the digest and the progress text with
  `[redacted]` before the headless session sees them: private key blocks, bearer tokens,
  assignments to names that contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, and tokens with
  well-known prefixes. `[unit]`
- R5.7 The worker shall pass the input to the headless session on standard input, never in
  command arguments. `[unit]`
- R5.8 The input shall contain no value of the worker's environment variables. `[unit]`

## R6: Headless session limits
As the owner, I want the headless session to be able to do nothing except use my brain's MCP
tools, on my subscription, within a time limit, so that capture cannot change files, run
commands or spend API money.

- R6.1 The worker shall start `claude -p` with every built-in tool removed and with only the
  tools `vault_info`, `search`, `read`, `save_note`, `save_recipe` and `update_properties` of the
  MCP server named by `server_name` allowed. `[unit]`
- R6.2 The worker shall start the headless session in a permission mode that denies every tool
  call not in the allowed list, without prompting. `[unit]`
- R6.3 The worker shall start the headless session with the model from the `model` setting, a
  limit of 20 turns, JSON output and the capture result schema. `[unit]`
- R6.4 The worker shall remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` from the
  headless session's environment. `[unit]`
- R6.5 The worker shall start the headless session in the plugin data directory with only user
  settings loaded, so that the project's hooks, project MCP servers and project instructions do
  not load. `[unit]`
- R6.6 If the headless session runs longer than 10 minutes, then the worker shall stop it, log
  `timeout` and keep the job for a retry. `[integration]`
- R6.7 While one headless capture runs on the machine, the worker shall start no second one; later
  jobs wait in the queue and the lock is treated as stale after 15 minutes. `[integration]`
- R6.8 If the owner's user settings define an `apiKeyHelper`, then the worker shall log
  `api_helper_present` and shall not start a headless session. `[unit]`

## R7: What lands in the vault
As the owner, I want each substantive session to leave one session note, the recipes that worked
and updates to people I already track, in my vault's conventions, so that I can find them later.

- R7.1 The worker shall give the headless session the exact note path to use:
  `<folder of the session type for the area>/<YYYY-MM-DD> <project> <first 8 characters of the
  session id>.md`, with the date of the session's last entry, the project name from the last
  segment of `cwd`, and part n appended as ` part <n>` when n is 2 or more. `[unit]`
- R7.2 When the session holds at least one decision, finding or working command, the headless
  session shall save one note of the `session` type through `save_note` with the configured
  property names for type, area, date, source (`claude-code`) and source id, and the body
  sections Summary, Decisions, Open items and Recipes. `[manual]` (reason: the content comes from
  the owner's subscription model, which no automated check may call; checked on five real
  sessions with the checklist in design.md)
- R7.3 When the transcript shows a command or code that succeeded after a problem, the headless
  session shall save it through `save_recipe` with the area, the problem, the solution and the
  source `claude-code:<session id>`, and link it from the session note. `[manual]` (reason: same
  as R7.2)
- R7.4 When the session names a person who already has a note of the person type found through
  `search`, the headless session may set properties on that note through `update_properties`,
  and shall create no person note. `[manual]` (reason: same as R7.2)
- R7.5 If the session holds no decision, finding or working command, then the headless session
  shall save nothing and report `nothing_to_save`. `[manual]` (reason: same as R7.2)
- R7.6 The saved notes shall contain no secret, credential or environment value from the
  session, checked on a fixture session with five planted secrets. `[manual]` (reason: same as
  R7.2; the service scrub of F1 is the second barrier and is tested there)
- R7.7 The headless session shall write the notes in the language of the `note_language`
  setting. `[manual]` (reason: same as R7.2)
- R7.8 When the headless session finishes, it shall return a result with a status (`saved`,
  `nothing_to_save`, `mcp_unavailable`, `session_type_missing` or `failed`), the saved paths and
  a short code-like detail, and the worker shall log the status and paths. `[integration]`

## R8: Failures and local log
As the owner, I want every capture failure to be logged on my machine and retried later, never
blocking my exit and never leaking content into the log, so that I can see what happened.

- R8.1 If both the `TWOBRAIN_AREA` environment variable and the `area` setting are empty, then
  the worker shall log `not_configured` and shall not start a headless session. `[unit]`
- R8.2 If the `claude` command cannot be found, then the worker shall log `claude_not_found` and
  keep the job for a retry. `[integration]`
- R8.3 If the headless session exits with a non-zero code, prints output that is not JSON, or
  returns no structured result, then the worker shall log `headless_failed` with the exit code and
  keep the job for a retry. `[integration]`
- R8.4 If the headless session reports `mcp_unavailable` (the server is not configured, not
  signed in or unreachable), then the worker shall log `mcp_unavailable` and keep the job for a
  retry. `[integration]`
- R8.5 If the headless session reports `session_type_missing`, then the worker shall log
  `session_type_missing` and keep the job for a retry. `[integration]`
- R8.6 When a worker starts, it shall also run the queued jobs; a job that failed 3 times or is
  older than 7 days shall be moved to the `failed` folder and logged as `gave_up`. `[unit]`
- R8.7 The worker shall write one line per event to `logs/capture.log` in the plugin data
  directory, with the time, the first 8 characters of the session id, an outcome code and note
  paths, and never transcript text, prompt text, environment values or tokens. `[unit]`
- R8.8 When the log file reaches 1 MiB, the worker shall keep it as one previous file and start a
  new one. `[unit]`
- R8.9 The worker shall store job files readable only by the owner (mode 0600 where the platform
  supports it) and delete a job when its capture succeeds or is skipped. `[unit]`
- R8.10 The plugin shall contain no network client and no vault or git access: every vault write
  happens through the headless session's MCP tool calls. `[unit]`

## R9: Meeting analysis skill
As the owner, I want to ask Claude Code to analyze a meeting stored in my vault and get the
analysis saved next to it, in my subscription, so that meeting analysis costs no API money.

- R9.1 When the owner asks to analyze a meeting, the skill shall find the meeting notes through
  `search` or `recent` and read them through `read`. `[manual]` (reason: runs in the owner's
  interactive session; no automated oracle for the model's choices)
- R9.2 When the vault holds two notes of the same meeting from different sources, the skill shall
  analyze both together as one meeting. `[manual]` (reason: same as R9.1)
- R9.3 When the analysis is ready, the skill shall save it through `save_note` as a note of the
  analysis type in the meeting's folder, linking the meeting notes, with the source id
  `analysis:<meeting source id>`. `[manual]` (reason: same as R9.1)
- R9.4 The skill shall never change the body of a meeting note; it may only set a property that
  links the analysis, through `update_properties`. `[manual]` (reason: same as R9.1; the service
  also refuses body changes to meetings, F1 `immutable_body`)
- R9.5 The skill shall list follow-up tasks in its answer to the owner and shall not save them in
  the vault. `[manual]` (reason: same as R9.1)
- R9.6 The skill file shall contain no person names, languages, area names or folder names; it
  shall take areas, types and folders from `vault_info`. `[unit]`
- R9.7 If the brain MCP tools are not available in the session, then the skill shall tell the
  owner to add the server and sign in, pointing to docs/GUIDE-mcp.md. `[manual]` (reason: same as
  R9.1)

## R10: Vault description and session type
As the headless session and the skill, I want to learn the owner's areas, types, folders and
property names over MCP, so that notes follow the owner's conventions without hardcoding them.

- R10.1 When the `vault_info` MCP tool is called, the system shall return the configured areas,
  the property name map, each type's key, value and folder pattern, and the archive folder.
  `[integration]`
- R10.2 The `vault_info` tool shall return nothing else from the configuration, no file content,
  no environment value and no server setting. `[unit]`
- R10.3 The default vault configuration and the vault template shall include a `session` type
  with the value `session` and the folder `{area}/sessions`, and the test that keeps both equal
  shall pass. `[unit]`
- R10.4 The system shall accept `claude-code` as a source when the configured source allow-list
  is empty, and the install guide shall tell owners with an allow-list to add it. `[unit]`

## R11: End-to-end on the owner's machine
As the owner, I want the whole flow to work with my real Claude Code, MCP login and vault, so
that journey 2 of the brief holds.

- R11.1 When the owner ends a Claude Code session with at least 3 prompts of real work, a session
  note shall appear in the vault within 5 minutes. `[manual]` (reason: needs the owner's
  subscription login, MCP sign-in and vault remote)
- R11.2 Exiting Claude Code with the plugin enabled shall take no visibly longer than without it
  (the hook finishes inside the 1.5 second SessionEnd budget). `[manual]` (reason: same as R11.1)
- R11.3 When the MCP server is offline at exit, the capture shall succeed on a later session end
  once the server is back, with no duplicate note. `[manual]` (reason: same as R11.1)

## Verification summary
| Tag | Count |
|---|---|
| unit | 42 |
| integration | 14 |
| e2e | 0 |
| eval | 0 |
| manual | 18 |
