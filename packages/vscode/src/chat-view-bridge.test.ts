import { describe, expect, test } from "bun:test";
import {
  COMMAND_LIST,
  ChatViewBridge,
  type ChatViewHandlers,
  type WebviewLike,
} from "./chat-view-bridge.js";
import type { State, ToHost, ToWebview, WebviewCommand } from "./protocol.js";

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

const state: State = {
  status: "idle",
  messages: [],
  pendingAttachments: [],
  queue: [],
};

const noopHandlers: ChatViewHandlers = {
  send() {},
  removeAttachment() {},
  takeBack() {},
  removeQueued() {},
  command() {},
  customCommand() {},
  attachUris() {},
  pasted() {},
  copyText() {},
};

describe("ChatViewBridge", () => {
  test("customCommand is validated and routed with name, args and text", () => {
    const calls: unknown[] = [];
    const bridge = new ChatViewBridge(() => state, {
      ...noopHandlers,
      customCommand: (name, args, text) => calls.push([name, args, text]),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({
      type: "customCommand",
      name: "model",
      args: "",
      text: "/model",
    });
    w.receive({
      type: "customCommand",
      name: 1,
      args: "",
    } as unknown as ToHost);
    w.receive({ type: "customCommand", name: "x" } as unknown as ToHost);
    expect(calls).toEqual([["model", "", "/model"]]);
  });

  test("ready posts the config with the provider commands", () => {
    const bridge = new ChatViewBridge(() => state, noopHandlers);
    const w = fakeWebview();
    bridge.attach(w.webview, { welcome: "hi" }, [
      { name: "model", description: "Show the model" },
    ]);
    w.receive({ type: "ready" });
    expect(w.posted[0]).toEqual({
      type: "config",
      welcome: "hi",
      commands: [{ name: "model", description: "Show the model" }],
    });
  });

  test("ready → current state is posted", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send: (t) => calls.push(`send:${t}`),
      removeAttachment: (i) => calls.push(`remove:${i}`),
      takeBack: () => calls.push("takeBack"),
      removeQueued: (i) => calls.push(`removeQueued:${i}`),
      command: (n) => calls.push(`cmd:${n}`),
      customCommand() {},
      attachUris: (u) => calls.push(`attachUris:${u.join("|")}`),
      pasted: (id, text) => calls.push(`pasted:${id}:${text}`),
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

  test("a /copy command is accepted and routed", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command: (n) => calls.push(`cmd:${n}`),
      attachUris() {},
      pasted() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "command", name: "copy" });
    expect(calls).toEqual(["cmd:copy"]);
  });

  test("pushState and pushProgress reach the attached webview only", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris() {},
      pasted() {},
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
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris() {},
      pasted() {},
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

  test("queue messages and every command name reach their handler", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send: (t) => calls.push(`send:${t}`),
      removeAttachment: (i) => calls.push(`remove:${i}`),
      takeBack: () => calls.push("takeBack"),
      removeQueued: (i) => calls.push(`removeQueued:${i}`),
      command: (n) => calls.push(`cmd:${n}`),
      customCommand() {},
      attachUris: (u) => calls.push(`attachUris:${u.join("|")}`),
      pasted: (id, text) => calls.push(`pasted:${id}:${text}`),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "takeBack" });
    w.receive({ type: "removeQueued", index: 1 });
    w.receive({ type: "command", name: "reopen" });
    w.receive({ type: "command", name: "logout" });
    w.receive({ type: "removeQueued" } as unknown as ToHost);
    w.receive({ type: "command", name: "nope" } as unknown as ToHost);
    expect(calls).toEqual([
      "takeBack",
      "removeQueued:1",
      "cmd:reopen",
      "cmd:logout",
    ]);
  });

  test("malformed messages are ignored", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {
        throw new Error("must not run");
      },
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris() {},
      pasted() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "send" } as unknown as ToHost);
    w.receive(null as unknown as ToHost);
    expect(w.posted).toEqual([]);
  });

  test("attachUris and pasted reach their handlers; bad shapes are dropped", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris: (u) => calls.push(`attachUris:${u.join("|")}`),
      pasted: (id, text) => calls.push(`pasted:${id}:${text}`),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "attachUris", uris: ["file:///a", "file:///b"] });
    w.receive({ type: "attachUris", uris: "file:///a" } as unknown as ToHost);
    w.receive({ type: "attachUris", uris: [1] } as unknown as ToHost);
    w.receive({ type: "pasted", id: 7, text: "hi" });
    w.receive({ type: "pasted", id: "7", text: "hi" } as unknown as ToHost);
    expect(calls).toEqual(["attachUris:file:///a|file:///b", "pasted:7:hi"]);
  });

  test("pushPasteResult posts the result for that paste", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris() {},
      pasted() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    bridge.pushPasteResult(3, true);
    expect(w.posted).toEqual([{ type: "pasteResult", id: 3, attached: true }]);
  });
  test("pushTookBack posts the entries", () => {
    const bridge = new ChatViewBridge(() => state, {
      send() {},
      removeAttachment() {},
      takeBack() {},
      removeQueued() {},
      command() {},
      customCommand() {},
      attachUris() {},
      pasted() {},
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    bridge.pushTookBack([{ text: "a", attachments: [] }]);
    expect(w.posted.at(-1)).toEqual({
      type: "tookBack",
      entries: [{ text: "a", attachments: [] }],
    });
  });

  test("every WebviewCommand name is accepted", () => {
    // Compile-time guard: a new WebviewCommand must be listed here, and
    // COMMAND_LIST is what the loop below exercises.
    const _all: Record<WebviewCommand, true> = {
      login: true,
      logout: true,
      newChat: true,
      installBrowser: true,
      reopen: true,
      copy: true,
      help: true,
      pickFiles: true,
    };
    expect(new Set(COMMAND_LIST)).toEqual(
      new Set(Object.keys(_all) as WebviewCommand[]),
    );
    for (const name of COMMAND_LIST) {
      const calls: string[] = [];
      const bridge = new ChatViewBridge(() => state, {
        send() {},
        removeAttachment() {},
        takeBack() {},
        removeQueued() {},
        command: (n) => calls.push(n),
        attachUris() {},
        pasted() {},
      });
      const w = fakeWebview();
      bridge.attach(w.webview);
      w.receive({ type: "command", name });
      expect(calls.at(-1)).toEqual(name);
    }
  });
});

describe("ChatViewBridge: streaming and copyText", () => {
  test("copyText is validated and routed", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      ...noopHandlers,
      copyText: (text) => calls.push(text),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "copyText", text: "a code block" });
    w.receive({ type: "copyText", text: 42 } as unknown as ToHost);
    w.receive({ type: "copyText" } as unknown as ToHost);
    expect(calls).toEqual(["a code block"]);
  });

  test("pushPartial posts the streamed text with its format", () => {
    const bridge = new ChatViewBridge(() => state, noopHandlers);
    const w = fakeWebview();
    bridge.attach(w.webview);
    bridge.pushPartial("half a re", "markdown");
    expect(w.posted).toEqual([
      { type: "partial", text: "half a re", format: "markdown" },
    ]);
  });
});
