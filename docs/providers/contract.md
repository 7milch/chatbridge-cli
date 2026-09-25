# The Provider contract

A provider is one object of type `Provider` from `@chatbridge/provider`. It has seven required members. The framework launches the browser, loads and saves the auth state, and decides when to call each member. The provider only acts on the `Page` it is given.

This page says when each member is called and what it must guarantee. The optional members are in [extension-points/](extension-points/README.md). Wiring the provider into a CLI or a VSCode extension is in [define-provider.md](define-provider.md).

## The contract in one table

| Member | Type | Doc comment |
|---|---|---|
| `name` | `string` | Identifier; also names the auth-state storage file. |
| `chatUrl` | `string` | Chat page URL; the runtime navigates here before startNewChat. |
| `navigateToLogin` | `(page: Page) => Promise<void>` | Navigate to the login page (called during `auth login`, headful). |
| `isLoggedIn` | `(page: Page) => Promise<boolean>` | Login-completion check; also the auth-validity check at startup. |
| `startNewChat` | `(page: Page) => Promise<void>` | Bring the page to a state where a new chat can start. |
| `sendMessage` | `(page: Page, prompt: string) => Promise<void>` | Submit the prompt. Called once per turn on the same `Page` for a multi-turn conversation. |
| `waitForResponse` | `(page: Page) => Promise<string>` | Wait for response completion and return the response text. Must return the response to the most recent `sendMessage` only, never an earlier turn's. |

`Page` is Playwright's `Page`. A CLI loading a provider module checks that the default export has a string `name`, a string `chatUrl` and the five methods. Anything else exits 5; see [cli.md](../users/cli.md#where-the-provider-comes-from).

## Lifecycle

Every provider call runs on one `Page`. `sendMessage`, `waitForResponse` and a provider command's `run` never overlap one another. Two calls can overlap:

- `streaming.responseText` is polled while `waitForResponse` is still pending.
- A close (the user quits or resets mid-turn) runs `isLoggedIn` while a turn may still be pending.

Write `isLoggedIn` and `streaming.responseText` so they only read the page.

### 1. Opening a session

This runs for one-shot mode, for the first prompt of an interactive session, and again whenever the UI reopens the browser (after an idle close, `/new` or `/reopen`).

1. If no auth-state file exists for `name`, the open fails with `AuthRequiredError` (exit 2) before any browser work.
2. Chromium is launched with the saved storage state.
3. `page.setDefaultTimeout(<opening timeout>)`.
4. `page.goto(chatUrl)`.
5. `isLoggedIn(page)`. If it returns `false`: when the provider has `detectBlock`, it is called; a description becomes `BlockedError` (exit 6). Otherwise the open fails with `AuthExpiredError` (exit 3).
6. If the UI passed a conversation handle and the provider has `conversation`, `conversation.open(page, handle)` runs. If it fails, the page goes back to `chatUrl`. If it runs out of its budget, the browser is closed and launched again, and `goto` and `isLoggedIn` repeat, so `isLoggedIn` can run twice in one open. See [extension-points/conversation.md](extension-points/conversation.md).
7. Otherwise, or after a failed restore, `startNewChat(page)`.
8. The page's default timeout becomes the per-turn timeout, and the idle watch starts.

