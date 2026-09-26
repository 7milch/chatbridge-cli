import { describe, expect, test } from "bun:test";
import {
  parseIdleTimeoutMin,
  parseTimeoutSec,
  userSetting,
} from "./timeout-setting.js";

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

describe("userSetting", () => {
  test("undefined when nothing is inspectable", () => {
    expect(userSetting(undefined)).toBeUndefined();
  });

  test("ignores the manifest default", () => {
    expect(userSetting({ defaultValue: true })).toBeUndefined();
  });

  test("returns the global value", () => {
    expect(userSetting({ defaultValue: true, globalValue: false })).toBe(false);
  });

  test("workspace beats global, folder beats workspace", () => {
    expect(userSetting({ globalValue: 1, workspaceValue: 2 })).toBe(2);
    expect(
      userSetting({
        globalValue: 1,
        workspaceValue: 2,
        workspaceFolderValue: 3,
      }),
    ).toBe(3);
  });
});
