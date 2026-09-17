import { describe, expect, test } from "bun:test";
import { buildHtml } from "./webview-html.js";

describe("buildHtml", () => {
  test("locks the CSP to the nonce and the webview origin", () => {
    const html = buildHtml({
      cspSource: "vscode-webview://abc",
      nonce: "n0nce",
      scriptUri: "vscode-resource:/main.js",
      styleUri: "vscode-resource:/style.css",
      title: "Acme AI",
    });
    expect(html).toContain(
      `content="default-src 'none'; script-src 'nonce-n0nce'; style-src vscode-webview://abc;"`,
    );
    expect(html).toContain(
      `<script nonce="n0nce" src="vscode-resource:/main.js">`,
    );
    expect(html).toContain(
      `<link rel="stylesheet" href="vscode-resource:/style.css">`,
    );
    expect(html).toContain("<title>Acme AI</title>");
    expect(html).not.toContain("http://");
  });

  test("escapes the title", () => {
    expect(
      buildHtml({
        cspSource: "x",
        nonce: "n",
        scriptUri: "s",
        styleUri: "c",
        title: "<b>",
      }),
    ).toContain("<title>&lt;b&gt;</title>");
  });
});
