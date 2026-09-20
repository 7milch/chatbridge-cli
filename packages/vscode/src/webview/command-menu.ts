import {
  type CommandInfo,
  SLASH_COMMANDS,
} from "@chatbridge/core/slash-commands";

/** One labelled group in the popup. */
export interface MenuSection {
  title: string;
  items: CommandInfo[];
}

/** The built-ins under "Commands", then the provider's own under its
 * display name. There is no second copy of the built-in table: it is
 * core's, the same one the parser and `/help` use. */
export function buildSections(
  providerTitle: string,
  custom: readonly CommandInfo[],
): MenuSection[] {
  const sections: MenuSection[] = [
    {
      title: "Commands",
      items: SLASH_COMMANDS.map(({ name, description }) => ({
        name,
        description,
      })),
    },
    { title: providerTitle, items: [...custom] },
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
