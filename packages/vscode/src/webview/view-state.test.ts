import { describe, expect, test } from "bun:test";
import type { ActiveFile, State, Status } from "../protocol.js";
import {
  attachTipState,
  hintText,
  isActive,
  noticeFor,
  sendButtonState,
} from "./view-state.js";

function state(over: Partial<State> = {}): State {
  return {
    status: "idle",
    messages: [],
    pendingAttachments: [],
    queue: [],
    ...over,
  };
}

const file = { path: "a.ts", bytes: 3, content: "abc" };

describe("isActive", () => {
  test("only the three in-flight statuses count", () => {
    const active: Status[] = ["busy", "opening", "reopening"];
    const quiet: Status[] = ["closed", "idle", "dead"];
    for (const s of active) expect(isActive(s)).toBe(true);
    for (const s of quiet) expect(isActive(s)).toBe(false);
  });

  test("a quiet status keeps no progress line for the next phase", () => {
    // The idle close emits its "Closing the browser after ... idle..." line
    // after the `closed` frame, so a cached line must not survive into the
    // next `opening`.
    expect(isActive("closed")).toBe(false);
    expect(isActive("idle")).toBe(false);
  });
});

describe("sendButtonState", () => {
  test("idle with text: the primary send arrow", () => {
    expect(sendButtonState(state(), false)).toEqual({
      icon: "send",
      label: "Send",
      title: "Send (Enter)",
      disabled: false,
      secondary: false,
    });
  });

  test("in flight: the queue icon in the secondary colours", () => {
    expect(sendButtonState(state({ status: "busy" }), false)).toEqual({
      icon: "queue",
      label: "Queue",
      title: "Queue (Enter)",
      disabled: false,
      secondary: true,
    });
  });

  test("an empty input with no attachment disables it", () => {
    expect(sendButtonState(state(), true).disabled).toBe(true);
    expect(sendButtonState(state({ status: "busy" }), true).disabled).toBe(
      true,
    );
  });

  test("a pending attachment is enough to send", () => {
    expect(
      sendButtonState(state({ pendingAttachments: [file] }), true).disabled,
    ).toBe(false);
  });
});

describe("hintText", () => {
  test("names what Enter does now", () => {
    expect(hintText("idle")).toBe("Enter to send · Shift+Enter newline");
    expect(hintText("busy")).toBe("Enter to queue");
    expect(hintText("opening")).toBe("Enter to queue");
  });
});

describe("noticeFor", () => {
  test("nothing while the session is alive", () => {
    for (const status of ["idle", "busy", "opening", "closed"] as Status[]) {
      expect(noticeFor(state({ status }))).toBeUndefined();
    }
  });

  test("an auth failure makes Log in the primary recovery", () => {
    expect(
      noticeFor(state({ status: "dead", lastError: "AUTH_EXPIRED" })),
    ).toEqual({
      text: "Not logged in.",
      buttons: [
        { label: "Log in", command: "login", primary: true },
        { label: "Reopen", command: "reopen", primary: false },
        { label: "New chat", command: "newChat", primary: false },
      ],
    });
    expect(
      noticeFor(state({ status: "dead", lastError: "AUTH_REQUIRED" }))?.text,
    ).toBe("Not logged in.");
  });

  test("any other cause makes Reopen the primary recovery", () => {
    expect(noticeFor(state({ status: "dead", lastError: "TIMEOUT" }))).toEqual({
      text: "The chat stopped.",
      buttons: [
        { label: "Log in", command: "login", primary: false },
        { label: "Reopen", command: "reopen", primary: true },
        { label: "New chat", command: "newChat", primary: false },
      ],
    });
    expect(noticeFor(state({ status: "dead" }))?.text).toBe(
      "The chat stopped.",
    );
  });
});

describe("attachTipState", () => {
  const active: ActiveFile = {
    uri: "file:///ws/src/config/hogehoge.json",
    path: "src/config/hogehoge.json",
    name: "hogehoge.json",
  };

  test("no active file means no tip", () => {
    expect(attachTipState(undefined, [])).toBeUndefined();
  });

  test("an active file not yet pending is the tip", () => {
    expect(attachTipState(active, [file])).toEqual(active);
  });

  test("a file that is already a pending attachment hides the tip", () => {
    const pending = { path: active.path, bytes: 3, content: "{}\n" };
    expect(attachTipState(active, [file, pending])).toBeUndefined();
  });
});
