import {
  type CommandInfo,
  SLASH_COMMANDS,
  commandWordAt,
  matchCommands,
  slashPrefixAt,
} from "@chatbridge/core/slash-commands";

/** One labelled group in the popup. */
export interface MenuSection {
  title: string;
  items: CommandInfo[];
}

const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  SLASH_COMMANDS.map((c) => c.name),
);

/** The built-ins under "Commands", then the provider's own under its
 * display name. There is no second copy of the built-in table: it is
 * core's, the same one the parser and `/help` use. `prefix` filters both
 * groups through core's `matchCommands`, so the menu and the TUI popup
 * cannot drift; no prefix, or an empty one, is the whole menu. A section
 * left without an entry is dropped, heading and all. */
export function buildSections(
  providerTitle: string,
  custom: readonly CommandInfo[],
  prefix = "",
): MenuSection[] {
  // A built-in and a provider command cannot share a name (defineProvider
  // rejects the collision), so membership in the built-in table is what
  // splits the flat match list back into the two groups.
  const matched = matchCommands(prefix, custom);
  const sections: MenuSection[] = [
    {
      title: "Commands",
      items: matched.filter((c) => BUILTIN_NAMES.has(c.name)),
    },
    {
      title: providerTitle,
      items: matched.filter((c) => !BUILTIN_NAMES.has(c.name)),
    },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** Selection over the flattened items. Deliberately free of the DOM and of
 * the `/` button: #86 drives the same model from typing `/`. */
export class CommandMenuModel {
  readonly sections: MenuSection[];
  readonly items: CommandInfo[];
  selectedIndex: number;

  constructor(sections: MenuSection[]) {
    this.sections = sections;
    this.items = sections.flatMap((s) => s.items);
    this.selectedIndex = this.items.length > 0 ? 0 : -1;
  }

  get selected(): CommandInfo | undefined {
    return this.items[this.selectedIndex];
  }

  /** Wraps around, so holding one arrow key cycles the list. */
  move(delta: 1 | -1): void {
    const n = this.items.length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
  }
}

/** The part of a `KeyboardEvent` the menu decides on. An interface rather
 * than the event itself so the decision is testable without a DOM. */
export interface MenuKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** What an open menu should do with a key. `"pass"` means the key is none of
 * the menu's business: the handler must neither `preventDefault` nor
 * `stopPropagation` it, so Tab still moves focus, Shift+Enter still makes a
 * newline and an IME still owns its candidate list.
 *
 * Any modifier disqualifies a key. Alt/Ctrl/Meta chords belong to the
 * workbench, and Shift turns Enter into a newline and the arrows into a
 * selection — none of them is a menu gesture. */
export function buttonMenuAction(
  e: MenuKeyEvent,
): "up" | "down" | "choose" | "close" | "pass" {
  // `isComposing` is not set by every engine; WebKit reports a composing key
  // as keyCode 229 instead. While an IME is composing, the arrows walk its
  // candidate list and Escape cancels the composition.
  if (e.isComposing || e.keyCode === 229) return "pass";
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return "pass";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "ArrowUp") return "up";
  if (e.key === "Enter") return "choose";
  if (e.key === "Escape") return "close";
  return "pass";
}

/** Choosing an entry never runs it: it writes `/name ` in front of whatever
 * is already typed and leaves the cursor after the space, so arguments can
 * follow and Enter confirms exactly as when the command was typed. */
export function insertCommand(
  input: string,
  name: string,
): { text: string; cursor: number } {
  const prefix = `/${name} `;
  return { text: prefix + input, cursor: prefix.length };
}

/** What a keydown should do while the menu is open from typing. `accept`
 * completes the word, `submit` means the typed word already *is* the selected
 * command — the caller closes the menu and lets the key through so the
 * composer sends, keeping `/new⏎` one keystroke — and `pass` leaves the key
 * to the textarea. */
export type MenuAction = "up" | "down" | "accept" | "submit" | "close" | "pass";

/** The typing mode's counterpart to `buttonMenuAction`, with the same two
 * guards first — an IME composition and any modifier chord are never menu
 * gestures, and here that also keeps Shift+Enter a newline and Shift+Tab a
 * focus move. */
export function typingMenuAction(
  e: MenuKeyEvent,
  text: string,
  cursor: number,
  selected: CommandInfo | undefined,
): MenuAction {
  if (e.isComposing || e.keyCode === 229) return "pass";
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return "pass";
  if (e.key === "Escape") return "close";
  if (selected === undefined) return "pass";
  const word = commandWordAt(text, cursor);
  // The cursor left the command word, so nothing here is a completion any
  // more — but the key that took it there is the textarea's, not the menu's,
  // and swallowing it would eat an ordinary character. The caret and input
  // listeners close the menu for this, within the same gesture.
  if (word === undefined) return "pass";
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Tab":
      return "accept";
    case "Enter":
      return word.word === selected.name ? "submit" : "accept";
    default:
      return "pass";
  }
}

/** Replaces the command word the cursor is in with `/name `, keeping whatever
 * follows it and landing the cursor after the space, ready for arguments.
 * With no command word under the cursor this is `insertCommand`, so the menu
 * behaves the same however it was opened. */
export function replaceCommandWord(
  input: string,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const word = commandWordAt(input, cursor);
  if (word === undefined) return insertCommand(input, name);
  const prefix = `/${name} `;
  const rest = input.slice(word.end);
  // The inserted trailing space already separates the arguments; a second
  // one would push them along on every completion.
  return {
    text: prefix + (rest.startsWith(" ") ? rest.slice(1) : rest),
    cursor: prefix.length,
  };
}

/** The prefix the typing menu should show for `text`, or undefined for no
 * menu at all. `dismissedText` is the text Escape closed the menu over: until
 * it is edited the menu stays shut, otherwise the very next caret event would
 * reopen it and Escape would do nothing. */
export function typingMenuPrefix(
  text: string,
  cursor: number,
  dismissedText: string | undefined,
): string | undefined {
  if (text === dismissedText) return undefined;
  return slashPrefixAt(text, cursor);
}
