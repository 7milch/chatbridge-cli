import { type Token, type Tokens, marked } from "marked";

/**
 * A plain, DOM-free description of what the webview should render.
 *
 * The renderer builds this with `createElement` and `textContent` only, so the
 * tags, hrefs and text here are exactly what reaches the editor. Nothing in
 * this module touches the DOM, and no tag outside the small set produced below
 * can ever appear.
 */
export interface TreeNode {
  /** An HTML tag name, or "#text" for a text node. */
  tag: string;
  className?: string;
  /** "#text": the text. "pre": the code. */
  text?: string;
  /** "a" only, and only http(s). */
  href?: string;
  /** "pre" only: the fence language, when given. */
  lang?: string;
  /** "input" only (task list): checked state. */
  checked?: boolean;
  children?: TreeNode[];
}

const text = (value: string): TreeNode => ({ tag: "#text", text: value });

/**
 * http(s) only, absolute only. Everything else — javascript:, data:,
 * command:, vscode:, mailto:, protocol-relative, relative, a bare fragment —
 * is rejected: a webview link must never run a command or open a local
 * resource. Exported because the renderer applies it again at the point it
 * sets the attribute, so the sink does not depend on its producers.
 */
export function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The fence language is a free-form info string; keep only its first word. */
function fenceLang(lang: string | undefined): string | undefined {
  const first = (lang ?? "").trim().split(/\s+/)[0];
  return first ? first : undefined;
}

function alignClass(
  align: "center" | "left" | "right" | null,
): string | undefined {
  return align === null ? undefined : `align-${align}`;
}

function cell(token: Tokens.TableCell): TreeNode[] {
  return inline(token.tokens);
}

function listItem(item: Tokens.ListItem): TreeNode {
  const children: TreeNode[] = [];
  if (item.task) {
    children.push({
      tag: "input",
      className: "task",
      checked: item.checked === true,
    });
  }
  children.push(...blocks(item.tokens));
  return { tag: "li", children };
}

function blocks(tokens: Token[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      // A link definition ("[1]: https://…") contributes no visible output;
      // its href is already resolved into the links that reference it.
      case "def":
      // The task marker is rendered as the item's own "input" node, so the
      // token that produced it must not also become text.
      case "checkbox":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const depth = Math.min(Math.max(heading.depth, 1), 6);
        out.push({ tag: `h${depth}`, children: inline(heading.tokens) });
        break;
      }
      case "paragraph":
        out.push({
          tag: "p",
          children: inline((token as Tokens.Paragraph).tokens),
        });
        break;
      case "text": {
        // Block-level text: the body of a tight list item. It has no wrapper.
        const block = token as Tokens.Text;
        out.push(...(block.tokens ? inline(block.tokens) : [text(block.text)]));
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const node: TreeNode = {
          tag: list.ordered ? "ol" : "ul",
          children: list.items.map(listItem),
        };
        if (list.ordered && Number(list.start) !== 1) {
          node.className = `start-${Number(list.start)}`;
        }
        out.push(node);
        break;
      }
      case "blockquote":
        out.push({
          tag: "blockquote",
          children: blocks((token as Tokens.Blockquote).tokens),
        });
        break;
      case "code": {
        const code = token as Tokens.Code;
        const node: TreeNode = { tag: "pre", text: code.text };
        const lang = fenceLang(code.lang);
        if (lang !== undefined) node.lang = lang;
        out.push(node);
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          tag: "table",
          children: [
            {
              tag: "thead",
              children: [
                {
                  tag: "tr",
                  children: table.header.map((h, i) => {
                    const node: TreeNode = { tag: "th", children: cell(h) };
                    const cls = alignClass(table.align[i] ?? null);
                    if (cls !== undefined) node.className = cls;
                    return node;
                  }),
                },
              ],
            },
            {
              tag: "tbody",
              children: table.rows.map((row) => ({
                tag: "tr",
                children: row.map((c, i) => {
                  const node: TreeNode = { tag: "td", children: cell(c) };
                  const cls = alignClass(table.align[i] ?? null);
                  if (cls !== undefined) node.className = cls;
                  return node;
                }),
              })),
            },
          ],
        });
        break;
      }
      case "hr":
        out.push({ tag: "hr" });
        break;
      default:
        // Raw HTML and anything this module does not model is shown verbatim
        // as text, never turned into a node.
        out.push({ tag: "p", children: [text(token.raw)] });
        break;
    }
  }
  return out;
}

function inline(tokens: Token[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const value = token as Tokens.Text | Tokens.Escape;
        const nested = (value as Tokens.Text).tokens;
        if (nested) out.push(...inline(nested));
        else out.push(text(value.text));
        break;
      }
      case "strong":
      case "em":
      case "del":
        out.push({
          tag: token.type,
          children: inline((token as Tokens.Strong).tokens),
        });
        break;
      case "codespan":
        out.push({
          tag: "code",
          children: [text((token as Tokens.Codespan).text)],
        });
        break;
      case "br":
        out.push({ tag: "br" });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        // Without a safe target the visible text survives and the target does
        // not: an unsafe link degrades to plain words.
        if (href === undefined) out.push(...inline(link.tokens));
        else out.push({ tag: "a", href, children: inline(link.tokens) });
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeHref(image.href);
        const label = image.text || image.href;
        if (href === undefined) out.push(text(image.text));
        else
          out.push({
            tag: "a",
            href,
            className: "image",
            children: [text(label)],
          });
        break;
      }
      default:
        out.push(text(token.raw));
        break;
    }
  }
  return out;
}

/**
 * Turns a Markdown reply — possibly a partial one, mid-stream — into a node
 * tree. Only `marked.lexer` is used: no `marked.parse`, no renderer, no
 * `marked.use`, so no HTML string is ever produced.
 */
export function toTree(markdown: string): TreeNode[] {
  try {
    return blocks(marked.lexer(markdown, { gfm: true }));
  } catch {
    // Never let a parser edge case blank the reply.
    return [{ tag: "p", children: [text(markdown)] }];
  }
}
