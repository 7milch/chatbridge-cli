# Recipe: dummy `responseText`

## What it does

`responseText` from the bundled dummy provider. It reads the last
assistant bubble while the page is busy, and stays `undefined` until the
bubble that belongs to the new turn actually exists.

## The code

`examples/dummy-chat/provider.ts`:

```ts
    streaming: {
      async responseText(page) {
        // Only while busy: once idle, the last assistant node may belong to
        // the previous turn until the next reply element is appended.
        const log = page.locator("#chat-log");
        if ((await log.getAttribute("data-state")) !== "busy") return undefined;
        const last = log.locator(".message.assistant").last();
        if ((await last.count()) === 0) return undefined;
        // Busy with no new element yet: the last node is the previous turn's.
        const users = await log.locator(".message.user").count();
        const assistants = await log.locator(".message.assistant").count();
        if (assistants < users) return undefined;
        const text = await elementToMarkdown(last);
        return text === "" ? undefined : text;
      },
      pollIntervalMs: 50,
    },
```

## The three guards

1. **Busy state.** `#chat-log[data-state]` flips to `"busy"` when a turn
   starts and back to `"idle"` when it completes. `responseText` only
   reads while busy: once idle, the last assistant node may still be the
   previous turn's, and nothing distinguishes it from a fresh one by
   content alone.
2. **Bubble exists.** Before the server appends the new assistant element,
   `.message.assistant` still only has the previous turn's nodes (or
   none, on the first turn). `last.count() === 0` catches the very first
   turn; the next guard catches every later one.
3. **Assistant count >= user count.** After a user's message is added the
   page briefly has one more `.message.user` than `.message.assistant`,
   because the server has not appended the reply bubble yet. Comparing
   the two counts tells "no new bubble yet" from "the new bubble is here,
   just still filling in" without any race on element identity.

Once all three guards pass, `elementToMarkdown(last)` reads the current
text of the (correct) bubble; an empty string is treated as "nothing yet"
just like `undefined`.

`pollIntervalMs: 50` is faster than the 250 ms default because the dummy
chat's reply chunks arrive quickly; a real provider tunes this to how
often its own reply actually changes.

## Register it

The object above is one property of the same literal passed to
`defineProvider`, alongside `waitForResponse` and the rest of the page
methods.

## Verify

```sh
bun run examples/dummy-chat/serve.ts &
bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts
```

Send a message and watch the reply grow in the TUI instead of appearing
all at once when the turn completes.
