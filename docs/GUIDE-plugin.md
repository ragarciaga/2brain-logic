# Capture your Claude Code sessions with the plugin

The 2brain plugin saves your Claude Code work sessions to your vault. When a session ends, a
background Claude Code session reads a digest of it and saves a session note, and any recipes
worth keeping, through your `brain` MCP server. This guide covers install, connection, settings,
where the plugin keeps its files, what to do when something fails, and how to turn it off.

Before you start, finish [docs/GUIDE-mcp.md](GUIDE-mcp.md): the service must be running and
reachable over HTTPS.

## 1. Install the plugin

Inside Claude Code, add this repository as a marketplace and install the plugin:

```text
/plugin marketplace add <path or Git URL of this repository>
/plugin install 2brain@2brain-logic
```

The same from a terminal:

```bash
claude plugin marketplace add <path or Git URL of this repository>
claude plugin install 2brain@2brain-logic
```

To try it from a checkout without installing:

```bash
claude --plugin-dir plugin
```

The command names can change between Claude Code versions. If one is rejected, run
`claude plugin --help` and use the names it shows.

## 2. Connect the brain server

The plugin saves through an MCP server named `brain`. Add it once, for your whole user account:

```bash
claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp
```

For example `https://brain.example.com/mcp`. User scope matters: the capture session runs
headless in the plugin's own folder, not in your project, so a server added only for one project
would not be visible there.

Then sign in. Start Claude Code, run `/mcp`, pick `brain` and follow the browser sign-in with your
owner passphrase. Or from a terminal:

```bash
claude mcp login brain
```

Do not pre-approve other MCP write tools in your user settings to make capture smoother. The
capture session only needs the vault tools it is already given.

## 3. Settings

Show the plugin's options and which are unset:

```bash
claude plugin configure 2brain
```

| Setting | Default | What it does |
|---|---|---|
| `area` | empty | Vault area that session notes go under, for example `work`. Empty means nothing is captured until you set it. |
| `server_name` | `brain` | Name of the MCP server from step 2. |
| `model` | `sonnet` | Model used by the background capture session. |
| `min_user_prompts` | `3` | Sessions with fewer of your prompts than this are skipped. |
| `note_language` | `en` | Language code of the generated notes. |
| `enabled` | `true` | Turns automatic capture on or off. |

The plugin reads each setting from `CLAUDE_PLUGIN_OPTION_<KEY>`, for example
`CLAUDE_PLUGIN_OPTION_AREA`. To use another area for one session only, start Claude Code with
`TWOBRAIN_AREA` set:

```bash
TWOBRAIN_AREA=work claude
```

`TWOBRAIN_AREA` wins over the `area` setting for that session.

## 4. Vault config

Open `.2brain/config.yaml` in your vault.

- If `sources` is empty (`sources: []`), you need to do nothing.
- If `sources` lists values, add `claude-code` to the list. Otherwise the vault rejects the notes.
- If `types` is customized, add the session type:

```yaml
types:
  session: { value: session, folder: "{area}/sessions" }
```

New vaults from the template already have this line.

## 5. Where the plugin keeps its files

The plugin stores its working files in its data folder, outside the vault:
`~/.claude/plugins/data/<id>/` (Claude Code sets the path in `CLAUDE_PLUGIN_DATA`). Uninstalling
the plugin deletes this folder.

- `queue/`: sessions waiting to be captured. A job is removed after it is saved or skipped.
- `failed/`: jobs that gave up. They are deleted after 30 days.
- `state.json`: which sessions were already captured.
- `capture.lock`: marks a capture that is running.
- `logs/capture.log` and `logs/capture.log.1`: the log. At 1 MiB the log is renamed to `.1`
  and a new one starts.

Each log line has a time, the first 8 characters of the session id and a code. For example:

```text
2026-03-14T10:22:31.000Z 1a2b3c4d saved notes=work/sessions/2026-03-14 example plan.md recipes=1
```

## 6. Troubleshooting

Look at the last lines of `logs/capture.log`, find the code in the table, and follow the fix.

| Code | Meaning | What happens to the job | Fix |
|---|---|---|---|
| `saved` | The session note was saved. | Deleted, done. | Nothing. |
| `already_saved` | The note for this session already exists. | Deleted. | Nothing. |
| `nothing_to_save` | The session had nothing worth keeping. | Deleted. | Nothing. |
| `skipped_trivial` | Too few of your prompts (see `min_user_prompts`). | Deleted. | Lower `min_user_prompts` if you want short sessions. |
| `skipped_duplicate` | This session was already captured. | Deleted. | Nothing. |
| `invalid_input` | Claude Code sent the hook an event the plugin could not read. | No job is created. | Update Claude Code and the plugin. |
| `hook_error` | The hook failed, for example the data folder cannot be written. | A stored job runs with the next capture. | Check that the data folder exists and that you can write to it. |
| `invalid_field` | A setting or event field has an unusable value. | The job is dropped. | Run `claude plugin configure 2brain` and fix the value. |
| `invalid_detail` | The capture session returned a malformed answer. | The job is retried. | Nothing; if it repeats, update the plugin. |
| `not_configured` | `area` is empty, or `server_name` or `model` is not valid. | Kept and retried at every session end, until 7 days. | Set `area` (for example `work`), and use a plain `server_name` and `model`. |
| `transcript_missing` | Claude Code no longer has the session transcript. | Deleted. | Nothing; the session cannot be captured. |
| `api_helper_present` | Your `~/.claude/settings.json` (or the folder named by `CLAUDE_CONFIG_DIR`) sets `apiKeyHelper`, or has an API credential in its `env` block. | Deleted. | Remove that entry if you want capture on your subscription. |
| `claude_not_found` | The `claude` command is not on the path of the background session. | Kept, up to 3 attempts. | Make sure `claude` runs from a new terminal. |
| `headless_failed` | The capture session ended with an error (the line shows `exit=<n>`). | Kept, up to 3 attempts. | Run `claude` once to check you are signed in, then end another session. |
| `timeout` | The capture session ran over 10 minutes and was stopped. | Kept, up to 3 attempts. | Nothing; try again with the next session. |
| `failed` | The capture session reported it could not finish. | Kept, up to 3 attempts. | Check the service and your sign-in (`/mcp`). |
| `mcp_unavailable` | The capture session could not reach the `brain` server. | Kept, up to 3 attempts. | Check the service is up and run `claude mcp login brain`. |
| `session_type_missing` | The vault does not know the `session` type. | Kept, up to 3 attempts. | Add the `session` line from step 4. |
| `worker_error` | The background worker hit an unexpected error. | Kept for the next worker. | Look at the lines before it in the log. |
| `gave_up` | The job failed 3 times or is older than 7 days. | Moved to `failed/`, deleted after 30 days. | Fix the cause shown by the earlier codes. |

## 7. Turn capture off

Set the `enabled` setting to `false` (or `0`):

```bash
claude plugin configure 2brain
```

You can also disable or uninstall the plugin. Uninstalling also deletes the data folder.

## 8. Cost

Capture runs on your Claude subscription, so the API cost is USD 0. The plugin removes API
credential variables from the background session so it cannot bill an API account. Each capture
uses some of your plan's quota. Only one capture runs per machine at a time.

## 9. Analyze a meeting

Meetings stored in the vault are not analyzed automatically. In an interactive Claude Code session,
ask it to analyze a stored meeting; the `analizar-reunion` skill runs in your session, on your
subscription.
