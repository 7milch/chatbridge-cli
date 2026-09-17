import { describe, expect, test } from "bun:test";
import { fenceFor } from "./fence.js";

describe("fenceFor", () => {
  test("three backticks when the content has none", () => {
    expect(fenceFor("plain\n")).toBe("```");
  });

  test("one longer than the longest run at a line start", () => {
    expect(fenceFor("a\n```\nb\n")).toBe("````");
    expect(fenceFor("`````x\n")).toBe("``````");
  });

  test("backticks not at a line start do not count", () => {
    expect(fenceFor("say ```hi```\n")).toBe("```");
  });
});
