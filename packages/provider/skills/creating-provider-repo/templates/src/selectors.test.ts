import { expect, test } from "bun:test";
import * as S from "./selectors.js";

test("every selector is filled in", () => {
  for (const [name, value] of Object.entries(S)) {
    if (name === "MANY") continue;
    expect(typeof value, name).toBe("string");
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
