import { expect, test } from "bun:test";
import * as S from "./selectors.js";

// A fresh scaffold has every selector empty and must still pass `bun run
// check`; from the first selector you fill in, all of them are required except
// the ones listed in MAY_BE_EMPTY.
const scaffold = Object.entries(S as Record<string, unknown>).every(
  ([name, value]) =>
    name === "MANY" || name === "CHALLENGE_TITLE" || value === "",
);

// Empty only where a dom-discovery.md decision row said to take a VARIANT.
const MAY_BE_EMPTY = [
  "SIGN_IN_CONTROL",
  "SEND_BUTTON",
  "STOP_BUTTON",
  "NEW_CHAT_BUTTON",
];

test.skipIf(scaffold)("every selector is filled in", () => {
  for (const [name, value] of Object.entries(S)) {
    if (name === "MANY") continue;
    expect(typeof value, name).toBe("string");
    if (MAY_BE_EMPTY.includes(name)) continue;
    expect(value as string, name).not.toBe("");
  }
});

test("MANY names existing selectors", () => {
  for (const name of S.MANY) expect(S).toHaveProperty(name);
});

test("no selector leans on a class name", () => {
  for (const [name, value] of Object.entries(S)) {
    if (name === "MANY" || name.endsWith("_URL") || name === "CHALLENGE_TITLE")
      continue;
    expect(value as string, name).not.toMatch(/(^|[\s>+~,(])\.[A-Za-z_-]/);
  }
});
