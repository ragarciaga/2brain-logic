import { describe, expect, it } from "vitest";
import {
  appendOpensStoredTag,
  judgeTags,
  neutralizeRemoteEmbeds,
  REMOTE_EMBED_RULE,
  remoteUrlAt,
} from "../src/vault/embeds.js";
import { appendBody } from "../src/vault/operations.js";

const n = (text: string, context?: string) => neutralizeRemoteEmbeds(text, context);

describe("remoteUrlAt", () => {
  it.each([
    "https://example.com/x.png",
    "HTTP://example.com",
    "//example.com/x.png",
    "/\\example.com",
    "  https://example.com",
    "\u0001https://example.com",
    "ht\ttps://example.com",
    "data:image/png;base64,AAAA",
    "ftp://example.com/x",
    "&#104;ttps://example.com",
    "https&colon;//example.com",
    "\\https://example.com",
  ])("%j is remote", (url) => {
    expect(remoteUrlAt(url, 0)).toBe(true);
  });

  it.each([
    "attachments/x.png",
    "x.png",
    "/vault/x.png",
    "My%20File.png",
    "https%3A//example.com",
    "./https://example.com",
    "",
    "http",
  ])("%j is local", (url) => {
    expect(remoteUrlAt(url, 0)).toBe(false);
  });
});

describe("neutralizeRemoteEmbeds: Markdown images", () => {
  it.each([
    ["![](https://example.com/x.png?d=secret)", "[](https://example.com/x.png?d=secret)"],
    ["a ![alt](https://example.com/x.png) b", "a [alt](https://example.com/x.png) b"],
    ['![alt](https://example.com/x.png "Title")', '[alt](https://example.com/x.png "Title")'],
    ["![alt](<https://example.com/a b.png>)", "[alt](<https://example.com/a b.png>)"],
    ["![alt](//example.com/x.png)", "[alt](//example.com/x.png)"],
    ["![alt](  https://example.com/x.png)", "[alt](  https://example.com/x.png)"],
    ["![alt](\nhttps://example.com/x.png)", "[alt](\nhttps://example.com/x.png)"],
    ["![alt](&#104;ttps://example.com/x.png)", "[alt](&#104;ttps://example.com/x.png)"],
    ["![a|100](https://example.com/x.png)", "[a|100](https://example.com/x.png)"],
    ["![a [b] c](https://example.com/x.png)", "[a [b] c](https://example.com/x.png)"],
    [
      "[![badge](https://example.com/b.svg)](https://example.com)",
      "[[badge](https://example.com/b.svg)](https://example.com)",
    ],
    [
      "![[a](https://example.com/x)](https://example.com/y)",
      "[[a](https://example.com/x)](https://example.com/y)",
    ],
    ["![[note]](https://example.com/y)", "[[note]](https://example.com/y)"],
  ])("%j becomes a link", (input, output) => {
    expect(n(input)).toEqual({ text: output, count: 1 });
  });

  it("escapes a `!` right before a dropped one, so no image is left", () => {
    expect(n("!![a](https://example.com/x)").text).toBe("\\![a](https://example.com/x)");
    expect(n("!!![a](https://example.com/x)").text).toBe("!\\![a](https://example.com/x)");
    expect(n("!![a](https://example.com/x)").count).toBe(1);
  });

  it("counts every image and leaves the rest of the text as it was", () => {
    const input = "x ![a](https://example.com/1) y ![b](http://example.com/2) z\n";
    expect(n(input)).toEqual({
      text: "x [a](https://example.com/1) y [b](http://example.com/2) z\n",
      count: 2,
    });
  });

  it.each([
    "![alt](attachments/x.png)",
    "![alt](x.png 'title')",
    "![](My%20File.png)",
    "![[note]]",
    "![[folder/note#Heading|alias]]",
    "[[note]] and [[note|alias]]",
    "[link](https://example.com/x.png)",
    "<https://example.com/x.png>",
    "https://example.com/x.png",
    "\\![alt](https://example.com/x.png)",
    "text ![no closing bracket",
    'if (!["a", "b"].includes(x)) return;',
    "const ok = ![1][0];",
    "![^1]\n\n[^1]: a footnote",
  ])("%j is unchanged", (input) => {
    expect(n(input)).toEqual({ text: input, count: 0 });
  });

  it("also rewrites images inside code blocks and code spans (decision: no code detection)", () => {
    const input = "```md\n![x](https://example.com/x.png)\n```\n`![y](https://example.com/y)`\n";
    expect(n(input)).toEqual({
      text: "```md\n[x](https://example.com/x.png)\n```\n`[y](https://example.com/y)`\n",
      count: 2,
    });
  });
});

