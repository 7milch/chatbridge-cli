import { defineProvider } from "@chatbridge/core";

const unreachable = () => {
  throw new Error("provider must not be used");
};

// Structurally valid, but the name cannot be a file name.
export default defineProvider({
  name: "../escape",
  chatUrl: "http://127.0.0.1:1/chat",
  navigateToLogin: unreachable,
  isLoggedIn: unreachable,
  startNewChat: unreachable,
  sendMessage: unreachable,
  waitForResponse: unreachable,
});
