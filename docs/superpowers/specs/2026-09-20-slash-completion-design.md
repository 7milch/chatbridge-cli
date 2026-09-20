# Milestone 16 (v0.9.x): `/` completion for slash commands

Issue: #86. Tracking issue of the milestone: #95. Builds on the command menu of
the VSCode layout spec (`2026-09-20-vscode-chat-view-layout-design.md`, §3);
pulled into this milestone because both share that menu.

## Goal

Typing `/` at the start of the input offers the built-in and the provider's
commands (name and description) in both UIs, the way `@` offers files. `/help`
stops being the only way to discover them.

Non-goals: completing command *arguments*, fuzzy matching, completion in
one-shot mode, completion in the TUI's shell mode (`!`), where `/` is an
ordinary character.

## 1. Shared logic (core)

`@chatbridge/core/slash-commands` gains these pure functions, used by both UIs
so they cannot drift. A third, `commandWordAt(text, cursor): { word, end } |
undefined`, returns the whole command word and its end offset; `slashPrefixAt`
is defined on top of it, and both UIs use it to replace the word on accept and
for the exact-match `Enter` rule.

```ts
/** The command word being typed, without the slash, when `text` starts with
 * "/" and the cursor is inside that first word (no whitespace before the
 * cursor). Otherwise undefined. "/" alone yields "". */
export function slashPrefixAt(text: string, cursor: number): string | undefined;

/** Built-ins first, then the provider's, each group in declaration order,
 * filtered to names starting with `prefix` (case-insensitive). */
export function matchCommands(
  prefix: string,
  custom: readonly CommandInfo[],
): CommandInfo[];
```

## 2. Behaviour (both UIs)

- The popup opens when `slashPrefixAt` yields a prefix with at least one match,
  updates on every edit and cursor move, and closes when the prefix no longer
  applies, when nothing matches, or on `Esc`.
- `↑`/`↓` move the selection. `Tab` accepts: the command word is replaced by
  `/name ` (trailing space) and the cursor lands after it, ready for arguments.
- `Enter` accepts too, **unless** the typed word already equals the selected
  command's name: then the popup closes and `Enter` submits as usual, so
  `/new⏎` stays one keystroke.
- Accepting never executes the command.

## 3. VSCode webview

The command menu module from the layout spec gains a `filter(prefix)` entry
point. The `/` button opens it unfiltered (both sections, headings shown); typing
opens the same menu filtered, with headings kept only for non-empty sections.
While the menu is open from typing, focus stays in the textarea and the keys
above are handled in the textarea's `keydown`; `aria-activedescendant` moves to
the textarea for that case.

## 4. TUI

`MentionPopup` already renders a selectable list under the input. Its rows
become `{ value: string; label: string }` (mentions pass the path for both), so
the same component lists `/name  description` rows. `ChatView.refreshPopup()`
asks `slashPrefixAt` first, then `mentionAtCursor`; the two cannot both apply,
since a mention needs an `@` word under the cursor and a command prefix needs
the cursor in the leading `/` word. The accept path branches on which kind is
showing. The popup hint line is unchanged.

## 5. Testing

- `slash-commands.test.ts`: `slashPrefixAt` (empty `/`, mid-word cursor, after
  a space, not at the start, multi-line input) and `matchCommands` (order,
  case, no match).
- `command-menu.test.ts`: filtering, headings of empty sections dropped.
- Webview input tests: open on `/`, Tab accept, Enter-submits-on-exact-match,
  Esc, closes after a space.
- `mention-popup.test.ts`: label/value rows. `chat-view.test.ts`: popup on `/`,
  accept replaces the word, exact match submits, none in shell mode, `@` popup
  unaffected.
