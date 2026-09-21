import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("the webview never injects HTML", () => {
  const dir = import.meta.dir;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const banned of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
    ]) {
      expect(`${file}: ${source.includes(banned)}`).toBe(`${file}: false`);
    }
  }
});
