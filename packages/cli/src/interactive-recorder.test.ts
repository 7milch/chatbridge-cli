import { describe, expect, test } from "bun:test";
import { SAVE_FAILED_MESSAGE, type SessionStoreLike } from "@chatbridge/core";
import { interactiveRecorder } from "./interactive-recorder.js";

/** A store whose every save fails. */
function failingStore(): SessionStoreLike {
  return {
    save: () => Promise.reject(new Error("disk full")),
    load: async () => undefined,
    list: async () => [],
    prune: async () => {},
    clear: async () => {},
  };
}

const snapshot = {
  conversation: undefined,
  messages: [{ role: "user" as const, text: "hi" }],
};

describe("interactiveRecorder", () => {
  test("a failed save reaches the notifier with the save-failed notice", async () => {
    const { recorder, onNotifier } = interactiveRecorder({
      store: failingStore(),
      provider: "dummy-chat",
    });
    const notices: string[] = [];
    onNotifier((text) => notices.push(text));
    recorder.record(snapshot);
    await recorder.flush();
    expect(notices).toEqual([SAVE_FAILED_MESSAGE]);
  });

  test("a save that fails before the TUI is up is not an error", async () => {
    const { recorder } = interactiveRecorder({
      store: failingStore(),
      provider: "dummy-chat",
    });
    recorder.record(snapshot);
    await recorder.flush();
  });
});
