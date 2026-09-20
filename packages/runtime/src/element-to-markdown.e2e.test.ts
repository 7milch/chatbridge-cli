import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { elementToMarkdown } from "@chatbridge/provider";
import { type Browser, type Page, chromium } from "playwright";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

async function md(html: string): Promise<string> {
  await page.setContent(`<div id="root">${html}</div>`);
  return elementToMarkdown(page.locator("#root"));
}

const CASES: Array<[name: string, html: string, expected: string]> = [
  ["headings", "<h1>A</h1><h3>B</h3>", "# A\n\n### B"],
  [
    "paragraphs collapse whitespace",
    "<p>one\n   two</p><p>three</p>",
    "one two\n\nthree",
  ],
  [
    "inline marks",
    "<p><strong>b</strong> <em>i</em> <del>d</del> <b>b2</b> <i>i2</i></p>",
    "**b** *i* ~~d~~ **b2** *i2*",
  ],
  ["inline code", "<p>run <code>ls -la</code></p>", "run `ls -la`"],
  ["inline code containing a backtick", "<p><code>a`b</code></p>", "``a`b``"],
  [
    "fenced code with language",
    '<pre><code class="language-ts">const a = 1;\nconst b = 2;\n</code></pre>',
    "```ts\nconst a = 1;\nconst b = 2;\n```",
  ],
  [
    "pre without code, lang- class on pre",
    '<pre class="lang-sh">echo hi</pre>',
    "```sh\necho hi\n```",
  ],
  [
    "code containing a fence",
    "<pre><code>```\nx\n```</code></pre>",
    "````\n```\nx\n```\n````",
  ],
  [
    "blank lines inside code are kept",
    "<pre><code>a\n\n\nb</code></pre>",
    "```\na\n\n\nb\n```",
  ],
  ["unordered list", "<ul><li>a</li><li>b</li></ul>", "- a\n- b"],
  [
    "ordered list with start",
    '<ol start="3"><li>a</li><li>b</li></ol>',
    "3. a\n4. b",
  ],
  [
    "nested lists",
    "<ul><li>a<ul><li>a1</li></ul></li><li>b<ol><li>b1</li></ol></li></ul>",
    "- a\n  - a1\n- b\n  1. b1",
  ],
  [
    "blockquote",
    "<blockquote><p>q1</p><p>q2</p></blockquote>",
    "> q1\n>\n> q2",
  ],
  [
    "link",
    '<p><a href="https://example.com/x">site</a></p>',
    "[site](https://example.com/x)",
  ],
  [
    "javascript: link is bare text",
    '<p><a href="javascript:void(0)">x</a></p>',
    "x",
  ],
  [
    "table",
    "<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>",
    "| h1 | h2 |\n| --- | --- |\n| a\\|b | c |",
  ],
  ["hr and br", "<p>a<br>b</p><hr><p>c</p>", "a\nb\n\n---\n\nc"],
  [
    "image",
    '<p><img alt="logo" src="https://example.com/l.png"></p>',
    "![logo](https://example.com/l.png)",
  ],
  [
    "copy button and icons are skipped",
    '<div><button>Copy</button><svg><text>x</text></svg><span aria-hidden="true">#</span><p>kept</p></div>',
    "kept",
  ],
  [
    "unknown elements pass their children through",
    "<section><span>a</span><custom-el>b</custom-el></section>",
    "ab",
  ],
  ["no triple blank lines", "<p>a</p><div></div><div></div><p>b</p>", "a\n\nb"],
];

describe("elementToMarkdown (headless Chromium)", () => {
  for (const [name, html, expected] of CASES) {
    test(name, async () => {
      expect(await md(html)).toBe(expected);
    });
  }
});
