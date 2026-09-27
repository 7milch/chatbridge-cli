import { describe, expect, test } from "bun:test";
import {
  NOT_RESTORED_NOTE,
  RESTORED_NOTE,
  RESUMED_SEPARATOR,
  TRANSCRIPT_ONLY_NOTE,
  restoreNote,
  resumedSeparator,
  withRestoreNote,
} from "./conversation-note.js";

test("restoreNote", () => {
  expect(restoreNote(true)).toBe(RESTORED_NOTE);
  expect(restoreNote(false)).toBe(NOT_RESTORED_NOTE);
  expect(restoreNote(undefined)).toBeUndefined();
});

test("withRestoreNote joins with a middle dot, or leaves the separator alone", () => {
  expect(withRestoreNote("reopened", true)).toBe(
    "reopened · conversation restored",
  );
  expect(withRestoreNote("reopened", false)).toBe(
    "reopened · conversation could not be restored",
  );
  expect(withRestoreNote("reopened", undefined)).toBe("reopened");
});

describe("resumedSeparator", () => {
  test("restored", () => {
    expect(resumedSeparator(true)).toBe("resumed · conversation restored");
  });

  test("could not be restored", () => {
    expect(resumedSeparator(false)).toBe(
      "resumed · conversation could not be restored",
    );
  });

  test("nothing to restore", () => {
    expect(resumedSeparator(undefined)).toBe("resumed · transcript only");
  });

  test("is built from the exported parts", () => {
    expect(resumedSeparator(undefined)).toBe(
      `${RESUMED_SEPARATOR} · ${TRANSCRIPT_ONLY_NOTE}`,
    );
  });
});
