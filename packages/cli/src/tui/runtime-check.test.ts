import { describe, expect, test } from "bun:test";
import { supportsInteractive } from "./runtime-check.js";

describe("supportsInteractive", () => {
  test.each([
    [{ bun: "1.3.0" }, true],
    [{ bun: "1.4.0" }, true],
    [{ bun: "1.2.9" }, false],
    [{ node: "26.4.0" }, true],
    [{ node: "27.0.0" }, true],
    [{ node: "26.3.1" }, false],
    [{ node: "20.11.0" }, false],
    [{}, false],
  ])("%p → %p", (versions, expected) => {
    expect(supportsInteractive(versions)).toBe(expected);
  });
});
