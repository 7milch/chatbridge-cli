import { describe, expect, test } from "bun:test";
import { validateProviderName } from "./provider-name.js";

describe("validateProviderName", () => {
  test.each([["dummy-chat"], ["a"], ["x.y_z-1"], ["a".repeat(64)]])(
    "accepts %p",
    (name: string) => {
      expect(() => validateProviderName(name)).not.toThrow();
    },
  );

  test.each([
    [""],
    ["../escape"],
    ["a/b"],
    ["Upper"],
    [".hidden"],
    ["-dash"],
    ["with space"],
    ["a".repeat(65)],
  ])("rejects %p with RangeError", (name: string) => {
    expect(() => validateProviderName(name)).toThrow(RangeError);
  });
});
