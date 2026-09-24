import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BoxRenderable, CodeRenderable, parseEdge } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { adoptTerminalCursor, markdown } from "./text.js";
import {
  MUTED_COLOR,
  SELECTION_BG,
  SELECTION_FG,
  markdownSyntaxStyle,
} from "./theme.js";

// OpenTUI's own constructors default to fixed white (see text.ts). A direct
// `new TextRenderable(...)` compiles and looks fine on a dark terminal, so
// nothing but this test would catch it.
test("TUI sources build text through the text.ts factories", () => {
  const dir = import.meta.dir;
  const direct = /new (Text|Textarea|Markdown|Input)Renderable\(/;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => f !== "text.ts")
    .filter((f) => direct.test(readFileSync(join(dir, f), "utf8")));
  expect(offenders).toEqual([]);
});

test("the cursor adopts the detected terminal foreground", async () => {
  const input = { cursorColor: "#808080" as unknown };
  await adoptTerminalCursor(
    { getPalette: async () => ({ defaultForeground: "#123456" }) },
    input,
  );
  expect(input.cursorColor).toBe("#123456");
});

test.each([
  ["no answer", async () => ({ defaultForeground: null })],
  [
    "a failed query",
    async () => {
      throw new Error("no OSC");
    },
  ],
])("the cursor keeps its fallback after %s", async (_n, getPalette) => {
  const input = { cursorColor: "#808080" as unknown };
  await adoptTerminalCursor({ getPalette }, input);
  expect(input.cursorColor).toBe("#808080");
});

let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

const FENCED = "before\n\n```javascript\nconst x = 1;\n```\n\nafter\n";

/** A Markdown body over one fenced block, as chat-view builds a reply. */
async function fencedBody(streaming: boolean, content = FENCED) {
  const t = await createTestRenderer({ width: 40, height: 12 });
  const style = markdownSyntaxStyle();
  const body = markdown(t.renderer, {
    content,
    syntaxStyle: style,
    conceal: true,
    streaming,
  });
  t.renderer.root.add(body);
  teardown = async () => {
    // A highlight still running when the style is destroyed logs a warning.
    await Promise.all(codeRenderablesOf(body).map((c) => c.highlightingDone));
    body.destroy();
    style.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  return body;
}

/** Every CodeRenderable under a body, framed or not. */
function codeRenderablesOf(body: { getChildren(): unknown[] }) {
  return body
    .getChildren()
    .flatMap((b) => (b instanceof BoxRenderable ? b.getChildren() : [b]))
    .filter((c): c is CodeRenderable => c instanceof CodeRenderable);
}

/** The block MarkdownRenderable built for the fenced code: the child that
 * is either its CodeRenderable or a Box holding it. A paragraph is a
 * CodeRenderable too (filetype markdown), so the filetype tells them apart. */
function codeBlockOf(body: { getChildren(): unknown[] }) {
  const isFenced = (c: unknown) =>
    c instanceof CodeRenderable && c.filetype === "javascript";
  const hit = body
    .getChildren()
    .find(
      (b) =>
        isFenced(b) ||
        (b instanceof BoxRenderable && b.getChildren().some(isFenced)),
    );
  if (!hit) throw new Error("no code block among the Markdown blocks");
  return hit;
}

test("a streaming code block stays a bare CodeRenderable with selection colours", async () => {
  const body = await fencedBody(true);
  const block = codeBlockOf(body);
  expect(block).toBeInstanceOf(CodeRenderable);
  expect((block as CodeRenderable).selectionBg).toBe(SELECTION_BG);
  expect((block as CodeRenderable).selectionFg).toBe(SELECTION_FG);
});

test("settling frames the streamed code block in place", async () => {
  const body = await fencedBody(true);
  const before = body.getChildren();
  const code = codeBlockOf(body) as CodeRenderable;
  const index = before.indexOf(code);
  body.streaming = false;
  const after = body.getChildren();
  expect(after).toHaveLength(before.length);
  // The prose blocks are the same objects: nothing was rebuilt.
  after.forEach((b, i) => {
    if (i !== index) expect(b).toBe(before[i]);
  });
  const box = after[index];
  expect(box).toBeInstanceOf(BoxRenderable);
  if (!(box instanceof BoxRenderable)) return;
  expect(box.border).toEqual(["left"]);
  expect(box.borderColor).toBe(MUTED_COLOR);
  // BoxRenderable (0.5.10) has no paddingLeft getter; read its layout node.
  expect(box.getLayoutNode().getPadding(parseEdge("left")).value).toBe(1);
  // The gap below the block is the frame's margin, not the code's, or the
  // border would run on into the blank line.
  const bottom = parseEdge("bottom");
  expect(box.getLayoutNode().getMargin(bottom).value).toBe(1);
  expect(box.getChildren()).toEqual([code]);
  expect(box.getChildren()[0]).toBe(code);
  expect(code.selectionBg).toBe(SELECTION_BG);
  expect(code.selectionFg).toBe(SELECTION_FG);
  expect(code.getLayoutNode().getMargin(bottom).value || 0).toBe(0);
});

test("settling a prose-only body keeps every block", async () => {
  const body = await fencedBody(true, "one\n\n# two\n\nthree\n");
  const before = body.getChildren();
  body.streaming = false;
  const after = body.getChildren();
  expect(after).toHaveLength(before.length);
  after.forEach((b, i) => expect(b).toBe(before[i]));
});

test("a settled body with framed code refuses to stream again", async () => {
  const body = await fencedBody(true);
  body.streaming = false;
  expect(() => {
    body.streaming = true;
  }).toThrow("cannot stream again");
});

test("a body built already settled frames its code block at once", async () => {
  const body = await fencedBody(false);
  expect(codeBlockOf(body)).toBeInstanceOf(BoxRenderable);
});

test("the prose around a settled code block stays unframed", async () => {
  const body = await fencedBody(false);
  const framed = body.getChildren().filter((b) => b instanceof BoxRenderable);
  expect(framed).toHaveLength(1);
});
