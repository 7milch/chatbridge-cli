import { describe, expect, test } from "bun:test";
import { activeFileOf } from "./vscode-ui.js";

/** The slice of vscode.Uri that activeFileOf reads. */
function uri(scheme: string, path: string) {
  return {
    scheme,
    path,
    toString: () => `${scheme}://${path}`,
  };
}

const relPath = (u: { path: string }) =>
  u.path
    .replace(/^\/ws\//, "")
    .split("\\")
    .join("/");

describe("activeFileOf", () => {
  test("no editor means no file", () => {
    expect(activeFileOf(undefined, relPath)).toBeUndefined();
  });

  test("a file: URI yields uri, relative path and basename", () => {
    const editor = {
      document: { uri: uri("file", "/ws/src/config/hogehoge.json") },
    };
    // biome-ignore lint/suspicious/noExplicitAny: the test passes a Uri-shaped stub
    expect(activeFileOf(editor as any, relPath as any)).toEqual({
      uri: "file:///ws/src/config/hogehoge.json",
      path: "src/config/hogehoge.json",
      name: "hogehoge.json",
    });
  });

  test("untitled and other schemes yield nothing", () => {
    for (const scheme of ["untitled", "vscode-userdata", "output"]) {
      const editor = { document: { uri: uri(scheme, "/Untitled-1") } };
      // biome-ignore lint/suspicious/noExplicitAny: Uri-shaped stub
      expect(activeFileOf(editor as any, relPath as any)).toBeUndefined();
    }
  });
});
