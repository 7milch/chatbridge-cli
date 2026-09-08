import { type Provider, defineProvider } from "@chatbridge/provider";

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

    async waitForResponse(page) {
      const log = page.locator("#chat-log");
      await log
        .locator(".message.assistant")
        .last()
        .waitFor({ state: "visible" });
      // Wait for the busy → idle transition so partial replies are impossible.
      await page.waitForSelector('#chat-log[data-state="idle"]');
      const text = await log.locator(".message.assistant").last().textContent();
      return text ?? "";
    },

    async detectBlock(page) {
      // The challenge page has no chat controls, so isLoggedIn is false;
      // the title tells the two apart.
      return (await page.title()) === "Just a moment..."
        ? "challenge page"
        : undefined;
    },
  });
}

const baseUrl = process.env.DUMMY_CHAT_URL ?? "http://localhost:8735";
export default createDummyProvider(baseUrl);
