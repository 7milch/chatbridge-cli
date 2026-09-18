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
      `content="default-src 'none'; img-src vscode-webview://abc; script-src 'nonce-n0nce'; style-src vscode-webview://abc;"`,
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

  test("carries the welcome block and the footer, both hidden by default", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain('<div id="welcome" hidden>');
    expect(html).toContain('<img id="banner" alt="" hidden>');
    expect(html).toContain('<p id="welcome-text"></p>');
    expect(html).toContain('<footer id="footer" hidden></footer>');
    expect(html.indexOf('id="welcome"')).toBeLessThan(
      html.indexOf('id="history"'),
    );
    expect(html.indexOf('id="composer"')).toBeLessThan(
      html.indexOf('id="footer"'),
    );
    expect(html).not.toContain("style=");
  });

  test("carries the queue list and the inline error slot", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain('<ul id="queue" hidden></ul>');
    expect(html).toContain('<div id="inline-error" hidden></div>');
    expect(html.indexOf('id="queue"')).toBeLessThan(
      html.indexOf('id="composer"'),
    );
    expect(html.indexOf('id="inline-error"')).toBeLessThan(
      html.indexOf('id="composer"'),
    );
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
