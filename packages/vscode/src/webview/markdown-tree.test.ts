import { describe, expect, test } from "bun:test";
import { type TreeNode, toTree } from "./markdown-tree.js";

/** Flattens to a compact string: tag(children) with text in quotes. */
function show(nodes: TreeNode[]): string {
  return nodes
    .map((n) => {
      if (n.tag === "#text") return JSON.stringify(n.text);
      const attrs = [
        n.href !== undefined ? `href=${n.href}` : "",
        n.lang !== undefined ? `lang=${n.lang}` : "",
        n.className ? `.${n.className}` : "",
        n.checked !== undefined ? `checked=${n.checked}` : "",
      ].join("");
      const body =
        n.children !== undefined
          ? show(n.children)
          : n.text !== undefined
            ? JSON.stringify(n.text)
            : "";
      return `${n.tag}${attrs}(${body})`;
    })
    .join("");
}

/** Every text in the tree, concatenated. */
function allText(nodes: TreeNode[]): string {
  return nodes.map((n) => (n.text ?? "") + allText(n.children ?? [])).join("");
}

describe("toTree blocks", () => {
  test("heading and paragraph", () => {
    expect(show(toTree("## Title\n\nbody"))).toBe('h2("Title")p("body")');
  });
  test("nested list", () => {
    expect(show(toTree("- a\n  - b\n- c"))).toBe(
      'ul(li("a"ul(li("b")))li("c"))',
    );
  });
  test("ordered list keeps a start other than 1", () => {
    const [ol] = toTree("3. x\n4. y");
    expect(ol?.tag).toBe("ol");
    expect(ol?.className).toBe("start-3"); // consumed by main.ts as the start attribute
  });
  test("task list", () => {
    expect(show(toTree("- [x] done\n- [ ] todo"))).toContain(
      "input.taskchecked=true()",
    );
  });
  test("fenced code keeps language and literal text", () => {
    expect(show(toTree("```ts\nconst a = 1 < 2;\n```"))).toBe(
      'prelang=ts("const a = 1 < 2;")',
    );
  });
  test("blockquote, hr", () => {
    expect(show(toTree("> q\n\n---"))).toBe('blockquote(p("q"))hr()');
  });
  test("table with alignment classes", () => {
    const out = show(toTree("| k | v |\n| :-- | --: |\n| a | 1 |"));
    expect(out).toContain('th.align-left("k")');
    expect(out).toContain('td.align-right("1")');
  });
});

describe("toTree inline", () => {
  test("strong, em, del, code, br", () => {
    expect(show(toTree("**b** *i* ~~d~~ `c`"))).toBe(
      'p(strong("b")" "em("i")" "del("d")" "code("c"))',
    );
  });
  test("literal characters are not entity-escaped", () => {
    expect(allText(toTree("a < b & c and `<x>` and \\*"))).toBe(
      "a < b & c and <x> and *",
    );
  });
  test("http(s) link", () => {
    expect(show(toTree("[t](https://e.test/p)"))).toBe(
      'p(ahref=https://e.test/p("t"))',
    );
  });
});

describe("toTree safety", () => {
  test.each([
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "[x](vscode://ext/cmd)",
    "[x](command:workbench.action.quit)",
    "[x](//e.test/p)",
    "[x](/relative)",
  ])("%s gets no href", (md) => {
    const flat = show(toTree(md));
    expect(flat).not.toContain("href=");
    expect(flat).toContain('"x"');
  });
  test("raw HTML is text, never a node", () => {
    const tree = toTree(
      "<img src=x onerror=alert(1)>\n\n<b>hi</b> <script>x</script>",
    );
    const flat = show(tree);
    expect(flat).not.toMatch(/\b(img|script|b)\(/);
    expect(allText(tree)).toContain("<img src=x onerror=alert(1)>");
    expect(allText(tree)).toContain("<script>");
  });
  test("an image becomes a link with its alt text, never an img", () => {
    expect(show(toTree("![cat](https://e.test/c.png)"))).toBe(
      'p(ahref=https://e.test/c.png.image("cat"))',
    );
  });
  test("only allow-listed tags are ever produced", () => {
    const ALLOWED = new Set([
      "#text",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "ul",
      "ol",
      "li",
      "blockquote",
      "hr",
      "pre",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "strong",
      "em",
      "del",
      "code",
      "a",
      "br",
      "input",
    ]);
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        expect(ALLOWED.has(n.tag)).toBe(true);
        walk(n.children ?? []);
      }
    };
    walk(
      toTree(
        "# h\n\n<div>x</div>\n\n- [ ] t\n\n|a|\n|-|\n|b|\n\n![i](https://e.test/i)",
      ),
    );
  });
});

