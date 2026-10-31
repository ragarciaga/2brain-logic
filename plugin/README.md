# 2brain plugin

Captures your Claude Code work sessions into your second brain vault over MCP. When a session
ends, a headless session reads a digest of it and saves notes to the vault through the `brain`
MCP server.

## Install

Add this repository as a marketplace, then install the plugin:

```
/plugin marketplace add <this repository>
/plugin install 2brain@2brain-logic
```

To try it from a local checkout without installing:

```
claude --plugin-dir plugin
```