If a step after the launch fails, the browser is closed before the error surfaces. A failed attempt is retried when the opening phase has retries, except for no auth state, expired auth state, a block, or a missing Chromium. The opening timeout and the retry count are resolved as described in [configuration.md](../users/configuration.md#opening-phase).

### 2. A turn

1. `sendMessage(page, prompt)`.
2. `waitForResponse(page)`. While it is pending, an interactive UI polls `streaming.responseText(page)` if the provider has `streaming`. See [extension-points/streaming.md](extension-points/streaming.md).
3. If the provider has `conversation`, `conversation.handle(page)` is asked for the current conversation. Its budget is the per-turn timeout or 5 s, whichever is shorter, and its errors are swallowed.

On a timeout, `isLoggedIn` runs again (and `detectBlock` after a `false`). A lost login is reported as exit 3 or 6 instead of the timeout. If the page is still logged in, or the check itself fails, the original timeout is reported. The session stays usable after a timeout.

### 3. A provider command

`run(page, args)` of a [provider command](extension-points/commands.md) runs under the per-turn timeout, with the same timeout diagnosis as a turn. It never overlaps a turn.

### 4. Closing a session

1. The idle watch stops.
2. `isLoggedIn(page)`.
3. `true`: the storage state is saved over the auth-state file. Services rotate tokens, so the state from login goes stale. `false`: nothing is saved, and progress shows:

   ```
   Session is no longer logged in; auth state not saved.
   ```

4. The browser closes.

When a close hangs, the UI kills the browser instead. A kill saves nothing.

### 5. `auth login`

1. Chromium is launched headful, with the saved storage state if one exists.
2. `page.setDefaultTimeout(30_000)`.
3. `navigateToLogin(page)`.
4. Progress shows `Please log in to <name>.`
5. `isLoggedIn(page)` is polled once a second, with no deadline, until it returns `true`. MFA may take a while.
6. The storage state is saved, and the browser closes.

Ctrl-C kills the browser, saves nothing, and exits 130. How the auth state is stored is in [auth-and-browser.md](auth-and-browser.md).

### 6. One-shot mode

Open (with the idle close disabled), one turn, close. `-p` is described in [cli.md](../users/cli.md#one-shot-mode).

## Each member

### `name`

- **Used:** as the provider's identifier in messages, and as the auth-state file name.
- **Must:** match `/^[a-z0-9][a-z0-9._-]{0,63}$/`.
- **When it does not:** the CLI exits 5.

### `chatUrl`

- **Used:** every open navigates here before `isLoggedIn`. A restored conversation must end on the same origin as `chatUrl`, or it counts as not restored.
- **Must:** be a URL that shows the chat when logged in, and that the service redirects away from (or renders differently) when not.

### `navigateToLogin(page)`

- **Called:** only during `auth login`, in a headful browser, under a 30 s default timeout.
- **Must:** land on a page from which the user can log in by hand. It does not fill in anything; the framework never handles credentials.
- **When it does not:** if it throws or times out, `auth login` fails and the browser closes. A Playwright timeout reads `Timed out during navigateToLogin after 30000 ms.`

### `isLoggedIn(page)`

- **Called:** at every open, after `goto(chatUrl)`. After every timeout in a turn or command. At every close. Once a second during `auth login`.
- **Must:** be cheap and free of side effects: it runs on a live chat page and must not navigate it. Decide from what the page shows, for example whether the chat input exists. During login the page is on the service's login screens; return `false` there rather than throw.
- **When it returns `false`:** at open, `AuthExpiredError` (exit 3), or `BlockedError` (exit 6) when `detectBlock` describes a block. After a timeout, the same two errors replace the timeout. At close, the auth state is not saved.
- **When it throws:** at open, the error ends that attempt. At close, the error is reported and the browser still closes:

  ```
  Could not save auth state: <message>
  ```

  During `auth login`, a throw ends the login.

### `startNewChat(page)`

- **Called:** once per open, after the login check, unless a conversation was restored. The page is on `chatUrl`, or wherever the service redirected it.
- **Must:** leave the page ready for `sendMessage`: a fresh, empty chat with the input visible. Wait for that state rather than assume it.
- **When it does not:** a throw fails the open attempt (and is retried if retries are configured). A Playwright timeout reads `Timed out during startNewChat after <ms> ms.`

### `sendMessage(page, prompt)`

- **Called:** once per turn, on the same `Page` for the whole session. Never concurrently: a second send while one is pending is rejected before it reaches the provider.
- **Must:** submit the prompt and return. Do not wait for the reply; completion is `waitForResponse`'s job. `prompt` may contain newlines.
- **When it does not:** a Playwright timeout becomes `ResponseTimeoutError`:

  ```
  Timed out during sendMessage after <ms> ms.
  ```

### `waitForResponse(page)`

- **Called:** right after `sendMessage` returns.
- **Must:** wait until the reply is complete, then return the reply to that `sendMessage` only. Return it in `responseFormat`: `"text"` (the default) is shown verbatim; `"markdown"` is rendered by UIs that support it, and `elementToMarkdown` produces it from a DOM element.
- **The classic bug:** returning the previous turn's text. Just after `sendMessage`, the last reply element on the page is still the old one. Wait for the new element, then for completion.
- **Completion:** key it on DOM state that the service sets on purpose, such as a busy or idle attribute, or a stop button disappearing. Do not key it on an animation, a typing cursor or a fixed delay.
- **When it does not:** a Playwright timeout becomes `ResponseTimeoutError` (`Timed out during waitForResponse after <ms> ms.`, exit 4), unless the login check shows the session was lost.

## Timeouts and errors

Every provider call runs under `page.setDefaultTimeout`, so any Playwright wait without its own `timeout` option inherits it:

| Phase | Default timeout |
|---|---|
| Opening (`goto`, `isLoggedIn`, `detectBlock`, `conversation.open`, `startNewChat`) | The opening timeout. See [configuration.md](../users/configuration.md#opening-phase). |
| Turns, provider commands and close | The per-turn timeout. See [configuration.md](../users/configuration.md#per-turn-timeout). |
| `auth login` | 30 s. |

Except where noted below, a Playwright `TimeoutError` thrown out of a provider call is mapped to `ResponseTimeoutError` with the step name:

```
Timed out during <step> after <ms> ms.
```

Any other error passes through with its own message. The exceptions:

- `isLoggedIn` during `auth login` is not mapped: any error, a timeout included, ends the login as it was thrown.
- Errors from `streaming.responseText`, `conversation.open` and `conversation.handle` are swallowed. A failed poll is retried on the next tick; a failed restore falls back to a new chat; a failed handle keeps the previous one.

Throw an `Error` with a message meant for the user. The exit codes are listed in [cli.md](../users/cli.md#exit-codes).

Two things follow from this:

- A wait with no deadline of its own (a `while` loop over `page.evaluate`) is not bounded by the timeout. Use Playwright waits (`locator.waitFor`, `page.waitForSelector`, `expect`-style polling) so the timeout applies.
- A `timeout` option you pass yourself wins over the default. A shorter one is fine for a probe; a longer one lets a turn outlive the user's `--timeout`.

## Worked example

The reference implementation is `examples/dummy-chat/provider.ts`. It targets a small dummy chat bundled with the repository. Read the whole file; these are its four core methods:

```ts
    async isLoggedIn(page) {
      // On /chat with a valid session the input exists; when redirected
      // to /login it does not.
      return (await page.locator("#message-input").count()) > 0;
    },

    async startNewChat(page) {
      // The dummy chat has no history; being on the chat page is enough.
      await page.locator("#message-input").waitFor({ state: "visible" });
    },

    async sendMessage(page, prompt) {
      await page.locator("#message-input").fill(prompt);
      await page.locator("#send-button").click();
    },

    responseFormat: "markdown",

    async waitForResponse(page) {
      const log = page.locator("#chat-log");
      const last = log.locator(".message.assistant").last();
      await last.waitFor({ state: "attached" });
      // The busy → idle transition is the completion signal; partial text is
      // what `streaming.responseText` is for.
      await page.waitForSelector('#chat-log[data-state="idle"]');
      return elementToMarkdown(last);
    },
```

What to notice:

- `isLoggedIn` uses `count()`, which never waits and never throws on a missing element. It returns `false` on the login page.
- `startNewChat` waits for the input to be visible instead of assuming it is.
- `sendMessage` fills and clicks, then returns.
- `waitForResponse` keys completion on the log's `data-state` attribute turning `idle`. It returns Markdown because the provider sets `responseFormat: "markdown"`.

The dummy's `waitForResponse` is simple because the dummy chat marks the log busy synchronously on submit. On a real service, first make sure you are looking at the new reply element (compare the count of replies before and after `sendMessage`, or wait for the busy state to start), then wait for it to finish.
