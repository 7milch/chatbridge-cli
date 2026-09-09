import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { MAX_ROWS, MentionPopup } from "./mention-popup.js";

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

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
  root.add(
    new BoxRenderable(t.renderer, { id: "input-box", border: true, height: 4 }),
  );
  t.renderer.root.add(root);
  const popup = new MentionPopup(t.renderer, root, { bottom: 4 });
  teardown = () => {
    popup.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  return { ...t, popup };
}

describe("MentionPopup", () => {
  test("starts hidden and draws nothing", async () => {
    const t = await setup();
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    // The fixture's input box always draws a border, so "nothing drawn" means
    // exactly one top-left corner in the frame — the popup adds no second one.
    const frame = t.captureCharFrame();
    expect(frame.split("┌").length - 1).toBe(1);
    expect(frame).toContain("HISTORY LINE");
  });

  test("show lists candidates above the input box with the first selected", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts", "src/b.ts"]);
    await t.renderOnce();
    expect(t.popup.visible).toBe(true);
    expect(t.popup.selected).toBe("src/a.ts");
    const rows = t.captureCharFrame().split("\n");
    const a = rows.findIndex((r) => r.includes("src/a.ts"));
    const b = rows.findIndex((r) => r.includes("src/b.ts"));
    // The input box's bottom border is the last "└" in the frame; the popup
    // rows sit above it, adjacent, over the history area.
    const inputBottom = rows.map((r) => r.includes("└")).lastIndexOf(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 1);
    expect(inputBottom).toBeGreaterThan(b);
    expect(rows[a - 1]).toContain("┌");
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

  test("hide removes the rows from the frame", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts"]);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("src/a.ts");
    t.popup.hide();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("src/a.ts");
    expect(t.captureCharFrame()).toContain("HISTORY LINE");
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

  test("width is capped at the terminal width", async () => {
    const t = await setup();
    t.popup.show(["x".repeat(100)]);
    await t.renderOnce();
    for (const row of t.captureCharFrame().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
  });
});
