import { describe, expect, test } from "bun:test";
import {
  type CommandInfo,
  SLASH_COMMANDS,
} from "@chatbridge/core/slash-commands";
import {
  CommandMenuModel,
  buildSections,
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
