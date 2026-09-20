# Milestone 15b: Provider-defined URL hooks

Issue: #84, under milestone 15 (tracking issue #83). Ships as v0.9.0
together with the slash commands spec
(`2026-09-20-provider-slash-commands-design.md`).

## Goal

A Provider can register URL hooks for the interactive UIs (TUI and VSCode).
When a typed message contains a URL that matches a hook, the hook resolves
it — a company Confluence page fetched by a script with a PAT, say — and the
content is appended to the prompt as an attachment, exactly the way `@file`
mentions are. The history shows the hook's label as an attachment line; only
the service sees the content.

Out of scope: one-shot mode (it joins `@file` mentions in #75); any fetching
by the framework itself; any credential handling.

## Boundaries kept

- **Auth state, not credentials.** The framework never fetches a URL and
  never sees a token. `resolve(url)` is the provider's function; how it gets
  the content (a Python script and a PAT, a REST call, a shared browser) is
  the provider's business and stays in the provider repository.
- **UI is not core.** Expansion is a pure function from text to
  `{ prompt, attachments }`; both UIs call it and render the attachments
  they already know how to render.

## Section 1: Provider API (`packages/provider`)

```ts
export interface UrlHookResult {
  /** Shown in the history as the attachment line, e.g. "Confluence: Title". */
  label: string;
  content: string;
}

export interface UrlHook {
  /** Which URLs this hook takes. A RegExp is tested with `.test`. */
  match: RegExp | ((url: string) => boolean);
  /** Fetch and return the content. Throw with a message meant for the user
   * when it cannot ("403 from Confluence", "script not found"). */
  resolve(url: string): Promise<UrlHookResult>;
}

export interface Provider {
  // ...existing members...
  /** Optional. Tried in order for every URL in a message; first match wins. */
  urlHooks?: UrlHook[];
}
```

`defineProvider` throws when a `match` RegExp carries the `g` or `y` flag
(`lastIndex` makes `.test` stateful).

## Section 2: core `expand-url-hooks.ts`

```ts
export interface UrlExpansion {
  prompt: string;          // text, then one fenced section per resolved URL
  attachments: Attachment[];
}

export class UrlHookError extends Error { readonly problems: string[] }

export async function expandUrlHooks(
  text: string,
  hooks: readonly UrlHook[],
  opts: { timeoutMs: number; alreadyBytes?: number },
): Promise<UrlExpansion>;
```

- URL detection: every maximal token matching `/https?:\/\/\S+/g`. A
  trailing `)`, `.`, `,`, `>` or quote is stripped (Markdown and prose put
  them right after links). The same URL twice is resolved once and attached
  once.
- For each URL, the first hook whose `match` accepts it resolves it; an
  unmatched URL is left as plain text, nothing happens.
- All matched URLs resolve in parallel, each under a timeout of
  `opts.timeoutMs` (the session's `timeoutMs`, which the UIs already have).
  A throw, a timeout, or a result over `MAX_FILE_BYTES` becomes one problem
  line `"<url>: <message>"`. If any problem exists, `UrlHookError` is
  thrown with all of them, like `MentionError`, so the user fixes them at
  once.
- `MAX_TOTAL_BYTES` applies to `alreadyBytes` (the `@file` bytes from the
  mention expansion that ran first) plus every hook result.
- `prompt` is `text` followed by `formatAttachment(label, content)` per
  result, in URL order; `attachments` carries `{ path: label, bytes }`.
  `Attachment.path` is a display string already, so reusing it costs no
  type change; its doc comment is widened to say so.

`UrlHookError` and `MentionError` stay separate classes (different packages);
both UIs treat them the same way (see below).

## Section 3: TUI

`chat-model.ts` `runTurn` runs `expandMentions` (cli, cwd-based) and then
`expandUrlHooks` on the result's prompt with the mention bytes as
`alreadyBytes`, merging attachments in that order. `UrlHookError` is handled
exactly like `MentionError`: error entry, input refilled (or queue entry put
back), model stays idle. `expandUrlHooks` runs only when the provider has
hooks; otherwise nothing changes. The `expand` option on `ChatModel` keeps
its signature and now covers both steps, so tests that inject `expand` are
untouched.

Expansion already runs after the session opened (status `busy` under the
open session), so the timeout is the session's.

## Section 4: VSCode

`SessionController.startTurn` calls `expandUrlHooks(text, hooks, ...)` before
building the sections, appending the resulting attachments after the dropped
or pasted ones. A `UrlHookError` returns `{ ok: false, message }` from
`send` and pushes an error entry, the way an empty send or an open failure
already reports; the text is left in the composer by the webview when
`ok` is false (it already does this for other failures — verify, and add if
not). Queued entries are expanded when they start, not when queued, so a
hook failure surfaces at the same point as in the TUI.

## Section 5: tests

- provider: `defineProvider` rejects `g`/`y` RegExp hooks.
- core `expand-url-hooks.test.ts`: no hooks → unchanged; unmatched URL →
  unchanged; matched → prompt has the fenced section and one attachment;
  trailing punctuation stripped; duplicate URL once; first hook wins;
  parallel resolves; throw → `UrlHookError` with the URL in the line;
  timeout; per-file and total size limits; `alreadyBytes` counted.
- TUI: hook attachment appears on the user entry; `UrlHookError` refills the
  input and keeps idle; a queued entry is put back.
- VSCode: controller attaches hook results after pending attachments; error
  path returns `ok: false`.
- Fixture: the dummy provider gains a hook matching
  `https://example.test/` that returns fixed content.

## Section 6: docs

README provider section: a `urlHooks` example that shells out to a script
(illustrative, no real service). Note that the framework never fetches and
that credentials belong to the provider's script and environment.
