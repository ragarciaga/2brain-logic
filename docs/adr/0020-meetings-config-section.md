# 0020. Meeting settings live in a `meetings` section of the vault config

Status: accepted
Date: 2026-11-01
Related: docs/specs/05-meetings/design.md, docs/adr/0012-vault-config-mapping.md
Approved by: owner, with docs/specs/05-meetings/design.md (2026-11-01)

## Context
Meeting notes need owner-specific settings: time zone for dates and HH-MM, the minimum length,
the untitled and unknown speaker labels in the owner's language, area rules (which calendar or
email domain is work), source values and labels, and the owner's names for the meeting
properties (start, end, duration, participants, calendar event, source title, source URL,
versions). ADR 0006 forbids owner data in code; ADR 0012 keeps the vault config strict and
versioned, with code defaults mirrored by the template.

## Decision
We will add an optional, strict `meetings` section to `.2brain/config.yaml`, keeping `version: 1`
because a vault without the section validates unchanged and takes the defaults (UTC, 5 minutes,
English labels and property names, no area rules). Checks that need the meeting type or the
source allow-list run only for meeting requests, so a bad meeting setup never blocks other writes.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Environment variables for the meeting settings | Settings belong to the vault and change by vault commit (ADR 0012) |
| Add meeting properties to the top-level `properties` map | Every vault would carry meeting names; the top-level map is the cross-type contract |
| Bump to `version: 2` | Nothing breaks for existing vaults; a bump would force every owner to edit the file |

## Consequences
- Positive: Third parties set language, zone and routing in one file; changes apply after the next pull.
- Negative: The strict schema grows; a typo in the section answers 503 to meeting requests until fixed.
- Revisit when: Other sources (email, Telegram) need similar routing rules and a shared section would be simpler.
