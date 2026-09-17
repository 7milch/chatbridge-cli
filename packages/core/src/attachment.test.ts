import { describe, expect, test } from "bun:test";
import { fenceFor, formatAttachment, formatSize } from "./attachment.js";

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

describe("formatAttachment", () => {
  test("heading, language fence, trailing newline added", () => {
    expect(formatAttachment("src/a.ts", "const x = 1;")).toBe(
      "### src/a.ts\n```ts\nconst x = 1;\n```",
    );
  });
  test("unknown extension gets a bare fence; existing newline kept", () => {
    expect(formatAttachment("notes.txt", "hi\n")).toBe(
      "### notes.txt\n```\nhi\n```",
    );
  });
  test("line-range suffix does not confuse the language lookup", () => {
    expect(formatAttachment("src/a.ts:L3-L9", "x")).toBe(
      "### src/a.ts:L3-L9\n```ts\nx\n```",
    );
  });
});

describe("formatSize", () => {
  test("B, KB, MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
