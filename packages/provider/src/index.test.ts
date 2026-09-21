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

const baseProvider = {
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
    expect(defineProvider({ ...baseProvider, commands }).commands).toBe(
      commands,
    );
  });
  test("rejects a name that is not lower-case letters", () => {
    for (const bad of ["Model", "my-cmd", "cmd2", "", "a b"]) {
      expect(() =>
        defineProvider({ ...baseProvider, commands: [cmd(bad)] }),
      ).toThrow(`Provider command name "${bad}" must match /^[a-z]+$/.`);
    }
  });
  test("rejects every built-in name", () => {
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(() =>
        defineProvider({ ...baseProvider, commands: [cmd(name)] }),
      ).toThrow(
        `Provider command "/${name}" collides with a built-in command.`,
      );
    }
  });
  test("rejects /copy, a built-in since the clipboard milestone", () => {
    expect(() =>
      defineProvider({ ...baseProvider, commands: [cmd("copy")] }),
    ).toThrow('Provider command "/copy" collides with a built-in command.');
  });
  test("rejects a duplicate", () => {
    expect(() =>
      defineProvider({
        ...baseProvider,
        commands: [cmd("a"), cmd("b"), cmd("a")],
      }),
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
    expect(defineProvider({ ...baseProvider, urlHooks }).urlHooks).toBe(
      urlHooks,
    );
  });
  test("rejects a global or sticky RegExp", () => {
    for (const flags of ["g", "y", "gi"]) {
      expect(() =>
        defineProvider({
          ...baseProvider,
          urlHooks: [{ ...ok, match: new RegExp("x", flags) }],
        }),
      ).toThrow(
        `URL hook RegExp /x/${flags} must not use the g or y flag (it makes .test stateful).`,
      );
    }
  });
});

describe("defineProvider: browser", () => {
  test("keeps a valid reducedMotion value", () => {
    for (const reducedMotion of ["reduce", "no-preference"] as const) {
      expect(
        defineProvider({ ...baseProvider, browser: { reducedMotion } }).browser,
      ).toEqual({ reducedMotion });
    }
  });
  test("rejects any other value", () => {
    expect(() =>
      defineProvider({
        ...baseProvider,
        browser: { reducedMotion: "off" as unknown as "reduce" },
      }),
    ).toThrow(
      'Provider browser.reducedMotion must be "reduce" or "no-preference", got "off".',
    );
  });
});

/** Minimal valid Provider, for tests that only care about one extra field. */
function base(): Provider {
  return {
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
}

describe("defineProvider: idle", () => {
  test("keeps a non-negative timeout, 0 included", () => {
    for (const timeoutMs of [0, 60_000]) {
      expect(
        defineProvider({ ...baseProvider, idle: { timeoutMs } }).idle,
      ).toEqual({
        timeoutMs,
      });
    }
  });
  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %p",
    (timeoutMs) => {
      expect(() =>
        defineProvider({ ...baseProvider, idle: { timeoutMs } }),
      ).toThrow("Provider idle.timeoutMs must be a non-negative finite number");
    },
  );
});

describe("defineProvider: responseFormat and streaming", () => {
  test("accepts markdown, text and a streaming block", () => {
    expect(() =>
      defineProvider({
        ...base(),
        responseFormat: "markdown",
        streaming: { responseText: async () => undefined, pollIntervalMs: 100 },
      }),
    ).not.toThrow();
    expect(() =>
      defineProvider({ ...base(), responseFormat: "text" }),
    ).not.toThrow();
  });

  test("rejects an unknown responseFormat", () => {
    expect(() =>
      defineProvider({ ...base(), responseFormat: "html" as never }),
    ).toThrow(
      'Provider responseFormat must be "markdown" or "text", got "html".',
    );
  });

  test("rejects streaming without a responseText function", () => {
    expect(() => defineProvider({ ...base(), streaming: {} as never })).toThrow(
      "Provider streaming.responseText must be a function.",
    );
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects pollIntervalMs %p",
    (ms) => {
      expect(() =>
        defineProvider({
          ...base(),
          streaming: { responseText: async () => "", pollIntervalMs: ms },
        }),
      ).toThrow(
        `Provider streaming.pollIntervalMs must be a finite number greater than 0, got ${ms}.`,
      );
    },
  );
});

describe("defineProvider conversation", () => {
  test("accepts a handle/open pair", () => {
    const conversation = {
      handle: async () => undefined,
      open: async () => {},
    };
    expect(defineProvider({ ...base(), conversation }).conversation).toBe(
      conversation,
    );
  });

  test.each(["handle", "open"])("rejects a missing %s", (key) => {
    const conversation = {
      handle: async () => undefined,
      open: async () => {},
      [key]: undefined,
    };
    expect(() =>
      defineProvider({ ...base(), conversation: conversation as never }),
    ).toThrow(`Provider conversation.${key} must be a function.`);
  });
});
