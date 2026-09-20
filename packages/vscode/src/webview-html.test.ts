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

  test("carries the queue list, the notice slot and the inline error slot", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain('<ul id="queue" hidden></ul>');
    expect(html).toContain('<div id="inline-error" hidden></div>');
    expect(html).toContain('<div id="notice" role="alert" hidden></div>');
    expect(html.indexOf('id="notice"')).toBeLessThan(
      html.indexOf('id="queue"'),
    );
    expect(html.indexOf('id="queue"')).toBeLessThan(
      html.indexOf('id="composer"'),
    );
    expect(html.indexOf('id="inline-error"')).toBeLessThan(
      html.indexOf('id="composer"'),
    );
  });

  test("the composer is one box: attachments, a 2-row input, then the action row", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain('<div id="composer-box">');
    expect(html).toContain(
      '<textarea id="input" rows="2" placeholder="Message',
    );
    // The chips live inside the box now, above the input.
    expect(html.indexOf('id="composer-box"')).toBeLessThan(
      html.indexOf('id="attachments"'),
    );
    expect(html.indexOf('id="attachments"')).toBeLessThan(
      html.indexOf('id="input"'),
    );
    expect(html.indexOf('id="input"')).toBeLessThan(
      html.indexOf('id="composer-actions"'),
    );
  });

  test("every composer control is a labelled icon button, send last", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain('<button id="attach" type="button"');
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('<button id="commands" type="button"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="command-menu"');
    expect(html).toContain('<button id="send" type="submit"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('<span id="composer-hint"></span>');
    expect(html.indexOf('id="attach"')).toBeLessThan(
      html.indexOf('id="commands"'),
    );
    expect(html.indexOf('id="commands"')).toBeLessThan(
      html.indexOf('id="send"'),
    );
    // Both send icons ship in the markup: the bundle cannot import from
    // this module, so it only toggles their `hidden`.
    expect(html).toContain('class="icon icon-send"');
    expect(html).toContain('class="icon icon-queue" hidden');
  });

  test("the command menu is an empty listbox anchored in the composer", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain(
      '<div id="command-menu" role="listbox" aria-label="Command menu" hidden></div>',
    );
    expect(html.indexOf('id="composer"')).toBeLessThan(
      html.indexOf('id="command-menu"'),
    );
  });

  test("the icons are inline SVG: no external origin, no inline style", () => {
    const html = buildHtml({
      cspSource: "x",
      nonce: "n",
      scriptUri: "s",
      styleUri: "c",
      title: "t",
    });
    expect(html).toContain("<svg ");
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain("style=");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("@font-face");
    // The CSP is the one the first test pins; no origin was added for the
    // icons because they are markup, not resources.
    expect(html).toContain("default-src 'none'");
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
