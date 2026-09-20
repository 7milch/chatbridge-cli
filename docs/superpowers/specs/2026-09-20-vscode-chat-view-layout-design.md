# Milestone 16 (v0.9.x): VSCode chat view layout

Issue: #97. Tracking issue of the milestone: #95.

## Problem

The chat view has one permanent control, a text `Send` button. New chat,
Reopen and Log in appear as buttons only while the controller is `dead`;
otherwise they need the command palette or a typed slash command. Files can be
attached only by drag and drop or paste. The composer is a bare textarea next to
a full-height button.

The layout below was chosen by the maintainer from HTML mockups (candidates
A–D, then a detailed A+C sample covering six states).

## Goals

1. Session actions are always one click away, in the native view title bar.
2. The composer is one box: input on top, an action row below
   (`+` attach, `/` commands … send).
3. No change to session behaviour, to message rendering, or to the vendor `ui`
   options. Existing vendor extensions keep working without a manifest change.

Non-goals: Markdown rendering,
per-message actions, a webview toolbar, restyling the history.

## 1. Native title bar

Actions live in VSCode's own view title bar, declared by the vendor manifest
under `contributes.menus["view/title"]` with `when: view == <id>.chat`:

| Command | Group | Icon |
|---|---|---|
| `<id>.newChat` | `navigation@1` | `$(new-chat)`, fallback `$(add)` |
| `<id>.reopen` | `navigation@2` | `$(refresh)` |
| `<id>.login` | `1_auth@1` (overflow `…`) | |
| `<id>.logout` | `1_auth@2` | |
| `<id>.installBrowser` | `2_setup@1` | |
| `<id>.help` | `3_help@1` | |

`navigation` items render as icons and VSCode folds them into `…` by itself
when the view is narrow. The two icon commands need an `icon` on their
`contributes.commands` entry.

`<id>.help` is a new command: it focuses the view and pushes the same `help`
history entry the webview's `/help` produces.

### Manifest compatibility

`createExtension` throws today when a required contribution is missing. A
vendor manifest written for 0.9.0 has neither the menus nor `<id>.help`, and a
patch release must not break it. So `manifest.ts` splits its checks:

- `missingContributions()` — unchanged list, still fatal.
- `recommendedContributions()` — new: the `<id>.help` command, the six
  `view/title` entries, and the two command icons. Missing ones are logged
  once at activation (`console.warn`, naming each entry) and are never fatal.
  `<id>.help` is registered regardless; an undeclared command is still
  callable, it just does not show in the palette.

A vendor that does not update its manifest gets the new composer, the `/`
menu and the notice card; only the title bar icons are absent, and the `/`
menu still reaches every action.

The dummy extension fixture, `packages/vscode/README.md` and the
`creating-provider-repo` skill carry the full manifest snippet.

## 2. Composer

```
┌──────────────────────────────────────────┐
│ [chip ✕] [chip ✕]                        │  attachments (only when present)
│ Message…                                 │  textarea, 2 rows min, 8 max
│ [+] [/]        Enter to send · …   [ ↑ ] │  action row
└──────────────────────────────────────────┘
```

- `#composer` becomes the box: input background, 1 px input border, 6 px
  radius; `:focus-within` paints the border with `--vscode-focusBorder`. The
  textarea inside has no border or background of its own.
- `#attachments` moves inside the box, above the textarea. Chips keep their
  look and their remove button.
- Placeholder is `Message…`. The key hint moves to the action row as muted
  text: `Enter to send · Shift+Enter newline`, or `Enter to queue` while a turn
  is in flight. The hint is hidden below 260 px of view width (container or
  media query) so the row never wraps.
- Icon buttons are 24 × 24, inline SVG (the CSP forbids external fonts;
  `style-src` and `img-src` stay as they are), each with `aria-label` and
  `title`.
- **Send** is the primary icon button (`↑`). `ui.sendButton` colours apply to
  it as they do to today's button. While a turn is in flight it shows the
  queue icon in the secondary button colours, with label `Queue`. It is
  disabled when the input is empty and there are no pending attachments.
- **`+`** opens the native file picker through a new `pickFiles` command (see
  §4). Drag and drop and paste are unchanged.
- **`/`** toggles the command menu (§3).
- The inline error line stays directly above the box; the footer stays below.

## 3. Command menu

A listbox popup anchored above the action row, full box width:

- Section `Commands`: `/new`, `/reopen`, `/login`, `/logout`, `/help`, each
  with a one-line description. Section `<display name>`: the provider's
  commands from the `config` message, with their descriptions; omitted when the
  provider has none.
- Choosing an entry inserts `/name ` at the start of the input and focuses it;
  it never executes. Arguments stay possible and the user confirms with Enter,
  exactly as when typing the command. If the input already has text, the
  command is inserted before it.
- Keyboard: `↑`/`↓` move, `Enter` chooses, `Esc` or a click outside closes and
  returns focus to the input. `role="listbox"` / `role="option"`,
  `aria-activedescendant` on the button, `aria-expanded` reflects the state.
- The list-building and keyboard logic live in their own module
  (`webview/command-menu.ts`) with no dependency on the button: #86 (same
  milestone, `2026-09-20-slash-completion-design.md`) opens the same menu from
  typing `/`.

The built-in names and descriptions are `SLASH_COMMANDS` from
`@chatbridge/core/slash-commands`, which the webview bundle already imports for
parsing; there is no second copy and no protocol change for them.

## 4. Protocol and host

- `WebviewCommand` gains `"pickFiles"`. The host handler calls
  `VscodeUi.pickFiles()` (new; `showOpenDialog` with `canSelectMany: true`) and
  feeds the chosen URIs to the existing `attachUris` handler, so size limits and
  error reporting are shared with drag and drop. Cancelling does nothing.
- `COMMAND_NAMES` is unchanged; `help` is registered from a separate
  optional list so `expectedContributions` stays as it is.
- Nothing else in `protocol.ts`, `SessionController` or `commands.ts` changes.

## 5. Dead state

The button group leaves the status line. While `dead`, a notice card sits
between the history and the composer: error-tinted background, error border,
one line of text (`Not logged in.` / `The chat stopped.`) and the three
buttons. The primary button follows the cause: `Log in` when `lastError` is
`AUTH_REQUIRED` or `AUTH_EXPIRED`, otherwise `Reopen`; the others are secondary.
`role="alert"` so it is announced. The status line keeps only the spinner and
progress text for `busy` / `opening` / `reopening`.

## 6. Unchanged

History and message styles, separators, the queue list and its position, the
welcome block, the footer, `ExtensionUiOptions`, drag and drop, paste chips,
take-back, keyboard shortcuts in the input.

## 7. Testing

- `webview-html.test.ts`: the new structure (box, action row, buttons with
  `aria-label`s, notice container), CSP unchanged.
- `command-menu.test.ts` (pure logic, no DOM or with the existing test DOM
  helper): sections, provider section omitted when empty, move/choose/close,
  insertion into empty and non-empty input.
- `manifest.test.ts`: `recommendedContributions()` reports missing menu
  entries, icons and `help`; a 0.9.0-style manifest has no *fatal* findings.
- `create-extension` / `commands.test.ts`: `pickFiles` routes the picked URIs
  through `attachUris`; cancel is a no-op; `<id>.help` pushes the help entry.
- `chat-view-bridge.test.ts`: the `pickFiles` command reaches its handler.
- Manual check in the Extension Development Host, recorded in the PR: dark and
  light theme, a high-contrast theme, 220 px and 330 px widths, keyboard-only
  pass (Tab order: input → `+` → `/` → send; menu keys), screen reader labels.
