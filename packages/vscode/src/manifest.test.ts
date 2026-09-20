import { describe, expect, test } from "bun:test";
import {
  COMMAND_NAMES,
  OPTIONAL_COMMAND_NAMES,
  expectedContributions,
  missingContributions,
  recommendedContributions,
} from "./manifest.js";

const full = {
  contributes: {
    viewsContainers: { activitybar: [{ id: "acme" }] },
    views: { acme: [{ id: "acme.chat", type: "webview" }] },
    commands: expectedContributions("acme").commands.map((command) => ({
      command,
    })),
  },
};

describe("missingContributions", () => {
  test("a complete manifest has nothing missing", () => {
    expect(missingContributions(full, "acme")).toEqual([]);
  });

  test("lists every absent ID", () => {
    const partial = {
      contributes: {
        views: { acme: [{ id: "acme.chat" }] },
        commands: [{ command: "acme.login" }],
      },
    };
    expect(missingContributions(partial, "acme")).toEqual([
      "viewsContainers.activitybar: acme",
      "commands: acme.logout",
      "commands: acme.newChat",
      "commands: acme.reopen",
      "commands: acme.installBrowser",
      "commands: acme.sendSelection",
      "commands: acme.sendFile",
      "commands: acme.focus",
    ]);
  });

  test("a manifest without contributes lists everything", () => {
    expect(missingContributions({}, "x")).toHaveLength(10);
  });

  test("COMMAND_NAMES has eight entries", () => {
    expect(COMMAND_NAMES.length).toBe(8);
  });
});

/** `full` plus everything milestone 16 recommends. */
const upgraded = {
  contributes: {
    ...full.contributes,
    commands: [
      ...expectedContributions("acme").commands.map((command) => ({
        command,
        ...(command === "acme.newChat" || command === "acme.reopen"
          ? { icon: "$(add)" }
          : {}),
      })),
      { command: "acme.help", title: "Help" },
    ],
    menus: {
      "view/title": [
        "newChat",
        "reopen",
        "login",
        "logout",
        "installBrowser",
        "help",
      ].map((name) => ({
        command: `acme.${name}`,
        when: "view == acme.chat",
        group: "navigation",
      })),
    },
  },
};

describe("recommendedContributions", () => {
  test("a 0.9.0-style manifest has no fatal findings, only recommended ones", () => {
    expect(missingContributions(full, "acme")).toEqual([]);
    expect(recommendedContributions(full, "acme")).toEqual([
      "commands: acme.help",
      "commands.icon: acme.newChat",
      "commands.icon: acme.reopen",
      "menus.view/title: acme.newChat (navigation@1)",
      "menus.view/title: acme.reopen (navigation@2)",
      "menus.view/title: acme.login (1_auth@1)",
      "menus.view/title: acme.logout (1_auth@2)",
      "menus.view/title: acme.installBrowser (2_setup@1)",
      "menus.view/title: acme.help (3_help@1)",
    ]);
  });

  test("an upgraded manifest has nothing left to recommend", () => {
    expect(recommendedContributions(upgraded, "acme")).toEqual([]);
    expect(missingContributions(upgraded, "acme")).toEqual([]);
  });

  test("a view/title entry bound to another view does not count", () => {
    const wrongView = {
      contributes: {
        ...upgraded.contributes,
        menus: {
          "view/title": upgraded.contributes.menus["view/title"].map((e) => ({
            ...e,
            when: "view == other.chat",
          })),
        },
      },
    };
    expect(recommendedContributions(wrongView, "acme")).toEqual([
      "menus.view/title: acme.newChat (navigation@1)",
      "menus.view/title: acme.reopen (navigation@2)",
      "menus.view/title: acme.login (1_auth@1)",
      "menus.view/title: acme.logout (1_auth@2)",
      "menus.view/title: acme.installBrowser (2_setup@1)",
      "menus.view/title: acme.help (3_help@1)",
    ]);
  });

  test("a manifest without contributes recommends everything", () => {
    expect(recommendedContributions({}, "x")).toHaveLength(9);
  });

  test("OPTIONAL_COMMAND_NAMES is not part of COMMAND_NAMES", () => {
    for (const name of OPTIONAL_COMMAND_NAMES) {
      expect(COMMAND_NAMES).not.toContain(name as never);
    }
  });
});
