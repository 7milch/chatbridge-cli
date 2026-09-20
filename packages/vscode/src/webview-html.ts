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

/* The CSP allows no external font or image origin, so the icons are inline
 * SVG markup rather than a codicon font. `currentColor` + `fill: none`
 * makes them follow the theme and the button's own foreground, including
 * the vendor's `ui.sendButton` colours. */
const SVG =
  'viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_PLUS = `<svg ${SVG}><path d="M8 3v10M3 8h10"/></svg>`;
const ICON_SLASH = `<svg ${SVG}><path d="M10 3L6 13"/></svg>`;
const ICON_SEND = `<svg class="icon icon-send" ${SVG}><path d="M8 13V3.5M4 7l4-4 4 4"/></svg>`;
/* Shown instead of the arrow while a turn is in flight: Enter queues then.
 * Both icons ship in the markup because the webview bundle cannot import
 * this module (it is outside `src/webview/`); main.ts only toggles them. */
const ICON_QUEUE = `<svg class="icon icon-queue" hidden ${SVG}><path d="M3 4.5h7M3 8h7M3 11.5h4M12 9v5M9.5 11.5h5"/></svg>`;

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
<div id="notice" role="alert" hidden></div>
<ul id="queue" hidden></ul>
<div id="inline-error" hidden></div>
<form id="composer">
<div id="command-menu" role="listbox" aria-label="Command menu" hidden></div>
<div id="composer-box">
<div id="attachments"></div>
<textarea id="input" rows="2" placeholder="Message&#8230;"></textarea>
<div id="composer-actions">
<button id="attach" type="button" class="icon-button" aria-label="Attach files" title="Attach files">${ICON_PLUS}</button>
<button id="commands" type="button" class="icon-button" aria-label="Commands" title="Commands" aria-haspopup="listbox" aria-expanded="false" aria-controls="command-menu">${ICON_SLASH}</button>
<span id="composer-hint"></span>
<button id="send" type="submit" class="icon-button" aria-label="Send" title="Send (Enter)">${ICON_SEND}${ICON_QUEUE}</button>
</div>
</div>
</form>
<footer id="footer" hidden></footer>
<script nonce="${i.nonce}" src="${i.scriptUri}"></script>
</body>
</html>`;
}
