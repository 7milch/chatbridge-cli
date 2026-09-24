import type { Locator } from "playwright-core";

/** Markdown for the element's subtree, for providers that declare
 * `responseFormat: "markdown"`. Web chat services render Markdown to HTML,
 * and `textContent` flattens it; this walks the DOM back into Markdown.
 * Plain text is not escaped: a reply showing a literal `*` keeps it, and the
 * rare mis-render is accepted over escape noise in copied text. */
export function elementToMarkdown(locator: Locator): Promise<string> {
  return locator.evaluate(walk);
}

/** Runs inside the page: Playwright serialises this one function, so it may
 * not reference anything outside its own body. */
function walk(root: Element): string {
  // MathML annotations are alternative representations of their parent (the
  // LaTeX source under KaTeX), not text to show: reading them next to the
  // rendered tokens doubles every expression.
  const SKIP = new Set([
    "BUTTON",
    "SVG",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "ANNOTATION",
    "ANNOTATION-XML",
  ]);
  const BLOCK = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "UL",
    "OL",
    "LI",
    "PRE",
    "BLOCKQUOTE",
    "TABLE",
    "HR",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
  ]);

  /** A backtick run one longer than the longest in `text`, so the fence
   * cannot be closed by the code it wraps. */
  const fence = (text: string, min: number): string => {
    let longest = 0;
    for (const run of text.match(/`+/g) ?? [])
      longest = Math.max(longest, run.length);
    return "`".repeat(Math.max(min, longest + 1));
  };

  /** Highlighters put the language on either the `<pre>` or its `<code>`. */
  const language = (el: Element): string => {
    for (const node of [el, el.querySelector("code")]) {
      for (const cls of Array.from(node?.classList ?? [])) {
        const m = /^(?:language|lang)-(.+)$/.exec(cls);
        if (m?.[1]) return m[1];
      }
    }
    return "";
  };

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Collapse HTML whitespace, but only in text: the newline a <br>
      // contributes is emitted below and must survive.
      return (node.textContent ?? "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    // SVG elements report a lower-case tagName in an HTML document.
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true") return "";
    const inner = () => Array.from(el.childNodes).map(inline).join("");
    // Empty emphasis is decoration, not text: `**`/`*`/`~~` around nothing
    // would read as literal markers.
    const mark = (delim: string): string => {
      const text = inner().trim();
      return text ? `${delim}${text}${delim}` : "";
    };
    switch (tag) {
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return mark("**");
      case "EM":
      case "I":
        return mark("*");
      case "DEL":
      case "S":
        return mark("~~");
      case "CODE": {
        const text = el.textContent ?? "";
        const f = fence(text, 1);
        // A span that starts or ends with a backtick needs padding spaces,
        // which the reader strips again.
        const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
        return `${f}${pad}${text}${pad}${f}`;
      }
      case "A": {
        const href = el.getAttribute("href") ?? "";
        const text = inner().trim();
        // A javascript: or empty href is UI, not a destination worth copying.
        // Whitespace or control characters mean it is not a usable URL either,
        // and a control character must never reach a terminal or a clipboard.
        if (
          href === "" ||
          /^\s*javascript:/i.test(href) ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: that is what this rejects.
          /[\s\u0000-\u001f\u007f-\u009f]/.test(href)
        )
          return text;
        return `[${text}](${href})`;
      }
      case "IMG":
        return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      default:
        // A block nested in inline context (a <p> inside an <li>): rendered as
        // itself, so a list keeps its markers, and joined so the caller can
        // indent them. A table only reaches inline context from inside a cell,
        // where a grid would not fit: flatten that one to its text.
        return BLOCK.has(tag) && tag !== "TABLE"
          ? blockOf(el).join("\n\n")
          : inner();
    }
  };

  /** Indents every line but the first, so a marker stays on line one. */
  const indent = (text: string, pad: string): string =>
    text
      .split("\n")
      .map((line, i) => (i === 0 || line === "" ? line : pad + line))
      .join("\n");

  const list = (el: Element, ordered: boolean): string => {
    let n = Number(el.getAttribute("start") ?? "1");
    if (!Number.isFinite(n)) n = 1;
    const items: string[] = [];
    for (const li of Array.from(el.children)) {
      if (li.tagName.toUpperCase() !== "LI") continue;
      const marker = ordered ? `${n++}. ` : "- ";
      // Single newlines, not blank lines: a nested list starts on its own
      // line directly under the item text.
      const body = blocks(li).join("\n");
      items.push(marker + indent(body, " ".repeat(marker.length)));
    }
    return items.join("\n");
  };

  const table = (el: Element): string => {
    // Scoped to this table: an unscoped `tr` query would pull a nested
    // table's rows up into the outer grid.
    const rows = Array.from(
      el.querySelectorAll(
        ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
      ),
    ).map((tr) =>
      Array.from(tr.children).map((cell) =>
        inline(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, " "),
      ),
    );
    const [head, ...body] = rows;
    if (!head) return "";
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return [line(head), line(head.map(() => "---")), ...body.map(line)].join(
      "\n",
    );
  };

  /** The element's content as a list of Markdown blocks. Inline runs between
   * block children become paragraphs of their own. */
  function blocks(el: Element): string[] {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const text = run
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .trim();
      if (text) out.push(text);
      run = "";
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        run += inline(child);
        continue;
      }
      const c = child as Element;
      const tag = c.tagName.toUpperCase();
      if (SKIP.has(tag) || c.getAttribute("aria-hidden") === "true") continue;
      if (!BLOCK.has(tag)) {
        // A wrapper the walker does not know — a custom element around a code
        // block, a <span> or <details> around a list — is a container once its
        // subtree holds block content, not a run of inline text.
        if (
          c.querySelector("pre,ul,ol,table,blockquote,h1,h2,h3,h4,h5,h6,p,hr")
        ) {
          flush();
          out.push(...blocks(c));
        } else {
          run += inline(c);
        }
        continue;
      }
      flush();
      out.push(...blockOf(c));
    }
    flush();
    return out;
  }

  /** The blocks this one block element stands for. Separate from `blocks`, its
   * container counterpart, so inline context can render an element itself. */
  function blockOf(el: Element): string[] {
    const tag = el.tagName.toUpperCase();
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      return [`${"#".repeat(Number(heading[1]))} ${inlineOnly(el)}`];
    }
    if (tag === "PRE") {
      const text = (el.textContent ?? "").replace(/\n$/, "");
      const f = fence(text, 3);
      return [`${f}${language(el)}\n${text}\n${f}`];
    }
    if (tag === "UL" || tag === "OL") {
      const text = list(el, tag === "OL");
      return text ? [text] : [];
    }
    if (tag === "BLOCKQUOTE") {
      const text = blocks(el).join("\n\n");
      if (!text) return [];
      return [
        text
          .split("\n")
          .map((l) => (l === "" ? ">" : `> ${l}`))
          .join("\n"),
      ];
    }
    if (tag === "TABLE") {
      const text = table(el);
      return text ? [text] : [];
    }
    if (tag === "HR") return ["---"];
    return blocks(el);
  }

  /** Inline content of a block whose children are all inline (a heading). */
  function inlineOnly(el: Element): string {
    return Array.from(el.childNodes).map(inline).join("").trim();
  }

  // One blank line between blocks and no more. The limit is applied by the
  // join, never to the finished string: `blocks` already drops empty blocks,
  // and a global collapse would eat blank lines inside fenced code, whose
  // content is verbatim.
  //
  // Control characters are stripped last: the result is printed in a terminal
  // and copied to a clipboard, where an escape sequence from a reply would be
  // an injection. Tab and newline are content and stay.
  return (
    blocks(root)
      .join("\n\n")
      .trim()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
  );
}
