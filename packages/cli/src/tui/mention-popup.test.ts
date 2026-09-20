import { afterEach, describe, expect, test } from "bun:test";
import {
  BoxRenderable,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { MAX_ROWS, MentionPopup, POPUP_HINT } from "./mention-popup.js";

/** Mention rows: the path is both the value and the label. */
const paths = (...list: string[]) =>
  list.map((value) => ({ value, label: value }));

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

/** Root: history (grows) / input / popup / status — the ChatView order. */
async function setup() {
  const t = await createTestRenderer({ width: 40, height: 14 });
  const root = new BoxRenderable(t.renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const history = new BoxRenderable(t.renderer, { id: "history", flexGrow: 1 });
  history.add(new TextRenderable(t.renderer, { content: "HISTORY LINE" }));
  root.add(history);
  root.add(new TextRenderable(t.renderer, { id: "input", content: "INPUT" }));
  const popup = new MentionPopup(t.renderer, root);
  root.add(new TextRenderable(t.renderer, { id: "status", content: "STATUS" }));
  t.renderer.root.add(root);
  teardown = () => {
    popup.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  const rows = () => t.captureCharFrame().split("\n");
  /** The styled chunks of popup row `i`, as plain `{ text, dim }` pairs.
   * `captureCharFrame` drops all styling, so the dimming of a row can only
   * be asserted on the renderable's own content. */
  const chunks = (i: number): Array<{ text: string; dim: boolean }> => {
    const box = root
      .getChildren()
      .find((r: Renderable) => r.id === "mention-popup");
    if (!box) throw new Error("no mention-popup box");
    const row = box.getChildren()[i];
    if (!(row instanceof TextRenderable)) throw new Error(`no row ${i}`);
    return row.content.chunks.map((c) => ({
      text: c.text,
      dim: ((c.attributes ?? 0) & TextAttributes.DIM) !== 0,
    }));
  };
  return { ...t, popup, rows, chunks };
}

describe("MentionPopup", () => {
  test("starts hidden and takes no rows", async () => {
    const t = await setup();
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    const rows = t.rows();
    const input = rows.findIndex((r) => r.startsWith("INPUT"));
    expect(rows[input + 1]).toStartWith("STATUS");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("show lists candidates between the input and the status row", async () => {
    const t = await setup();
    t.popup.show(paths("src/a.ts", "src/b.ts"));
    await t.renderOnce();
    expect(t.popup.visible).toBe(true);
    expect(t.popup.selected).toBe("src/a.ts");
    const rows = t.rows();
    const input = rows.findIndex((r) => r.startsWith("INPUT"));
    expect(rows[input + 1]).toBe("  src/a.ts".padEnd(40));
    expect(rows[input + 2]).toBe("  src/b.ts".padEnd(40));
    expect(rows[input + 3]).toContain(POPUP_HINT);
    expect(rows[input + 4]).toStartWith("STATUS");
    expect(t.captureCharFrame()).toContain("HISTORY LINE");
  });

  test("move wraps in both directions", async () => {
    const t = await setup();
    t.popup.show(paths("a", "b", "c"));
    t.popup.move(1);
    expect(t.popup.selected).toBe("b");
    t.popup.move(1);
    t.popup.move(1);
    expect(t.popup.selected).toBe("a");
    t.popup.move(-1);
    expect(t.popup.selected).toBe("c");
  });

  test("show resets the selection and hides on an empty list", async () => {
    const t = await setup();
    t.popup.show(paths("a", "b"));
    t.popup.move(1);
    t.popup.show(paths("x", "y"));
    expect(t.popup.selected).toBe("x");
    t.popup.show([]);
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("x");
  });

  test("hide removes the rows and the hint", async () => {
    const t = await setup();
    t.popup.show(paths("src/a.ts"));
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("src/a.ts");
    t.popup.hide();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("src/a.ts");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("shows at most MAX_ROWS candidates", async () => {
    const t = await setup();
    const many = Array.from({ length: 12 }, (_, i) => `file-${i}.ts`);
    t.popup.show(paths(...many));
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(MAX_ROWS).toBe(8);
    expect(frame).toContain("file-7.ts");
    expect(frame).not.toContain("file-8.ts");
  });

  test("long candidates are truncated to the terminal width", async () => {
    const t = await setup();
    t.popup.show(paths("x".repeat(100)));
    await t.renderOnce();
    for (const row of t.captureCharFrame().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
    expect(t.captureCharFrame()).toContain(`  ${"x".repeat(38)}`);
  });

  test("a row's label is drawn and its value is what is selected", async () => {
    const t = await setup();
    t.popup.show([
      { value: "new", label: "/new     Start a new chat" },
      { value: "help", label: "/help    List these commands" },
    ]);
    await t.renderOnce();
    expect(t.popup.selected).toBe("new");
    expect(t.captureCharFrame()).toContain("/new     Start a new chat");
    t.popup.move(1);
    expect(t.popup.selected).toBe("help");
  });

  test("a command row is never dimmed, whatever its description holds", async () => {
    const t = await setup();
    t.popup.show([
      { value: "new", label: "/new     Start a new chat" },
      { value: "reopen", label: "/reopen  Also Ctrl/R" },
    ]);
    // Row 1 is the unselected one, which is the branch that dims a path's
    // directory part. A `/` inside the description must not grey the row up
    // to it, so the whole label is one undimmed chunk after the indent.
    await t.renderOnce();
    expect(t.chunks(1)).toEqual([
      { text: "  /reopen  Also Ctrl/R", dim: false },
    ]);
    expect(t.captureCharFrame()).toContain("/reopen  Also Ctrl/R");
  });

  test("an unselected mention path keeps its directory part dimmed", async () => {
    const t = await setup();
    t.popup.show(paths("a.ts", "src/tui/chat-view.ts"));
    await t.renderOnce();
    expect(t.chunks(1)).toEqual([
      { text: "  ", dim: false },
      { text: "src/tui/", dim: true },
      { text: "chat-view.ts", dim: false },
    ]);
  });

  test("a directory with a space in it is still dimmed whole", async () => {
    const t = await setup();
    t.popup.show(paths("a.ts", "src/a b/c.ts"));
    await t.renderOnce();
    expect(t.chunks(1)).toEqual([
      { text: "  ", dim: false },
      { text: "src/a b/", dim: true },
      { text: "c.ts", dim: false },
    ]);
  });
});
