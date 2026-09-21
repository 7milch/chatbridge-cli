import { expect, test } from "bun:test";
import {
  NOT_RESTORED_NOTE,
  RESTORED_NOTE,
  restoreNote,
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
