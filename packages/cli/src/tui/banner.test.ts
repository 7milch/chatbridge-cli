import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { resolveBanner } from "./banner.js";

const text = (lines: ReturnType<typeof resolveBanner>) =>
  lines.map((l) => l.chunks.map((c) => c.text).join(""));

describe("resolveBanner", () => {
  test("default banner: bold name, muted version, muted hint", () => {
    const lines = resolveBanner({
      name: "chatbridge",
      version: "0.3.0",
      providerName: "dummy-chat",
    });
    expect(text(lines)).toEqual([
      "chatbridge v0.3.0",
      "Connected to dummy-chat. Type a message, or @ to attach a file.",
    ]);
    const [title, hint] = lines;
    expect(title?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(title?.chunks[1]?.attributes).toBe(TextAttributes.DIM);
    expect(hint?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
  });

  test("default banner without a version shows the name alone", () => {
    const lines = resolveBanner({ name: "acme", providerName: "p" });
    expect(text(lines)[0]).toBe("acme");
    expect(lines[0]?.chunks).toHaveLength(1);
  });

  test("vendor banner is used verbatim, every line muted", () => {
    const lines = resolveBanner({
      name: "acme",
      version: "9.9.9",
      providerName: "p",
      banner: ["  __ __", "Acme internal assistant", ""],
    });
    expect(text(lines)).toEqual(["  __ __", "Acme internal assistant", ""]);
    for (const l of lines) {
      expect(l.chunks[0]?.attributes).toBe(TextAttributes.DIM);
    }
  });
});
