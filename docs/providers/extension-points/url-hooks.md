# `urlHooks`

A provider's `urlHooks` turn a link typed in an interactive prompt into an
attachment: the hook fetches whatever the URL points at, the framework
appends it to the prompt, the history shows only the hook's label. The
contract is `UrlHook` in `@chatbridge/provider`; the mechanics live in
`@chatbridge/core` (`expand-url-hooks.ts`).

## What the framework does with it

For every message typed in the TUI or the VSCode view:

1. Finds every `http(s)://…` token in the text as typed and trims the
   punctuation prose puts after a link (`.,;:!?'"]>`; a `)` only when it
   does not close a `(` inside the URL).
2. For each URL, tries `provider.urlHooks` in order and calls `resolve` on
   the first hook whose `match` accepts it. All URLs resolve in parallel.
3. Appends each result to the prompt in the `@file` attachment layout:

   ````
   <text as typed>

   ### <label>
   ```
   <content>
   ```
   ````

4. Shows `label` in the history; only the service sees `content`.

## Constraints

- `resolve` runs under the per-turn timeout in both UIs. Past it, the
  result is `<url>: timed out after <ms> ms`, and the whole message is
  refused (see [contract.md](../contract.md#timeouts-and-errors)).
- One result is capped at `MAX_FILE_BYTES` (200 KB): past it, the result
  is `<url>: <kb> KB exceeds 200 KB`. The whole message, `@file` mentions
  included, is capped at `MAX_TOTAL_BYTES` (1 MB).
- Throw an `Error` whose message is meant for the user
  (`403 from Jira: check JIRA_PAT`). Every failure in a message is
  collected into one `UrlHookError`; nothing is sent.
- A `RegExp` in `match` must not carry the `g` or `y` flag
  (`defineProvider` rejects it, because `.test` becomes stateful).
- URLs inside attached file content are not expanded; only the typed
  text is scanned.
- Interactive modes only (TUI and VSCode). One-shot `-p` does not run
  hooks. See [../users/interactive-mode.md](../users/interactive-mode.md#url-hooks)
  and [../users/vscode.md](../users/vscode.md#composer-and-attachments) for
  the user-facing behaviour.
- The framework never fetches and never sees a credential. Whatever the
  hook needs comes from the provider's own code and environment.

## Minimal template

```ts
import type { UrlHook } from "@chatbridge/provider";

export const myHook: UrlHook = {
  match: /^https:\/\/wiki\.example\.com\//,
  async resolve(url) {
    // Your code: fetch, a script, an API client. Throw an Error with a
    // message for the user on failure.
    return { label: "Wiki: <title>", content: "<body>" };
  },
};
```

Register it in `defineProvider({ urlHooks: [myHook] })`.

## A function `match`

`match` can also be a plain function, used with a boundary check instead
of a pattern. `examples/dummy-chat/provider.ts`:

```ts
    urlHooks: [
      {
        // Pages of the dummy chat itself, e.g. `${baseUrl}/login`.
        match: (url) => url.startsWith(baseUrl),
        async resolve(url) {
          // A real provider would run a script or call an API here; the
          // framework never fetches anything itself.
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${res.status} from dummy chat`);
          return {
            label: `Dummy: ${new URL(url).pathname}`,
            content: await res.text(),
          };
        },
      },
    ],
```

## Recipe

- [url-hooks/jira-datacenter.md](../recipes/url-hooks/jira-datacenter.md)
  — a Jira Data Center issue with its comments, over REST API v2 with a
  personal access token.
