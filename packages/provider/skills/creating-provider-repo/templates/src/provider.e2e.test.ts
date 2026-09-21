import { describe, expect, test } from "bun:test";
import { ChatSession, createAuthStore } from "@chatbridge/core";
import provider from "./provider.js";

// Real-service E2E. Runs only when explicitly enabled and a saved auth state
// exists (`<vendor> auth login` first). Never runs in `bun run check` by
// accident: without the env var the whole describe is skipped.
const authStore = createAuthStore({
  configDir: "<vendor>",
  providerName: provider.name,
});
const GATE = "<VENDOR>_E2E";
const enabled = process.env[GATE] === "1" && authStore.has();

// A structural sample: the assertions check Markdown structure, never the
// service's wording, so a chatty model still passes.
const MARKDOWN_SAMPLE =
  "Repeat the following Markdown exactly, with no commentary:\n\n# Title\n\n- one\n  - nested\n- two\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold** and [a link](https://example.com)";

describe.skipIf(!enabled)("<vendor> real service", () => {
  test("two turns, second answer differs", async () => {
    const session = await ChatSession.open({
      provider,
      authStore,
      headless: true,
      timeoutMs: 120_000,
    });
    try {
      const first = await session.send("Reply with the single word: ping");
      expect(first.length).toBeGreaterThan(0);
      const second = await session.send("Reply with the single word: pong");
      expect(second.length).toBeGreaterThan(0);
      expect(second).not.toBe(first);
    } finally {
      await session.close();
    }
  }, 300_000);

  test("Markdown fidelity", async () => {
    const session = await ChatSession.open({
      provider,
      authStore,
      headless: true,
      timeoutMs: 120_000,
    });
    try {
      const reply = await session.send(MARKDOWN_SAMPLE);
      expect(reply).toMatch(/^# /m);
      expect(reply).toMatch(/^\s+- nested/m);
      expect(reply).toMatch(/^```ts$/m);
      expect(reply).toMatch(/^\|\s*-+/m);
      expect(reply).toMatch(/\*\*bold\*\*/);
      expect(reply).toMatch(/\[a link\]\(https:\/\/example\.com\/?\)/);
    } finally {
      await session.close();
    }
  }, 300_000);

  test("streaming never shows the previous turn", async () => {
    const session = await ChatSession.open({
      provider,
      authStore,
      headless: true,
      timeoutMs: 120_000,
    });
    try {
      // A first turn, so the second one proves no earlier text leaks through
      // streaming.responseText.
      const first = await session.send("Reply with the single word: ping");
      const partials: string[] = [];
      const second = await session.send(
        "Show a bulleted list of three fruits, then a short TypeScript code block that prints hello.",
        { onPartial: (text) => partials.push(text) },
      );
      expect(second).not.toBe(first);
      expect(partials.length).toBeGreaterThan(0);
      for (const partial of partials) expect(partial).not.toBe(first);
    } finally {
      await session.close();
    }
  }, 300_000);
});
