import { describe, expect, test } from "bun:test";
import {
  type CommandInfo,
  SLASH_COMMANDS,
} from "@chatbridge/core/slash-commands";
import {
  CommandMenuModel,
  type MenuKeyEvent,
  buildSections,
  buttonMenuAction,
  insertCommand,
} from "./command-menu.js";

const custom: CommandInfo[] = [
  { name: "title", description: "Rename this chat" },
  { name: "shout", description: "Send in upper case" },
];

describe("buildSections", () => {
  test("the built-ins first, under Commands", () => {
    const [first] = buildSections("Dummy Chat", []);
    expect(first?.title).toBe("Commands");
    expect(first?.items.map((c) => c.name)).toEqual(
      SLASH_COMMANDS.map((c) => c.name),
    );
    expect(first?.items.map((c) => c.description)).toEqual(
      SLASH_COMMANDS.map((c) => c.description),
    );
  });

  test("the provider's commands follow, under its display name", () => {
    const sections = buildSections("Dummy Chat", custom);
    expect(sections).toHaveLength(2);
    expect(sections[1]).toEqual({ title: "Dummy Chat", items: custom });
  });

  test("an empty section is dropped", () => {
    expect(buildSections("Dummy Chat", [])).toHaveLength(1);
  });
});

describe("CommandMenuModel", () => {
  test("flattens the sections in order and selects the first item", () => {
    const m = new CommandMenuModel(buildSections("Dummy Chat", custom));
    expect(m.items.map((c) => c.name)).toEqual([
      ...SLASH_COMMANDS.map((c) => c.name),
      "title",
      "shout",
    ]);
    expect(m.selectedIndex).toBe(0);
    expect(m.selected?.name).toBe("login");
  });

  test("move wraps at both ends", () => {
    const m = new CommandMenuModel([{ title: "Commands", items: custom }]);
    m.move(1);
    expect(m.selected?.name).toBe("shout");
    m.move(1);
    expect(m.selected?.name).toBe("title");
    m.move(-1);
    expect(m.selected?.name).toBe("shout");
  });

  test("an empty menu has no selection and move is a no-op", () => {
    const m = new CommandMenuModel([]);
    expect(m.items).toEqual([]);
    expect(m.selectedIndex).toBe(-1);
    expect(m.selected).toBeUndefined();
    m.move(1);
    expect(m.selectedIndex).toBe(-1);
  });

  test("selectedIndex can be set directly, as a click does", () => {
    const m = new CommandMenuModel([{ title: "Commands", items: custom }]);
    m.selectedIndex = 1;
    expect(m.selected?.name).toBe("shout");
  });
});

describe("insertCommand", () => {
  test("an empty input becomes the command plus a space", () => {
    expect(insertCommand("", "help")).toEqual({ text: "/help ", cursor: 6 });
  });

  test("existing text is kept after the command", () => {
    expect(insertCommand("in French", "title")).toEqual({
      text: "/title in French",
      cursor: 7,
    });
  });

  test("the cursor sits after the space, ready for arguments", () => {
    const { text, cursor } = insertCommand("x", "new");
    expect(text.slice(0, cursor)).toBe("/new ");
  });
});

describe("buttonMenuAction", () => {
  const key = (k: string, mods: Partial<MenuKeyEvent> = {}): MenuKeyEvent => ({
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...mods,
  });

  test("the arrows move and Enter chooses", () => {
    expect(buttonMenuAction(key("ArrowDown"))).toBe("down");
    expect(buttonMenuAction(key("ArrowUp"))).toBe("up");
    expect(buttonMenuAction(key("Enter"))).toBe("choose");
  });

  test("Escape closes", () => {
    expect(buttonMenuAction(key("Escape"))).toBe("close");
  });

  test("Tab is left alone, so it moves focus and the menu closes with it", () => {
    expect(buttonMenuAction(key("Tab"))).toBe("pass");
    expect(buttonMenuAction(key("Tab", { shiftKey: true }))).toBe("pass");
  });

  test("any other key is left alone", () => {
    expect(buttonMenuAction(key("a"))).toBe("pass");
    expect(buttonMenuAction(key(" "))).toBe("pass");
    expect(buttonMenuAction(key("Home"))).toBe("pass");
  });

  test("an IME composition keeps every key, including Escape and the arrows", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(buttonMenuAction(key(k, { isComposing: true }))).toBe("pass");
      // Safari and older WebKit report the composition as keyCode 229 only.
      expect(buttonMenuAction(key(k, { keyCode: 229 }))).toBe("pass");
    }
  });

  test("Shift+Enter is a newline, never a choice", () => {
    expect(buttonMenuAction(key("Enter", { shiftKey: true }))).toBe("pass");
  });

  test("a modified key belongs to the editor or the workbench", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      for (const k of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
        expect(buttonMenuAction(key(k, { [mod]: true }))).toBe("pass");
      }
    }
  });
});