describe("neutralizeRemoteEmbeds: reference images", () => {
  it.each([
    ["![a][r]\n\n[r]: https://example.com/x.png", "[a][r]\n\n[r]: https://example.com/x.png"],
    ["![a][]\n\n[A]: <https://example.com/x.png>", "[a][]\n\n[A]: <https://example.com/x.png>"],
    [
      "![Foo  Bar]\n\n[foo bar]: //example.com/x.png",
      "[Foo  Bar]\n\n[foo bar]: //example.com/x.png",
    ],
    [
      "![STRASSE]\n\n[straße]: https://example.com/x",
      "[STRASSE]\n\n[straße]: https://example.com/x",
    ],
    ["![a][r]\n\n> [r]: https://example.com/x.png", "[a][r]\n\n> [r]: https://example.com/x.png"],
    ["![a][r]\n\n[r]:\n> https://example.com/x.png", "[a][r]\n\n[r]:\n> https://example.com/x.png"],
    ["![a](broken\n\n[a]: https://example.com/x", "[a](broken\n\n[a]: https://example.com/x"],
  ])("%j drops the `!`", (input, output) => {
    expect(n(input)).toEqual({ text: output, count: 1 });
  });

  it("keeps a reference image whose definition is local, and a remote reference link", () => {
    const input = "![a][r] and [b][s]\n\n[r]: attachments/x.png\n[s]: https://example.com\n";
    expect(n(input)).toEqual({ text: input, count: 0 });
  });

  it("uses the definitions of the stored body (context) for a new image", () => {
    const context = "old\n\n[r]: https://example.com/x.png\n";
    expect(n("![a][r]", context)).toEqual({ text: "[a][r]", count: 1 });
    expect(n("![a][r]", "old\n")).toEqual({ text: "![a][r]", count: 0 });
  });

  it("escapes a new remote definition for an image already stored (context)", () => {
    const context = "old ![a][r]\n";
    expect(n("[r]: https://example.com/x.png", context)).toEqual({
      text: "\\[r]: https://example.com/x.png",
      count: 1,
    });
    expect(n("[r]: attachments/x.png", context).count).toBe(0);
    expect(n("[q]: https://example.com/x.png", context).count).toBe(0);
    expect(n("[r]: https://example.com/x.png").count).toBe(0);
  });
});

