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
  const SKIP = new Set(["BUTTON", "SVG", "SCRIPT", "STYLE", "NOSCRIPT"]);
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
    switch (tag) {
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return `**${inner().trim()}**`;
      case "EM":
      case "I":
        return `*${inner().trim()}*`;
      case "DEL":
      case "S":
        return `~~${inner().trim()}~~`;
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
        if (href === "" || /^\s*javascript:/i.test(href)) return text;
        return `[${text}](${href})`;
      }
      case "IMG":
        return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      default:
        // A block nested in inline context (a <p> inside an <li>): its
        // blocks, joined, so the caller can indent them.
        return BLOCK.has(tag) ? blocks(el).join("\n\n") : inner();
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
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
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
        run += inline(c);
        continue;
      }
      flush();
      const heading = /^H([1-6])$/.exec(tag);
      if (heading) {
        out.push(`${"#".repeat(Number(heading[1]))} ${inlineOnly(c)}`);
      } else if (tag === "PRE") {
        const text = (c.textContent ?? "").replace(/\n$/, "");
        const f = fence(text, 3);
        out.push(`${f}${language(c)}\n${text}\n${f}`);
      } else if (tag === "UL" || tag === "OL") {
        const text = list(c, tag === "OL");
        if (text) out.push(text);
      } else if (tag === "BLOCKQUOTE") {
        const text = blocks(c).join("\n\n");
        if (text) {
          out.push(
            text
              .split("\n")
              .map((l) => (l === "" ? ">" : `> ${l}`))
              .join("\n"),
          );
        }
      } else if (tag === "TABLE") {
        const text = table(c);
        if (text) out.push(text);
      } else if (tag === "HR") {
        out.push("---");
      } else {
        out.push(...blocks(c));
      }
    }
    flush();
    return out;
  }

  /** Inline content of a block whose children are all inline (a heading). */
  function inlineOnly(el: Element): string {
    return Array.from(el.childNodes).map(inline).join("").trim();
  }

  return blocks(root)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
