// Redirect URI policy for dynamic registration: loopback (CLI clients) or an allowlisted https host.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedHosts() {
  return (process.env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com,chatgpt.com").split(",").map((h) => h.trim());
}

export function redirectAllowed(uri, hosts = allowedHosts()) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (LOOPBACK.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
  if (hosts.includes("*")) return true;
  return u.protocol === "https:" && hosts.includes(u.hostname);
}
