import { describe, expect, test } from "bun:test";
import { ChatViewBridge, type WebviewLike } from "./chat-view-bridge.js";
import type { State, ToHost, ToWebview } from "./protocol.js";

function fakeWebview() {
  const posted: ToWebview[] = [];
  let listener: ((m: ToHost) => void) | undefined;
  const webview: WebviewLike = {
    postMessage: async (m) => {
      posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l) => {
      listener = l;
      return {
        dispose: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    webview,
    posted,
    receive: (m: ToHost) => listener?.(m),
    hasListener: () => listener !== undefined,
  };
}

const state: State = { status: "idle", messages: [], pendingAttachments: [] };

describe("ChatViewBridge", () => {
  test("ready → current state is posted", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send: (t) => calls.push(`send:${t}`),
      removeAttachment: (i) => calls.push(`remove:${i}`),
      command: (n) => calls.push(`cmd:${n}`),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "ready" });
    expect(w.posted).toEqual([{ type: "state", ...state }]);
    w.receive({ type: "send", text: "hi" });
    w.receive({ type: "removeAttachment", index: 2 });
    w.receive({ type: "command", name: "newChat" });
    expect(calls).toEqual(["send:hi", "remove:2", "cmd:newChat"]);
  });

  test("pushState and pushProgress reach the attached webview only", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      command() {},
    });
    bridge.pushState(state); // no webview yet: dropped, no throw
    const w = fakeWebview();
    const sub = bridge.attach(w.webview);
    bridge.pushProgress("Waiting...");
    bridge.pushState({ ...state, status: "busy" });
    expect(w.posted).toEqual([
      { type: "progress", text: "Waiting..." },
      { type: "state", ...state, status: "busy" },
    ]);
    sub.dispose();
    expect(w.hasListener()).toBe(false);
    bridge.pushProgress("dropped");
    expect(w.posted).toHaveLength(2);
  });

  test("attach with a UI config → config is posted before the state", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      command() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview, {
      welcome: "Hi",
      bannerUri: "vscode-resource:/b",
    });
    w.receive({ type: "ready" });
    expect(w.posted).toEqual([
      { type: "config", welcome: "Hi", bannerUri: "vscode-resource:/b" },
      { type: "state", ...state },
    ]);
  });

  test("malformed messages are ignored", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {
        throw new Error("must not run");
      },
      removeAttachment() {},
      command() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "send" } as unknown as ToHost);
    w.receive(null as unknown as ToHost);
    expect(w.posted).toEqual([]);
  });
});
