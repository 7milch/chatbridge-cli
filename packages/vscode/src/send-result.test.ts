import { describe, expect, test } from "bun:test";
import type { QueueEntry } from "./protocol.js";
import { REFUSED_CODES, onSendResult } from "./send-result.js";

function spy() {
  const calls: QueueEntry[][] = [];
  return { calls, push: (entries: QueueEntry[]) => calls.push(entries) };
}

describe("onSendResult", () => {
  test("a URL hook refusal hands the text back to the composer", () => {
    const s = spy();
    onSendResult({ ok: false, code: "URL_HOOK", message: "boom" }, "a", s.push);
    expect(s.calls).toEqual([[{ text: "a", attachments: [] }]]);
  });

  test("a successful send refills nothing", () => {
    const s = spy();
    onSendResult({ ok: true }, "a", s.push);
    onSendResult({ ok: true, queued: true }, "a", s.push);
    expect(s.calls).toEqual([]);
  });

  test("a failure that already reached the browser refills nothing", () => {
    const s = spy();
    for (const code of ["BROWSER_UNAVAILABLE", "AUTH_REQUIRED", "UNKNOWN"]) {
      onSendResult({ ok: false, code, message: "x" }, "a", s.push);
    }
    expect(s.calls).toEqual([]);
  });

  test("REFUSED_CODES is what decides", () => {
    expect(REFUSED_CODES.size).toBeGreaterThan(0);
    for (const code of REFUSED_CODES) {
      const s = spy();
      onSendResult({ ok: false, code, message: "x" }, "a", s.push);
      expect(s.calls).toEqual([[{ text: "a", attachments: [] }]]);
    }
    const other = spy();
    expect(REFUSED_CODES.has("NOT_A_REFUSAL")).toBe(false);
    onSendResult(
      { ok: false, code: "NOT_A_REFUSAL", message: "x" },
      "a",
      other.push,
    );
    expect(other.calls).toEqual([]);
  });
});
