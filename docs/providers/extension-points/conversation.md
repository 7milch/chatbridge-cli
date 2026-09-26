# `conversation`

Optional `ProviderConversation` that lets an interactive UI return to the
same service-side conversation after the browser was closed: an idle
timeout close, Ctrl+R in the TUI, `/reopen`, or the VSCode Reopen command.
The contract is `ProviderConversation` in `@chatbridge/provider`;
`urlConversation` is the built-in helper for the common case. The restore
logic lives in `@chatbridge/core` (`chat-session.ts`).

```ts
export interface ProviderConversation {
  handle(page: Page): Promise<string | undefined>;
  open(page: Page, handle: string): Promise<void>;
}
```

The handle is an opaque, provider-owned string. Core stores it in memory
only, never on disk, and never logs it. It must never embed a credential.
Cross-process resume (handing the handle to a different chatbridge
process) is not implemented; see backlog #119.

## What the framework does with it

- `handle(page)` runs after every turn, under a 5 s budget
  (`Math.min(timeoutMs, HANDLE_BUDGET_MS)`). A non-empty string result is
  kept as the current handle; `undefined`, an empty string, or a throw
  leaves the previous handle in place. The error is dropped without being
  reported, because it may name the conversation.
- `open(page, handle)` runs on the chat page, after the login check
  (`isLoggedIn`), only when the UI is reopening with a remembered handle.
  Throw when the conversation cannot be opened; the framework falls back
  to a new chat instead of failing the reopen.

### Outcomes

| Outcome | When | What happens next |
|---|---|---|
| restored | `open` returned and the page's origin equals `chatUrl`'s origin | The conversation is shown as restored. |
| failed | `open` threw, or it returned but left the page on another origin | `goto(chatUrl)`, then `startNewChat`. |
| timeout | The restore budget expired with `open` still running | The page is abandoned (closed or killed), a new browser is launched, `startNewChat` runs there. |

A restore never fails the whole open: at worst the user gets a fresh chat
instead of the old one. The UI shows one of two notes next to the
separator, from `@chatbridge/core`'s `conversation-note.ts`:

- `RESTORED_NOTE` = `"conversation restored"`
- `NOT_RESTORED_NOTE` = `"conversation could not be restored"`

See [contract.md](../contract.md#4-closing-a-session) for how a close and
a restore attempt can overlap.

`/new` and `/logout` forget the remembered handle; the next open starts a
new chat regardless of what `handle` last returned.

## `urlConversation`

The built-in helper for the common case: the conversation id lives in the
page URL.

```ts
export function urlConversation(options: {
  match: RegExp | ((url: string) => boolean);
}): ProviderConversation;
```

- `handle` returns `page.url()` when `match` accepts it, `undefined`
  otherwise.
- `open` navigates to the handle with `page.goto(handle)`, then checks the
  resulting URL still matches `match`. It throws `"The handle is not a
  conversation URL."` when the handle itself does not match, and `"The
  conversation did not open."` when the navigation lands somewhere `match`
  rejects (a service redirecting an unknown id back to the plain chat page
  must read as a failure, not as a restore).
- `match` is tested against the whole URL, including any query string or
  fragment. Do not anchor it with `$` when a real conversation URL can
  carry one; prefer a form such as `/\/c\/[0-9a-f-]+(?:[/?#]|$)/`.
- A `RegExp` `match` must not carry the `g` or `y` flag: `.test` would
  become stateful across calls.
- A `match` that never matches makes `handle` return `undefined` forever;
  nothing is ever restored.

## Minimal template

```ts
conversation: urlConversation({
  match: /\/c\/[0-9a-f-]+(?:[/?#]|$)/,
}),
```

For a service whose conversation id is not in the URL, write `handle` and
`open` by hand:

```ts
conversation: {
  async handle(page) {
    const id = await page.getAttribute("[data-conversation-id]", "data-id");
    return id ?? undefined;
  },
  async open(page, handle) {
    await page.goto(chatUrl);
    await page.locator(`[data-conversation-id="${handle}"]`).click();
    await page.locator(`[data-active-conversation="${handle}"]`).waitFor();
  },
},
```

## Recipe

- [conversation/dummy-url-conversation.md](../recipes/conversation/dummy-url-conversation.md)
  — `urlConversation` keyed on the dummy chat's `/chat/c/<id>` path.
