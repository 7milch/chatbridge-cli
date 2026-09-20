import { describe, expect, test } from "bun:test";
import { parseIdleTimeoutMin, parseTimeoutSec } from "./timeout-setting.js";

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

describe("parseIdleTimeoutMin", () => {
  test("a positive number is minutes", () => {
    expect(parseIdleTimeoutMin(30, 86_400_000)).toEqual({
      timeoutMs: 1_800_000,
      invalid: false,
    });
  });

  test("0 disables the idle close and is valid", () => {
    expect(parseIdleTimeoutMin(0, 86_400_000)).toEqual({
      timeoutMs: 0,
      invalid: false,
    });
  });

  test.each([-1, Number.NaN, "abc"])("%p falls back and is invalid", (raw) => {
    expect(parseIdleTimeoutMin(raw, 86_400_000)).toEqual({
      timeoutMs: 86_400_000,
      invalid: true,
    });
  });

  test("undefined falls back without warning", () => {
    expect(parseIdleTimeoutMin(undefined, 86_400_000)).toEqual({
      timeoutMs: 86_400_000,
      invalid: false,
    });
  });
});
