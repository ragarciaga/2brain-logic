# Connect an AI client over MCP

This guide takes you from a fresh install to a working connection: you set the owner passphrase
hash, put an HTTPS address in front of the service, and add that address in claude.ai, Claude Code
and Codex or ChatGPT. The examples use `https://brain.example.com`; use your own domain.

## What you get

The service exposes one HTTPS origin (`PUBLIC_BASE_URL`) and the MCP endpoint is
`<PUBLIC_BASE_URL>/mcp`, for example `https://brain.example.com/mcp`. Clients sign in with your
owner passphrase through OAuth. After that they can use seven tools:

- `search`: find notes in the vault.
- `read`: read one note by its vault path.
- `recent`: list the notes most recently committed.
- `save_note`: create a note.
- `save_recipe`: save a recipe note.
- `update_properties`: change the properties of an existing note.
- `vault_info`: read only; describe the vault's areas, property names, note types with their
  folders, and the archive folder.

There is no delete tool: nothing can be removed over MCP. To get rid of a note, archive it from
Obsidian (move it to your archive folder).

## 1. Create the passphrase hash

Choose a long passphrase: at least 12 characters. The service never stores the passphrase, only a
scrypt hash of it.

From a clone of this repository (install and build first):

```bash
npm ci
npm run build
read -rs pass && printf '%s' "$pass" | node dist/cli.js hash-passphrase; unset pass
```

The command refuses to read from a terminal, so the passphrase has to arrive on standard input
(the `read -s` line above does not echo what you type). The hash is the only line printed on
standard output; errors go to standard error and never contain the passphrase.

From the container, with the passphrase piped in the same way:

```bash
read -rs pass && printf '%s' "$pass" | docker compose run --rm -T brain node dist/cli.js hash-passphrase; unset pass
```

Put the result in your private `.env`, wrapped in single quotes because it contains `$`:

```bash
OWNER_PASSPHRASE_HASH='scrypt$...'
```

Never commit `.env` and never paste the hash in an issue or a chat.

## 2. Set the public variables

All of these are listed in `.env.example`.

- `PUBLIC_BASE_URL`: the origin only, for example `https://brain.example.com`. No path, no query,
  no credentials. It must be https (http is accepted only for `localhost` and `127.0.0.1`). Empty
  or unset means MCP stays off and the service logs `mcp disabled: PUBLIC_BASE_URL is not set`.
- `OWNER_PASSPHRASE_HASH`: the hash from step 1. Required once `PUBLIC_BASE_URL` is set.
- `MCP_PORT`: the port of the MCP listener inside the container. Default `3001`.
- `AUTH_STORE_DIR`: where the OAuth state lives. Default `/data/auth`. It must not be inside
  `VAULT_DIR`.
- `TRUST_PROXY_HOPS`: how many reverse proxies sit in front of the service (see step 3).
- `ALLOWED_REDIRECT_HOSTS`: optional. The https hosts an OAuth client may redirect back to. Empty or
  unset means `claude.ai,claude.com,chatgpt.com`. Setting it replaces that list, so when you add a
  host keep the three defaults in it, for example
  `claude.ai,claude.com,chatgpt.com,app.example.com`. Redirects over http to the loopback hosts
  `127.0.0.1`, `localhost` and `[::1]` (any port, for local apps) are always allowed and do not
  need to be listed.

If a variable is wrong, the service exits with code 1 and a message that names the variable, never
its value. When it starts, the log shows `2brain mcp listening on ...`.

## 3. Put HTTPS in front of the service

The service publishes no port. Run your reverse proxy on the Docker network named by
`N8N_NETWORK` (default `n8n`) and forward the whole origin to `brain:MCP_PORT` over plain HTTP,
with HTTPS ending at the proxy. Forward every path of the origin, not only `/mcp`, because the
sign-in needs these as well:

- `/mcp`
- `/authorize`
- `/token`
- `/register`
- `/revoke`
- `/.well-known/`

The proxy configuration itself is not covered here. Set `TRUST_PROXY_HOPS` to exactly the number of
proxies between the client and the service. Too high, and a client can choose the address the
service uses for its limits. Too low, and everyone behind the proxy shares one address and one
limit. With no proxy in front (clients connect directly), leave it at `0`.

## 4. Add the endpoint in a client

Always paste the full endpoint, `<PUBLIC_BASE_URL>/mcp` (for example
`https://brain.example.com/mcp`), never the bare origin. The bare origin does not work: the client
fails to connect (the service answers 404 there), or, if it starts a sign-in with the origin as the
resource, it gets `invalid_target`.

The menu names below can change; check the client's current docs if a label does not match.

### claude.ai (custom connector)

1. Open the connector settings in claude.ai and choose to add a `custom connector`.
2. Paste `<PUBLIC_BASE_URL>/mcp` as the server URL and confirm.
3. Connect. A sign-in page of your service opens; enter your owner passphrase.
4. Check it works: ask Claude to use `search` for a note you know, then `save_note` to save a
   small test note.

### Claude Code

```bash
claude mcp add --transport http brain https://brain.example.com/mcp
```

Then start Claude Code, run `/mcp`, pick the server and follow the sign-in in the browser with your
passphrase. Check it works by asking for a `search`.

### Codex or ChatGPT

Both add a remote MCP server by URL. Check the client's current docs for where it lives (it is
usually in the connectors or MCP settings).

1. Add a new remote MCP server and paste `<PUBLIC_BASE_URL>/mcp`.
2. Connect and sign in with your owner passphrase when the browser opens.
3. Check it works by asking it to run `search`.

## 5. Sign-in limits

The sign-in page protects your passphrase:

- 5 wrong attempts within 15 minutes lock that address for 15 minutes (the page answers 429).
- Each address may make 10 sign-in attempts per minute.
- All addresses together share 30 sign-in attempts per minute, so several addresses can block your
  own sign-in until the minute ends. Wait and retry.
- Client registration is limited to 10 per hour per address and 30 per hour in total.

## 6. Tokens and the auth volume

An access token lasts 1 hour and a refresh token 30 days; clients renew them by themselves. The
state is stored in `auth.json` under `AUTH_STORE_DIR`. With Docker Compose that is the separate
`auth` volume, so it survives restarts and never enters the vault repository. Back it up (find it
with `docker volume ls`). If you lose it, clients are disconnected and must register again, so you may need to remove and
re-add the connector in each client and sign in; the vault is not touched. Never bind mount a vault subfolder at `AUTH_STORE_DIR`.

## Troubleshooting

- `invalid_target`: the client asked for a resource other than `<PUBLIC_BASE_URL>/mcp` (for
  example the bare origin). A client pointed at the origin usually just fails to connect with a 404. Re-add the connector with the exact endpoint.
- 401 before the sign-in page: normal. The endpoint answers 401 until the client has a token, and
  that starts the sign-in.
- 429 on sign-in: a lockout or a rate limit from step 5. Wait for the time in `Retry-After`.
- The service exits at startup naming `auth.json`: the file is damaged or not a regular file.
  Restore it from your backup, or remove it to start with no clients (clients must register again).
- Two edits of the same note collided: the service keeps both. The other version stays at its path
  and yours is saved next to it as `<name> (conflict YYYY-MM-DD).md`. The service log shows
  `conflicts_kept: <n>`. Alerts beyond the log come in a later version; compare the two files in
  Obsidian and archive the one you do not need.
