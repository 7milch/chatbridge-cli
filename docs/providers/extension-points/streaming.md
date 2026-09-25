# `streaming`

Optional `ProviderStreaming` that lets interactive UIs show the reply while
it is being written. The contract is `ProviderStreaming` in
`@chatbridge/provider`; the polling loop lives in `@chatbridge/core`
(`chat-session.ts`, `pollPartial`).

## What the framework does with it

While `waitForResponse` is pending, and only when the UI asked for
partials (`send(prompt, { onPartial })`), core runs a loop on the same
`Page`:

1. Sleep `pollIntervalMs` (default 250, must be finite and greater than 0).
2. Call `streaming.responseText(page)`.
3. If it throws, skip this tick and sleep again on the next one.
4. Drop the result when it is `undefined`, not a string, or the same text
   as the last tick.
5. Otherwise call the UI's `onPartial` with the whole text so far, never a
   delta.

The loop stops as soon as `waitForResponse` settles, one way or the
other. Nothing is emitted after that point: completion, the final text
and any timeout still come only from `waitForResponse`. A `responseText`
call that hangs on a wedged page never delays the turn; the loop is not
awaited by the caller.

Text returned from `responseText` is in `responseFormat`, the same as
`waitForResponse`'s return value.

One-shot mode (`-p`) never streams: there is no UI to show partials to.

## Constraints

- `responseText` must never return an earlier turn's text. The trap is the
  moment right after `sendMessage` returns: the last assistant bubble on
  the page still belongs to the previous turn until the new one appears.
  Write `responseText` as read-only — it runs concurrently with
  `waitForResponse` on the same `Page`, and a close can run `isLoggedIn`
  mid-turn (see [contract.md](../contract.md#4-closing-a-session)).
- `pollIntervalMs` is optional; the built-in default is 250 ms.
- A throw from `responseText` costs nothing beyond that tick: the loop
  retries on the next one rather than spinning.

## Minimal template

```ts
streaming: {
  async responseText(page) {
    const bubble = page.locator(".message.assistant").last();
    if ((await bubble.count()) === 0) return undefined;
    return await bubble.innerText();
  },
},
```

This is the minimal shape only: it does not guard against reading the
previous turn's bubble. See the recipe for the three guards a real
provider needs.

## Recipe

- [streaming/dummy-response-text.md](../recipes/streaming/dummy-response-text.md)
  — the bundled dummy provider's `responseText`, with its three guards
  explained one by one.
