import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
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
