import { describe, expect, test } from "bun:test";
import { resolveUiConfig } from "./ui-config.js";

const root = "/ext";
const exists = () => true;

describe("resolveUiConfig", () => {
  test("undefined options → undefined", () => {
    expect(resolveUiConfig(undefined, root, exists)).toBeUndefined();
  });

  test("an object with no field set → undefined", () => {
    expect(resolveUiConfig({}, root, exists)).toBeUndefined();
  });

  test("copies the plain-text fields", () => {
    expect(
      resolveUiConfig(
        {
          welcome: "Hi\nthere",
          footer: "No data stored.",
          sendButton: { background: "#2f6f4f", foreground: "#fff" },
        },
        root,
        exists,
      ),
    ).toEqual({
      welcome: "Hi\nthere",
      footer: "No data stored.",
      sendButton: { background: "#2f6f4f", foreground: "#fff" },
    });
  });

  test("resolves the banner against the extension root", () => {
    const seen: string[] = [];
    const cfg = resolveUiConfig({ banner: "media/b.svg" }, root, (p) => {
      seen.push(p);
      return true;
    });
    expect(cfg).toEqual({ bannerPath: "/ext/media/b.svg" });
    expect(seen).toEqual(["/ext/media/b.svg"]);
  });

  test("a missing banner file throws", () => {
    expect(() =>
      resolveUiConfig({ banner: "media/b.svg" }, root, () => false),
    ).toThrow(
      "media/b.svg: banner image not found (looked for /ext/media/b.svg)",
    );
  });

  test("a banner escaping the extension root is rejected", () => {
    for (const banner of ["../secret.png", "/etc/passwd", "a/../../b.png"]) {
      expect(() => resolveUiConfig({ banner }, root, exists)).toThrow(
        `${banner}: banner path must be relative to the extension root`,
      );
    }
  });
});
