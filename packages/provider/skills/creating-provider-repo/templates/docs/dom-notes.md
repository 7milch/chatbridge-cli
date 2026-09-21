# DOM notes

Structure only. Never paste conversation text, internal URLs beyond the entry
and chat URL, or anything from browser storage.

Every constant in `src/selectors.ts` cites one of the sections below. A
section is done when it names a locator that matched the expected number of
elements on the observation date (`verify()` says `ok`), and the placeholder
line `Not yet observed.` is gone.

## Login

Not yet observed.

<!-- Fill from dom-discovery.md steps 1-4 (entry URL, entry-page census,
human login, then the chat URL seen as a member AND as a guest — the login
signal is the difference between those two). Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| ENTRY_URL | | n/a | n/a |
| SIGN_IN_CONTROL | | | |
| ACCOUNT_CONTROL | | | |
Notes (guest chat offered?, where a guest lands on the chat URL, localized labels, IdP origin, whether the login
page is on the chat page's own origin, MFA / emailed code): -->

## Chat page

Not yet observed.

<!-- Fill from dom-discovery.md step 4. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| CHAT_URL | | n/a | n/a |
Notes (redirects, `lang` attribute / locale, anything the page needs before
the composer appears): -->

## New chat

Not yet observed.

<!-- Fill from dom-discovery.md step 8. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| NEW_CHAT_BUTTON | | | |
Notes (a button or a URL? if a URL, NEW_CHAT_BUTTON stays empty and
`startNewChat` navigates to CHAT_URL; is the composer empty afterwards?): -->

## Composer

Not yet observed.

<!-- Fill from dom-discovery.md steps 4-5. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| COMPOSER | | | |
| SEND_BUTTON | | | |
Notes (hidden twins in census().composer, contenteditable or textarea,
localized labels, send button only while non-empty, or no send button at all
— then take the `sendMessage` VARIANT and press Enter): -->

## Messages

Not yet observed.

<!-- Fill from dom-discovery.md steps 5-6. Remove "Not yet observed." when done.
ASSISTANT_MESSAGE is recordTurn.stop().summary.streamingCollection.selector,
the stable selector for "every assistant turn"; if a placeholder turn is
reported, exclude it with `:not([…])` on the attribute that marks it.
ASSISTANT_MESSAGE_BODY is replyShape().contentRootWithin, already relative to
one turn (a ":scope > tag" form is valid; verify() checks it with `within`).
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| ASSISTANT_MESSAGE | | | |
| USER_MESSAGE | | | |
| ASSISTANT_MESSAGE_BODY | | | |
Notes (placeholder turn attribute, chrome inside a turn per
replyShape().chromeInsideContent, virtualized list?): -->

## Generation indicator

Not yet observed.

<!-- Fill from dom-discovery.md steps 5-7. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| STOP_BUTTON | | buttonsSwapped, steps 5 and 7 | n/a |
Notes (STOP_BUTTON exists too briefly for verify(); its evidence is the same
locator appearing and going in both recordings. doneCandidates[0], buttonsSwapped send → stop → nothing, or a
`data-state` / `aria-busy` attribute — then take the `waitForResponse`
VARIANT; if doneCandidates is empty, say so and rely on the stability read): -->

## Errors and rate limits

Not yet observed.

<!-- Fill from dom-discovery.md step 2, plus anything seen by accident.
Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Value | Seen as |
|---|---|---|
| CHALLENGE_TITLE | | document.title of the interstitial |
Notes (bot challenge in headless — suggest --headful, never evasion; IdP
refusal page; rate-limit banner and how long it lasts; session expiry): -->

## Streaming behaviour

Not yet observed.

<!-- Fill from dom-discovery.md steps 5-7. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
Which element grows while the reply streams (summary.streamingElement)?
How is it told apart from the previous turn's element (assistant/user count,
a busy attribute, a turn id)?
replyShape():
- contentRootWithin:
- codeLanguage: (class on <pre>/<code>, a header label — then the language is
  a known loss — or nothing)
- chromeInsideContent: (buttons, toolbars, code-block headers, citations)
Notes (chunk cadence, does the content child exist before the first chunk? if
not, streaming.responseText returns undefined until it does): -->
