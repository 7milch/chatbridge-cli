import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { adoptTerminalCursor } from "./text.js";

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
