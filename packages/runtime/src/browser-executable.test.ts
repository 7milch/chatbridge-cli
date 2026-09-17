import { describe, expect, test } from "bun:test";
import {
  isMissingExecutableError,
  missingBrowserExecutable,
} from "./browser-executable.js";

describe("missingBrowserExecutable", () => {
  test("returns undefined when the executable exists", () => {
    expect(missingBrowserExecutable("/x/chrome", () => true)).toBeUndefined();
  });

  test("returns the expected path when it does not exist", () => {
    expect(missingBrowserExecutable("/x/chrome", () => false)).toBe(
      "/x/chrome",
    );
  });

  test("defaults to Playwright's chromium path", () => {
    const result = missingBrowserExecutable(undefined, () => false);
    expect(result).toContain("chrom");
  });
});

describe("isMissingExecutableError", () => {
  test("matches Playwright's message", () => {
    const err = new Error(
      "Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome\n╔══╗",
    );
    expect(isMissingExecutableError(err)).toBe(true);
  });

  test("rejects other errors and non-errors", () => {
    expect(isMissingExecutableError(new Error("connect ECONNREFUSED"))).toBe(
      false,
    );
    expect(isMissingExecutableError("Executable doesn't exist at")).toBe(false);
  });
});
