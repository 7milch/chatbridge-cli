import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMAND_NAMES,
  type Provider,
  type ProviderCommand,
  type UrlHook,
  defineProvider,
} from "./index.js";

describe("defineProvider", () => {
  test("returns the same provider object", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => true,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
    };
    expect(defineProvider(p)).toBe(p);
  });

  test("accepts the optional detectBlock method", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => false,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
      detectBlock: async () => "challenge page",
    };
    expect(defineProvider(p).detectBlock).toBe(p.detectBlock);
  });
});

test("defineProvider keeps the optional open defaults", () => {
  const p = defineProvider({
    name: "x",
    chatUrl: "http://127.0.0.1:1/",
    async navigateToLogin() {},
    async isLoggedIn() {
      return true;
    },
    async startNewChat() {},
    async sendMessage() {},
    async waitForResponse() {
      return "";
    },
    open: { timeoutMs: 5_000, retries: 2 },
  });
  expect(p.open).toEqual({ timeoutMs: 5_000, retries: 2 });
});

const base = {
  name: "x",
  chatUrl: "http://127.0.0.1:1/",
  async navigateToLogin() {},
  async isLoggedIn() {
    return true;
  },
  async startNewChat() {},
  async sendMessage() {},
  async waitForResponse() {
    return "";
  },
};

function cmd(name: string): ProviderCommand {
  return {
    name,
    description: `the ${name} command`,
    async run() {
      return { kind: "show", text: name };
    },
  };
}

describe("defineProvider: commands", () => {
  test("keeps a valid list", () => {
    const commands = [cmd("model"), cmd("summarize")];
    expect(defineProvider({ ...base, commands }).commands).toBe(commands);
  });
  test("rejects a name that is not lower-case letters", () => {
    for (const bad of ["Model", "my-cmd", "cmd2", "", "a b"]) {
      expect(() => defineProvider({ ...base, commands: [cmd(bad)] })).toThrow(
        `Provider command name "${bad}" must match /^[a-z]+$/.`,
      );
    }
  });
  test("rejects every built-in name", () => {
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(() => defineProvider({ ...base, commands: [cmd(name)] })).toThrow(
        `Provider command "/${name}" collides with a built-in command.`,
      );
    }
  });
  test("rejects a duplicate", () => {
    expect(() =>
      defineProvider({ ...base, commands: [cmd("a"), cmd("b"), cmd("a")] }),
    ).toThrow('Provider command "/a" is defined twice.');
  });
});

describe("defineProvider: urlHooks", () => {
  const ok: UrlHook = {
    match: /^https:\/\/wiki\.example\.test\//,
    async resolve(url) {
      return { label: `Wiki: ${url}`, content: "body" };
    },
  };
  test("keeps a valid list, RegExp or predicate", () => {
    const urlHooks = [ok, { ...ok, match: (u: string) => u.endsWith(".pdf") }];
    expect(defineProvider({ ...base, urlHooks }).urlHooks).toBe(urlHooks);
  });
  test("rejects a global or sticky RegExp", () => {
    for (const flags of ["g", "y", "gi"]) {
      expect(() =>
        defineProvider({
          ...base,
          urlHooks: [{ ...ok, match: new RegExp("x", flags) }],
        }),
      ).toThrow(
        `URL hook RegExp /x/${flags} must not use the g or y flag (it makes .test stateful).`,
      );
    }
  });
});
