import { describe, expect, test } from "bun:test";
import { parseTimeoutSec } from "./timeout-setting.js";

describe("parseTimeoutSec", () => {
  test("a positive number is seconds", () => {
    expect(parseTimeoutSec(30, 120_000)).toEqual({
      timeoutMs: 30_000,
      invalid: false,
    });
  });

  test.each([0, -1, Number.NaN, "abc", undefined])("%p falls back", (raw) => {
    expect(parseTimeoutSec(raw, 120_000)).toEqual({
      timeoutMs: 120_000,
      invalid: raw !== undefined,
    });
  });
});
