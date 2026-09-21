# @chatbridge/provider

The provider contract for [chatbridge](https://github.com/7milch/chatbridge-cli): the interface service-specific browser behaviour implements.

## Optional: `detectBlock`

`detectBlock(page)` lets a provider tell a bot challenge or an IdP refusing
the automated browser apart from an expired login. The core calls it only
after `isLoggedIn` returned `false`. Return a short description to raise
`BlockedError` (CLI exit 6; the CLI suggests `--headful`); return
`undefined` for an ordinary logged-out page. Example for a Cloudflare
interstitial:

```typescript
async detectBlock(page) {
  return (await page.title()) === "Just a moment..." ? "challenge page" : undefined;
}
```

Detecting a block is all the framework does; evading it is out of scope.

## Optional: `responseFormat` and `elementToMarkdown`

`responseFormat` declares what `waitForResponse` (and `streaming.responseText`,
below) return: `"text"` (the default) is shown verbatim; `"markdown"` is
rendered as Markdown by UIs that support it (currently the TUI). Web chat
services render Markdown to HTML, and `textContent` flattens it, so use the
exported `elementToMarkdown(locator)` helper to turn a reply element's DOM
back into Markdown instead of writing your own converter:

```typescript
responseFormat: "markdown",

async waitForResponse(page) {
  const reply = page.locator(".message.assistant").last();
  await page.waitForSelector('[data-state="idle"]');
  return elementToMarkdown(reply);
},
```

`elementToMarkdown` runs a single dependency-free DOM walker inside the page
and covers headings, paragraphs, emphasis, inline and fenced code, lists,
blockquotes, links, tables, `hr`/`br`, images, and skips chrome such as copy
buttons and icons (`button`, `svg`, `[aria-hidden="true"]`).

## Optional: `streaming`

`streaming.responseText(page)` lets interactive UIs show the reply while it
is being written. Core polls it while `waitForResponse` is pending and hands
the result to the UI as partial text; completion, the final text and
timeouts still come only from `waitForResponse`. **`responseText` must never
return an earlier turn's text** — return `undefined` until you can tell the
new reply's element apart from the previous turn's. The dummy provider's
guard is the pattern: while busy with no new assistant element yet, the
count of assistant messages is still behind the count of user messages, so
it returns `undefined` rather than the stale last element:

```typescript
streaming: {
  async responseText(page) {
    const log = page.locator("#chat-log");
    if ((await log.getAttribute("data-state")) !== "busy") return undefined;
    const users = await log.locator(".message.user").count();
    const assistants = await log.locator(".message.assistant").count();
    if (assistants < users) return undefined; // still the previous turn's
    const last = log.locator(".message.assistant").last();
    return elementToMarkdown(last);
  },
  pollIntervalMs: 50, // default 250
},
```

`defineProvider` rejects a `streaming` without a `responseText` function and
a `pollIntervalMs` that is not a finite number greater than 0. Without
`onPartial` on the caller's side, or without `streaming` on the provider,
core never polls.

## Optional: `browser` and `idle`

`browser.reducedMotion` is the `prefers-reduced-motion` value emulated for
every context the runtime creates. It defaults to `"reduce"`: an idle
headless page that keeps animating is rasterised on the CPU for as long as
the session is open. Set `"no-preference"` only when the service
misbehaves under reduced motion; completion detection that keys on DOM
state rather than on a running animation never needs it.

`idle.timeoutMs` is the provider's default idle lifetime for an
interactive session (built-in default 86 400 000 — 24 h; `0` disables).
After that long without a turn, the browser is closed and the UI reopens it
on the next prompt. Users override it through the CLI config, the
`CHATBRIDGE_IDLE_TIMEOUT` environment variable, or the VSCode setting.

```typescript
browser: { reducedMotion: "reduce" },
idle: { timeoutMs: 2 * 60 * 60 * 1000 },
```

## Skills for coding agents

`@chatbridge/provider` ships two skills for coding agents (Claude Code,
Codex, …) that build and maintain a vendor repository: `creating-provider-repo`
scaffolds a new vendor-specific provider repository from a template, and
`upgrading-provider-repo` walks an existing vendor repository through bumping
`@chatbridge/*` and adopting new framework features. They live under
`node_modules/@chatbridge/provider/skills/`, so a vendor repository always has
the skills that match its installed framework version, and refreshes its copy
with one command, run after every bump:

```sh
rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
```

What to tell your coding agent:

- New vendor: "Use the creating-provider-repo skill for `<service URL>`."
- Existing vendor: "Bump `@chatbridge/*` to the latest and follow the
  upgrading-provider-repo skill."
- For one feature: "… and adopt Markdown replies."
