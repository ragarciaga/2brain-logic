# 0010. Ingest API authenticated with a shared bearer token

Status: accepted
Date: 2026-10-31
Related: docs/specs/01-vault-core/design.md
Approved by: the user, with design.md on 2026-10-31 (standing instruction in the build session)

## Context
The ingest API (create, update, archive notes) was reachable without credentials by any container on the n8n network (issue #4). Callers are n8n HTTP nodes and the Claude Code plugin, both of which carry a header easily. The API never leaves the internal network (ADR 0007).

## Decision
We will require `Authorization: Bearer <INGEST_TOKEN>` on every route except `GET /health`. `INGEST_TOKEN` comes from the environment, must be at least 32 characters, is compared in constant time, and is never logged or returned. The service refuses to start without it.

## Alternatives considered
| Option | Why rejected |
|---|---|
| mTLS between n8n and the service | Certificate management for every installer user, no gain on an internal network |
| HMAC-signed requests | Replay protection the internal network does not need; harder to build in n8n nodes |
| No auth on the internal network | Any container attached to that network could write and push |

## Consequences
- Positive: One secret per install; trivial for n8n and the plugin.
- Negative: A leaked token allows writes until rotated; rotation means updating n8n credentials.
- Revisit when: The API needs a route outside the internal network, or several owners share one install.
