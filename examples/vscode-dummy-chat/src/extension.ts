import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { createExtension } from "@chatbridge/vscode";

// DUMMY_CHAT_URL and CHATBRIDGE_DUMMY_BASE_DIR exist for the E2E runner; a
// real vendor extension hardcodes its service URL and has no baseDir.
export const { activate, deactivate } = createExtension({
  id: "chatbridge-dummy",
  displayName: "Dummy Chat",
  provider: createDummyProvider(
    process.env.DUMMY_CHAT_URL ?? "http://localhost:8735",
  ),
  configDir: "chatbridge",
  baseDir: process.env.CHATBRIDGE_DUMMY_BASE_DIR,
});
