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
  replaceCommandWord,
  typingMenuAction,
  typingMenuPrefix,
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

describe("buildSections: filtering", () => {
  test("a prefix keeps only the matching entries", () => {
    const sections = buildSections("Dummy Chat", custom, "lo");
    expect(sections.map((s) => s.title)).toEqual(["Commands"]);
    expect(sections[0]?.items.map((c) => c.name)).toEqual(["login", "logout"]);
  });

  test("a section with no match is dropped, heading and all", () => {
    const sections = buildSections("Dummy Chat", custom, "t");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Dummy Chat");
    expect(sections[0]?.items.map((c) => c.name)).toEqual(["title"]);
  });

  test("both sections survive a prefix that matches in each", () => {
    const sections = buildSections(
      "Dummy Chat",
      [...custom, { name: "log", description: "Show the log" }],
      "lo",
    );
    expect(sections.map((s) => s.items.map((c) => c.name))).toEqual([
      ["login", "logout"],
      ["log"],
    ]);
  });

  test("no match at all is no section", () => {
    expect(buildSections("Dummy Chat", custom, "zz")).toEqual([]);
  });

  test("the empty prefix is the unfiltered menu", () => {
    expect(buildSections("Dummy Chat", custom, "")).toEqual(
      buildSections("Dummy Chat", custom),
    );
  });

  test("matching ignores case", () => {
    expect(
      buildSections("Dummy Chat", custom, "LO")[0]?.items.map((c) => c.name),
    ).toEqual(["login", "logout"]);
  });
});

describe("typingMenuAction", () => {
  const selected: CommandInfo = {
    name: "login",
    description: "Log in in a browser window",
  };
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

  test("arrows move and Escape closes", () => {
    expect(typingMenuAction(key("ArrowUp"), "/lo", 3, selected)).toBe("up");
    expect(typingMenuAction(key("ArrowDown"), "/lo", 3, selected)).toBe("down");
    expect(typingMenuAction(key("Escape"), "/lo", 3, selected)).toBe("close");
  });

  test("Tab accepts, and so does Enter while the word is still partial", () => {
    expect(typingMenuAction(key("Tab"), "/lo", 3, selected)).toBe("accept");
    expect(typingMenuAction(key("Enter"), "/lo", 3, selected)).toBe("accept");
  });

  test("Enter submits once the typed word is the selected command", () => {
    expect(typingMenuAction(key("Enter"), "/login", 6, selected)).toBe(
      "submit",
    );
    // Tab still completes it, which only adds the trailing space.
    expect(typingMenuAction(key("Tab"), "/login", 6, selected)).toBe("accept");
  });

  test("other keys are left to the textarea", () => {
    expect(typingMenuAction(key("a"), "/lo", 3, selected)).toBe("pass");
    expect(typingMenuAction(key("Enter"), "/lo", 3, undefined)).toBe("pass");
  });

  test("a cursor outside the command word leaves the key to the textarea", () => {
    // The caret listener closes the menu for this; taking the key here would
    // swallow the very character that moved the caret out of the word.
    expect(typingMenuAction(key("ArrowDown"), "/login x", 8, selected)).toBe(
      "pass",
    );
    expect(typingMenuAction(key("Enter"), "/login x", 8, selected)).toBe(
      "pass",
    );
    expect(typingMenuAction(key("Tab"), "/login x", 8, selected)).toBe("pass");
    // Escape closes wherever the caret is.
    expect(typingMenuAction(key("Escape"), "/login x", 8, selected)).toBe(
      "close",
    );
  });

  test("an IME composition keeps every key, the word's state notwithstanding", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]) {
      expect(
        typingMenuAction(key(k, { isComposing: true }), "/lo", 3, selected),
      ).toBe("pass");
      // WebKit reports a composing key as keyCode 229 and nothing else.
      expect(
        typingMenuAction(key(k, { keyCode: 229 }), "/lo", 3, selected),
      ).toBe("pass");
      // Even with the cursor outside the word: the composition owns the key,
      // and the caret events close the menu on their own.
      expect(
        typingMenuAction(
          key(k, { isComposing: true }),
          "/login x",
          8,
          selected,
        ),
      ).toBe("pass");
    }
  });

  test("Shift+Enter is a newline and Shift+Tab moves focus", () => {
    expect(
      typingMenuAction(key("Enter", { shiftKey: true }), "/lo", 3, selected),
    ).toBe("pass");
    expect(
      typingMenuAction(key("Tab", { shiftKey: true }), "/lo", 3, selected),
    ).toBe("pass");
  });

  test("a modified key belongs to the editor or the workbench", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      for (const k of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]) {
        expect(
          typingMenuAction(key(k, { [mod]: true }), "/lo", 3, selected),
        ).toBe("pass");
      }
    }
  });
});

describe("replaceCommandWord", () => {
  test("replaces the typed word and lands after the space", () => {
    expect(replaceCommandWord("/lo", 3, "login")).toEqual({
      text: "/login ",
      cursor: 7,
    });
  });

  test("keeps what follows the word, with one separating space", () => {
    expect(replaceCommandWord("/ti hello", 3, "title")).toEqual({
      text: "/title hello",
      cursor: 7,
    });
  });

  test("a newline after the word is kept as it is", () => {
    expect(replaceCommandWord("/ti\nmore", 3, "title")).toEqual({
      text: "/title \nmore",
      cursor: 7,
    });
  });

  test("with no command word it inserts the way the button does", () => {
    expect(replaceCommandWord("hello", 5, "login")).toEqual(
      insertCommand("hello", "login"),
    );
  });
});

describe("typingMenuPrefix", () => {
  test("the prefix under the cursor, as core sees it", () => {
    expect(typingMenuPrefix("/lo", 3, undefined)).toBe("lo");
    expect(typingMenuPrefix("/", 1, undefined)).toBe("");
    expect(typingMenuPrefix("hello", 5, undefined)).toBeUndefined();
    expect(typingMenuPrefix("/new x", 6, undefined)).toBeUndefined();
  });

  test("the text Escape dismissed stays dismissed", () => {
    expect(typingMenuPrefix("/lo", 3, "/lo")).toBeUndefined();
  });

  test("editing the text revives the menu", () => {
    expect(typingMenuPrefix("/log", 4, "/lo")).toBe("log");
    // Only the text matters, not the caret: moving it back into the same
    // text must not reopen what Escape closed.
    expect(typingMenuPrefix("/lo", 2, "/lo")).toBeUndefined();
  });
});