describe("toTree on streaming input", () => {
  test.each([
    "```ts\nconst a",
    "**bo",
    "| a | b |\n| -",
    "- item\n  - ",
    "[link](https://e.te",
    "",
  ])("never throws on %j", (partial) => {
    expect(() => toTree(partial)).not.toThrow();
  });
  test("an unclosed fence is a code block", () => {
    expect(show(toTree("```ts\nconst a"))).toBe('prelang=ts("const a")');
  });
  test("every prefix of a full reply renders", () => {
    const full =
      "Echo: md:x\n\n## Details\n\n- **bold** item\n- second item\n\n```ts\nconst a = 1;\n```\n\n| k | v |\n| --- | --- |\n| a | 1 |";
    for (let i = 0; i <= full.length; i++) {
      expect(() => toTree(full.slice(0, i))).not.toThrow();
    }
  });
});

describe("toTree hostile hrefs", () => {
  test.each([
    ["leading whitespace", "[x]( \t javascript:alert(1))"],
    ["mixed case scheme", "[x](JaVaScRiPt:alert(1))"],
    ["leading newline in the scheme", "[x](\njavascript:alert(1))"],
    ["control character in the scheme", "[x](java\u0000script:alert(1))"],
    ["tab inside the scheme", "[x](java\tscript:alert(1))"],
    ["file scheme", "[x](file:///etc/passwd)"],
    ["blob scheme", "[x](blob:https://e.test/id)"],
    ["about scheme", "[x](about:blank)"],
    ["a title does not smuggle a scheme", '[x](javascript:alert(1) "t")'],
  ])("%s gets no href", (_name, md) => {
    expect(show(toTree(md))).not.toContain("href=");
  });

  test("a javascript: autolink keeps its text but gets no href", () => {
    const tree = toTree("<javascript:alert(1)>");
    expect(show(tree)).not.toContain("href=");
    expect(allText(tree)).toContain("javascript:alert(1)");
  });

  test("a bare www autolink becomes an http link", () => {
    expect(show(toTree("www.example.test/p"))).toBe(
      'p(ahref=http://www.example.test/p("www.example.test/p"))',
    );
  });

  test("a mailto autolink keeps its text but gets no href", () => {
    const tree = toTree("<a@e.test>");
    expect(show(tree)).not.toContain("href=");
    expect(allText(tree)).toContain("a@e.test");
  });

  test("a reference link resolves to a safe href", () => {
    expect(show(toTree("[ref][1]\n\n[1]: https://e.test/r"))).toBe(
      'p(ahref=https://e.test/r("ref"))',
    );
  });

  test("a reference link to a javascript: target gets no href", () => {
    const tree = toTree("[ref][1]\n\n[1]: javascript:alert(1)");
    expect(show(tree)).not.toContain("href=");
    expect(allText(tree)).toContain("ref");
  });

  test("a reference image to a javascript: target is alt text only", () => {
    const tree = toTree("![alt][1]\n\n[1]: javascript:alert(1)");
    expect(show(tree)).not.toContain("href=");
    expect(allText(tree)).toBe("alt");
  });
});

describe("toTree inline structure", () => {
  test("nested emphasis inside a link", () => {
    expect(show(toTree("[**b** and *i*](https://e.test/p)"))).toBe(
      'p(ahref=https://e.test/p(strong("b")" and "em("i")))',
    );
  });

  test("a link whose text is an image keeps both the target and the alt", () => {
    const tree = toTree("[![cat](https://e.test/c.png)](https://e.test/p)");
    const flat = show(tree);
    expect(flat).toContain("href=https://e.test/p");
    expect(allText(tree)).toBe("cat");
  });

  test("an image with no alt text falls back to its href", () => {
    expect(show(toTree("![](https://e.test/c.png)"))).toBe(
      'p(ahref=https://e.test/c.png.image("https://e.test/c.png"))',
    );
  });

  test("HTML entities are never decoded into markup characters", () => {
    // marked >= 13 leaves entities alone; decoding them would re-introduce
    // characters that only matter once a sanitiser is gone.
    const tree = toTree("&lt;script&gt; &amp; &#60;b&#62;");
    expect(allText(tree)).not.toContain("<script>");
    expect(allText(tree)).not.toContain("<b>");
  });

  test("a link definition renders nothing on its own", () => {
    expect(show(toTree("[1]: https://e.test/r"))).toBe("");
  });

  test("a task marker is never rendered as literal text", () => {
    const tree = toTree("- [x] done");
    expect(allText(tree)).toBe("done");
  });

  test("a loose list item keeps its paragraph", () => {
    expect(show(toTree("- a\n\n- b"))).toBe('ul(li(p("a"))li(p("b")))');
  });

  test("deep nesting does not blow the stack", () => {
    const deep = `${"> ".repeat(200)}x`;
    expect(() => toTree(deep)).not.toThrow();
    const deepList = Array.from(
      { length: 100 },
      (_, i) => `${"  ".repeat(i)}- item`,
    ).join("\n");
    expect(() => toTree(deepList)).not.toThrow();
    const deepEmphasis = `${"*".repeat(200)}x${"*".repeat(200)}`;
    expect(() => toTree(deepEmphasis)).not.toThrow();
  });
});
