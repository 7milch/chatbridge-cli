import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

// Proves the native OpenTUI binary loads on this platform (CI runs Linux).
test("OpenTUI test renderer draws a frame", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 20,
    height: 3,
  });
  renderer.root.add(new TextRenderable(renderer, { content: "hello opentui" }));
  await renderOnce();
  expect(captureCharFrame()).toContain("hello opentui");
  renderer.destroy();
});

// OpenTUI 0.5.10 draws unstyled text in fixed truecolour white, which is
// invisible on a light terminal. `tui/text.ts` works around it by passing
// `DEFAULT_FG` everywhere. If the first assertion starts failing, OpenTUI
// changed its default and the workaround can be revisited.
test("unstyled text defaults to fixed white, defaultForeground() does not", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 3 });
  const plain = new TextRenderable(renderer, { content: "x" });
  expect(plain.fg.intent).toBe("rgb");
  expect(plain.fg.toInts()).toEqual([255, 255, 255, 255]);
  expect(RGBA.defaultForeground().intent).toBe("default");
  renderer.destroy();
});
