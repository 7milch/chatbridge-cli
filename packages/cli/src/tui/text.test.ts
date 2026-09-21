import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
