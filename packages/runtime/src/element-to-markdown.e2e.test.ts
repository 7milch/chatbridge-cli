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
  [
    "a wrapper element around a code block keeps the fence",
    '<code-block><div><span>python</span><button>Copy</button></div><pre><code class="language-python">def f():\n    return 1</code></pre></code-block>',
    "python\n\n```python\ndef f():\n    return 1\n```",
  ],
  [
    "a list wrapped in an inline element keeps its markers",
    "<span><ul><li>a</li><li>b</li></ul></span>",
    "- a\n- b",
  ],
  [
    "details wrapper",
    "<details><summary>S</summary><p>x</p></details>",
    "S\n\nx",
  ],
  [
    "a nested table does not leak rows into the outer one",
    "<table><tr><th>h</th></tr><tr><td><table><tr><td>x</td></tr></table></td></tr></table>",
    "| h |\n| --- |\n| x |",
  ],
  [
    "control characters are stripped",
    "<p>a\u001b]52;c;X\u0007b</p>",
    "a]52;c;Xb",
  ],
  [
    "a tab inside pre survives",
    "<pre><code>a\tb</code></pre>",
    "```\na\tb\n```",
  ],
  [
    "href with a control character is bare text",
    '<p><a href="https://example.com/\u0007x">t</a></p>',
    "t",
  ],
  [
    "href with whitespace is bare text",
    '<p><a href="https://example.com/a b">t</a></p>',
    "t",
  ],
  ["empty emphasis is dropped", "<p>a<strong></strong>b</p>", "ab"],
  [
    // KaTeX renders a MathML branch (visually clipped, holding the rendered
    // tokens plus the LaTeX source in <annotation>) and an aria-hidden HTML
    // branch. The annotation is an alternative representation, not text.
    "KaTeX math emits the rendered text once",
    '<p>contains <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mn>99.8</mn><mi mathvariant="normal">%</mi></mrow><annotation encoding="application/x-tex">99.8\\%</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">99.8</span><span class="mord">%</span></span></span></span> of the mass</p>',
    "contains 99.8% of the mass",
  ],
  [
    "annotation-xml inside math is skipped too",
    '<p><math><semantics><mn>2</mn><annotation-xml encoding="MathML-Content"><cn>2</cn></annotation-xml></semantics></math></p>',
    "2",
  ],
];

describe("elementToMarkdown (headless Chromium)", () => {
  for (const [name, html, expected] of CASES) {
    test(name, async () => {
      expect(await md(html)).toBe(expected);
    });
  }
});
