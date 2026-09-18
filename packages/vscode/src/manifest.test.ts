import { describe, expect, test } from "bun:test";
import {
  COMMAND_NAMES,
  expectedContributions,
  missingContributions,
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