describe("neutralizeRemoteEmbeds: HTML", () => {
  it.each([
    ['<img src="https://example.com/x.png">', '&lt;img src="https://example.com/x.png">'],
    ["<img src='//example.com/x'>", "&lt;img src='//example.com/x'>"],
    ["<img src=https://example.com/x>", "&lt;img src=https://example.com/x>"],
    ["<IMG\nSRC = 'HTTPS://example.com'>", "&lt;IMG\nSRC = 'HTTPS://example.com'>"],
    ['<img/src="https://example.com/x">', '&lt;img/src="https://example.com/x">'],
    ['<img alt=">" src="https://example.com/x">', '&lt;img alt=">" src="https://example.com/x">'],
    ['<img src="&#x68;ttps://example.com/x">', '&lt;img src="&#x68;ttps://example.com/x">'],
    [
      '<img srcset="a.png 1x, https://example.com/b.png 2x">',
      '&lt;img srcset="a.png 1x, https://example.com/b.png 2x">',
    ],
    [
      '<video poster="https://example.com/p.png"></video>',
      '&lt;video poster="https://example.com/p.png"></video>',
    ],
    [
      '<iframe src="https://example.com/"></iframe>',
      '&lt;iframe src="https://example.com/"></iframe>',
    ],
    [
      '<div style="background:url(https://example.com/x)">',
      '&lt;div style="background:url(https://example.com/x)">',
    ],
    ["<style>p{}</style>", "&lt;style>p{}</style>"],
    [
      '<link rel="stylesheet" href="https://example.com/a.css">',
      '&lt;link rel="stylesheet" href="https://example.com/a.css">',
    ],
    [
      '<svg><image href="https://example.com/x"/></svg>',
      '&lt;svg><image href="https://example.com/x"/></svg>',
    ],
    ["> <img\n> src=https://example.com/x>", "> &lt;img\n> src=https://example.com/x>"],
    ['<img src="\n> https://example.com/x">', '&lt;img src="\n> https://example.com/x">'],
  ])("%j is escaped", (input, output) => {
    expect(n(input)).toEqual({ text: output, count: 1 });
  });

  it("escapes every tag that shares the remote attribute", () => {
    const out = n("<img a<b src=https://example.com/x>");
    expect(out.text).toBe("&lt;img a&lt;b src=https://example.com/x>");
    expect(out.count).toBe(2);
  });

  it.each([
    '<img src="attachments/x.png">',
    '<img src="x.png" width="200">',
    '<a href="https://example.com">a link</a>',
    "<div>\n<p>text</p>\n</div>",
    "a < b and a<b",
    "<https://example.com/x.png>",
    '<img src="x.png" alt="https://example.com">',
    "</img src=https://example.com>",
  ])("%j is unchanged", (input) => {
    expect(n(input)).toEqual({ text: input, count: 0 });
  });

  it("is idempotent", () => {
    const input =
      'x ![a](https://example.com/1) <img src="https://example.com/2"> ![b][r]\n\n[r]: https://example.com/3\n';
    const once = n(input);
    expect(once.count).toBe(3);
    expect(n(once.text)).toEqual({ text: once.text, count: 0 });
  });
});

describe("appendOpensStoredTag", () => {
  const joined = (stored: string, text: string) => appendBody(stored, text);

  it("is true when an append would give a stored open tag a remote source", () => {
    const stored = "<pre>\n<img ";
    expect(appendOpensStoredTag(stored, joined(stored, "src=https://example.com/x>"))).toBe(true);
    const value = '<pre>\n<img src="';
    expect(appendOpensStoredTag(value, joined(value, 'https://example.com/x">'))).toBe(true);
  });

  it("is false when every stored tag is closed or the append adds nothing remote", () => {
    const closed = "<pre>\n<img >";
    expect(appendOpensStoredTag(closed, joined(closed, "src=https://example.com/x>"))).toBe(false);
    const open = "if a<b";
    expect(appendOpensStoredTag(open, joined(open, "more text"))).toBe(false);
  });
});

describe("the rule id", () => {
  it("fits the redaction rule id shape", () => {
    expect(REMOTE_EMBED_RULE).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("adversarial 1 MiB inputs finish in under 5000 ms (D5)", () => {
  const SIZE = 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const inputs: [string, string][] = [
    ["image openers", fill("![")],
    ["image openers with text", fill("![a")],
    ["inline destinations", fill("![a](")],
    ["angle destinations", fill("![a](<")],
    ["escaped brackets", `![${fill("\\[")}`],
    ["label openers", fill("[a")],
    ["definitions", fill("[a]:")],
    ["reference images", fill("![a][")],
    ["wikilink openers", fill("![[")],
    ["tag openers", fill("<a")],
    ["tags with attributes", fill("<a b")],
    ["tags with quotes", fill('<a b="')],
    ["tags with mixed quotes", fill("<a b=\"'")],
    ["unquoted values", fill("<a src=x")],
    ["quote runs", `<a ${fill('"a')}`],
    ["blockquote markers", `<a${fill("\n>")}`],
    ["one long tag", `<img ${fill("x ")}`],
    ["srcset", `<img srcset="${fill("a 1x, ")}`],
    ["style", `<a style="${fill("color:red;")}`],
    ["empty values", fill("<a b=")],
    ["tag names over lines", fill("<a\n")],
    ["long escaped labels", fill(`[${"\\[".repeat(500)}`)],
    ["tab runs in destinations", fill("![a](\t\t\t")],
    ["attribute names after values", fill('<a b="c"d')],
  ];

  it.each(inputs)("%s", (_name, input) => {
    const started = performance.now();
    const result = neutralizeRemoteEmbeds(input, input);
    judgeTags(input);
    const elapsed = performance.now() - started;
    expect(result.text.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
