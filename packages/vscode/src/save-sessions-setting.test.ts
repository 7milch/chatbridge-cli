import { describe, expect, test } from "bun:test";
import { parseSaveSessions } from "./save-sessions-setting.js";

describe("parseSaveSessions", () => {
  test("unset means on", () => {
    expect(parseSaveSessions(undefined)).toEqual({
      enabled: true,
      invalid: false,
    });
  });

  test.each([true, false])("%p is taken as it is", (value) => {
    expect(parseSaveSessions(value)).toEqual({
      enabled: value,
      invalid: false,
    });
  });

  test.each(["false", 0, null, {}])(
    "%p is invalid and saving stays on",
    (value) => {
      expect(parseSaveSessions(value)).toEqual({
        enabled: true,
        invalid: true,
      });
    },
  );
});
