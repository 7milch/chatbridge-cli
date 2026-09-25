# `detectBlock`

Optional `(page: Page) => Promise<string | undefined>` that tells a bot
challenge or an identity provider refusing automation apart from an
ordinary expired login. The contract is `Provider["detectBlock"]` in
`@chatbridge/provider`; the call site is `ChatSession.assertLoggedIn` in
`@chatbridge/core` (`chat-session.ts`).

## What the framework does with it

Core calls `detectBlock` only after `isLoggedIn(page)` has returned
`false`:

- At open, once during the opening phase (see
  [contract.md](../contract.md#lifecycle)).
- After a turn or command times out, as part of diagnosing the timeout.

It is never called during login and never during close. `isLoggedIn`
alone drives both of those.

If `detectBlock` is absent, or it returns `undefined`, core throws
`AuthExpiredError`:

```
Auth state for "<name>" is no longer valid. Run `auth login` again.
```

If it returns a string, core throws `BlockedError`:

```
Blocked by "<name>": <description>.
```

`BlockedError` exits 6 in the CLI, with a remedy appended:

```
Blocked by "<name>": <description>. Try --headful.
```

In VSCode the remedy is a settings hint instead:

```
Set the "<id>.headless" setting to false and try again.
```

Neither `AuthExpiredError` nor `BlockedError` is retried by the opening
phase's `retries`: logging in again, or opening again, would not clear a
block. See [auth-and-browser.md](../auth-and-browser.md#errors) for the
full error table and [contract.md](../contract.md#timeouts-and-errors)
for how a turn timeout reaches this same check.

## Constraints

- Runs under the same step timeout as `isLoggedIn`: a hang inside
  `detectBlock` is itself a `ResponseTimeoutError`.
- Must not throw on an ordinary logged-out page. Throwing there turns a
  routine "please log in again" into an unrelated crash.
- Return a short description, not a sentence: it is interpolated into
  `Blocked by "<name>": <description>.`. Lower case, no trailing period.
- Only implement it when the service can show a page that a fresh login
  would not get past. A service that only ever shows its own login page
  does not need it.
- See [auth-and-browser.md](../auth-and-browser.md#bot-protection) for the
  project's stance: this hook exists so the user gets exit 6 and the
  `--headful` hint, not so the framework works around the block itself.

## Minimal template

The bundled dummy provider's `detectBlock`, verbatim:

```ts
    async detectBlock(page) {
      // The challenge page has no chat controls, so isLoggedIn is false;
      // the title tells the two apart.
      return (await page.title()) === "Just a moment..."
        ? "challenge page"
        : undefined;
    },
```

See `examples/dummy-chat/provider.ts` for it in context.

## Related

- [../contract.md](../contract.md#lifecycle) — when `isLoggedIn` and
  `detectBlock` run relative to the rest of the opening phase.
- [../auth-and-browser.md](../auth-and-browser.md#errors) — the full
  error table and messages.
- [../auth-and-browser.md](../auth-and-browser.md#headless-and-headful) —
  what `--headful` and `<id>.headless` change.
- [../../users/cli.md](../../users/cli.md#exit-codes) — the CLI's exit
  code table.
