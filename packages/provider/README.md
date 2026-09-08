# @chatbridge/provider

The provider contract for [chatbridge](https://github.com/7milch/chatbridge-cli): the interface service-specific browser behaviour implements.

## Optional: `detectBlock`

`detectBlock(page)` lets a provider tell a bot challenge or an IdP refusing
the automated browser apart from an expired login. The core calls it only
after `isLoggedIn` returned `false`. Return a short description to raise
`BlockedError` (CLI exit 6, message suggests `--headful`); return
`undefined` for an ordinary logged-out page. Example for a Cloudflare
interstitial:

```typescript
async detectBlock(page) {
  return (await page.title()) === "Just a moment..." ? "challenge page" : undefined;
}
```

Detecting a block is all the framework does; evading it is out of scope.
