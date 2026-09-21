import { createExtension } from "@chatbridge/vscode";
import provider from "../../src/provider.js";

export const { activate, deactivate } = createExtension({
  id: "<vendor>",
  displayName: "<Vendor>",
  provider,
  configDir: "<vendor>",
  ui: {
    welcome: "Ask <Vendor> anything.",
    banner: "media/banner.svg",
    footer: "Conversations are not stored by this extension.",
    sendButton: { background: "#2f6f4f", foreground: "#ffffff" },
    userMessage: { borderColor: "#2f6f4f" },
  },
});
