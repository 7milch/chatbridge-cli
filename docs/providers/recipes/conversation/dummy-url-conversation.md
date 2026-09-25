# Recipe: dummy `urlConversation`

## What it does

The bundled dummy provider keys the conversation handle on the page URL,
using the `urlConversation` helper: one line, no by-hand `handle`/`open`.

## The code

`examples/dummy-chat/provider.ts`:

```ts
    // The conversation id is in the URL once the first reply exists.
    conversation: urlConversation({ match: /\/chat\/c\/[a-z0-9]{8}$/ }),
```

## How the id gets into the URL

`examples/dummy-chat/server.ts`:

- The chat starts on `/chat`, with no conversation id yet.
- After the first reply, the server's JSON response carries a
  `conversation` id. The client-side script rewrites the address bar with
  `history.replaceState(null, "", "/chat/c/" + conversation)`, without a
  navigation. From that point `page.url()` ends in `/chat/c/<id>`, and
  `urlConversation`'s `match` accepts it.
- `GET /chat/c/<id>` serves the page pre-loaded with that conversation's
  earlier turns; an unknown id redirects back to `/chat`. That is what
  makes `open`'s second `match` check meaningful: navigating to a stale or
  invalid handle lands back on the plain chat page, which does not match,
  so `open` throws `"The conversation did not open."` and the framework
  falls back to a new chat.

Because `handle` just reads `page.url()`, it returns `undefined` for every
turn until the first reply lands, and the conversation URL from then on.

## Register it

The line above is one property of the same object literal passed to
`defineProvider`, alongside `streaming`, `commands`, and the rest of the
provider.

## Verify

```sh
bun run examples/dummy-chat/serve.ts &
bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts
```

Send one message, wait for the reply, then press Ctrl+R. The TUI shows a
`reopened · conversation restored` separator, and the earlier turn is
still on the page above it.

## The by-hand shape

For a service whose id is not in the URL, write `handle` and `open`
yourself; see the [extension-point page](../../extension-points/conversation.md#minimal-template)
for the shape.
