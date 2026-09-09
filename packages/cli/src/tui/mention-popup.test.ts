import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { MAX_ROWS, MentionPopup, POPUP_HINT } from "./mention-popup.js";

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
  return { ...t, popup, rows };
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
    t.popup.show(["src/a.ts", "src/b.ts"]);
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
    t.popup.show(["a", "b", "c"]);
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
    t.popup.show(["a", "b"]);
    t.popup.move(1);
    t.popup.show(["x", "y"]);
    expect(t.popup.selected).toBe("x");
    t.popup.show([]);
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("x");
  });

  test("hide removes the rows and the hint", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts"]);
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
    t.popup.show(many);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(MAX_ROWS).toBe(8);
    expect(frame).toContain("file-7.ts");
    expect(frame).not.toContain("file-8.ts");
  });

  test("long candidates are truncated to the terminal width", async () => {
    const t = await setup();
    t.popup.show(["x".repeat(100)]);
    await t.renderOnce();
    for (const row of t.captureCharFrame().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
    expect(t.captureCharFrame()).toContain(`  ${"x".repeat(38)}`);
  });
});
