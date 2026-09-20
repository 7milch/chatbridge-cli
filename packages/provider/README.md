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
