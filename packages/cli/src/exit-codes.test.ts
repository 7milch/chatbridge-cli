import { describe, expect, test } from "bun:test";
import {
  BlockedError,
  BrowserUnavailableError,
  ChatBridgeError,
} from "@chatbridge/core";
import { describeError, exitCodeFor } from "./exit-codes.js";

describe("exitCodeFor", () => {
  test("maps every framework code", () => {
    expect(exitCodeFor("INVALID_ARGUMENT")).toBe(1);
    expect(exitCodeFor("AUTH_REQUIRED")).toBe(2);
    expect(exitCodeFor("AUTH_EXPIRED")).toBe(3);
    expect(exitCodeFor("RESPONSE_TIMEOUT")).toBe(4);
    expect(exitCodeFor("PROVIDER_LOAD")).toBe(5);
    expect(exitCodeFor("BLOCKED")).toBe(6);
    expect(exitCodeFor("BROWSER_UNAVAILABLE")).toBe(7);
    expect(exitCodeFor("LOGIN_ABORTED")).toBe(130);
  });

  test("unknown codes fall back to 1", () => {
    expect(exitCodeFor("SOMETHING_NEW")).toBe(1);
  });
});

describe("describeError", () => {
  test("appends the install hint for a missing browser", () => {
    const err = new BrowserUnavailableError(
      "Chromium is not installed (expected at /x).",
    );
    expect(describeError(err)).toBe(
      "Chromium is not installed (expected at /x).\nRun: npx playwright install chromium",
    );
  });

  test("BLOCKED gets the --headful hint", () => {
    expect(describeError(new BlockedError('Blocked by "x": captcha.'))).toBe(
      'Blocked by "x": captcha. Try --headful.',
    );
  });

  test("other errors are the message alone", () => {
    expect(describeError(new ChatBridgeError("X", "m"))).toBe("m");
  });
});
