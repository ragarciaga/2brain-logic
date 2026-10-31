// Owner login and consent page shared by every spike. Shows who asks and where the code goes.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function loginPage({ rid, clientName, redirectHost, action, error }) {
  return `<!doctype html><meta charset="utf-8"><title>2brain sign in</title>
<h1>Allow ${esc(clientName || "an MCP client")} to use your vault?</h1>
<p>The authorization goes back to <b>${esc(redirectHost)}</b>.</p>${error ? `<p role="alert">${esc(error)}</p>` : ""}
<form method="post" action="${esc(action)}"><input type="hidden" name="rid" value="${esc(rid)}">
<input type="password" name="passphrase" autocomplete="current-password" required>
<button>Allow</button></form>`;
}
