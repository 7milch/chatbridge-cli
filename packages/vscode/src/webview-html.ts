export interface HtmlInputs {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The whole document; no inline script or style, no external origin. */
export function buildHtml(i: HtmlInputs): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${i.cspSource}; script-src 'nonce-${i.nonce}'; style-src ${i.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${i.styleUri}">
<title>${escapeHtml(i.title)}</title>
</head>
<body>
<div id="welcome" hidden><img id="banner" alt="" hidden><p id="welcome-text"></p></div>
<main id="history" aria-live="polite"></main>
<div id="status" hidden></div>
<div id="attachments"></div>
<form id="composer">
<textarea id="input" rows="3" placeholder="Message (Enter to send, Shift+Enter for a newline)"></textarea>
<button id="send" type="submit">Send</button>
</form>
<footer id="footer" hidden></footer>
<script nonce="${i.nonce}" src="${i.scriptUri}"></script>
</body>
</html>`;
}
