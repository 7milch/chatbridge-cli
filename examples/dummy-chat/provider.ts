import {
  type Provider,
  defineProvider,
  elementToMarkdown,
  urlConversation,
} from "@chatbridge/provider";

/** Reference Provider implementation, targeting the bundled dummy chat.
 * Real providers follow the same shape against real services. */
export function createDummyProvider(baseUrl: string): Provider {
  return defineProvider({
    name: "dummy-chat",
    chatUrl: `${baseUrl}/chat`,

    async navigateToLogin(page) {
      await page.goto(`${baseUrl}/login`);
    },

    async isLoggedIn(page) {
      // On /chat with a valid session the input exists; when redirected
      // to /login it does not.
      return (await page.locator("#message-input").count()) > 0;
    },

    async startNewChat(page) {
      // The dummy chat has no history; being on the chat page is enough.
      await page.locator("#message-input").waitFor({ state: "visible" });
    },

    async sendMessage(page, prompt) {
      await page.locator("#message-input").fill(prompt);
      await page.locator("#send-button").click();
    },

    responseFormat: "markdown",

    async waitForResponse(page) {
      const log = page.locator("#chat-log");
      const last = log.locator(".message.assistant").last();
      await last.waitFor({ state: "attached" });
      // The busy → idle transition is the completion signal; partial text is
      // what `streaming.responseText` is for.
      await page.waitForSelector('#chat-log[data-state="idle"]');
      return elementToMarkdown(last);
    },

    streaming: {
      async responseText(page) {
        // Only while busy: once idle, the last assistant node may belong to
        // the previous turn until the next reply element is appended.
        const log = page.locator("#chat-log");
        if ((await log.getAttribute("data-state")) !== "busy") return undefined;
        const last = log.locator(".message.assistant").last();
        if ((await last.count()) === 0) return undefined;
        // Busy with no new element yet: the last node is the previous turn's.
        const users = await log.locator(".message.user").count();
        const assistants = await log.locator(".message.assistant").count();
        if (assistants < users) return undefined;
        const text = await elementToMarkdown(last);
        return text === "" ? undefined : text;
      },
      pollIntervalMs: 50,
    },

    // The conversation id is in the URL once the first reply exists.
    conversation: urlConversation({ match: /\/chat\/c\/[a-z0-9]{8}$/ }),

    async detectBlock(page) {
      // The challenge page has no chat controls, so isLoggedIn is false;
      // the title tells the two apart.
      return (await page.title()) === "Just a moment..."
        ? "challenge page"
        : undefined;
    },

    commands: [
      {
        name: "title",
        description: "Show the chat page title",
        async run(page) {
          return { kind: "show", text: await page.title() };
        },
      },
      {
        name: "shout",
        description: "Send the arguments in upper case",
        async run(_page, args) {
          return { kind: "send", prompt: args.toUpperCase() };
        },
      },
    ],

    urlHooks: [
      {
        // Pages of the dummy chat itself, e.g. `${baseUrl}/login`.
        match: (url) => url.startsWith(baseUrl),
        async resolve(url) {
          // A real provider would run a script or call an API here; the
          // framework never fetches anything itself.
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${res.status} from dummy chat`);
          return {
            label: `Dummy: ${new URL(url).pathname}`,
            content: await res.text(),
          };
        },
      },
    ],
  });
}

const baseUrl = process.env.DUMMY_CHAT_URL ?? "http://localhost:8735";
export default createDummyProvider(baseUrl);
