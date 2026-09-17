import { describe, expect, test } from "bun:test";
import { DEFAULT_SPINNER, resolveSpinner } from "./spinner.js";

describe("resolveSpinner", () => {
  test("no input yields the built-in default", () => {
    expect(resolveSpinner()).toEqual({
      frames: ["●○○", "○●○", "○○●", "○●○"],
      intervalMs: 120,
      labels: ["Thinking…"],
    });
    expect(resolveSpinner(undefined)).toEqual(DEFAULT_SPINNER);
  });

  test("each field overrides independently", () => {
    expect(resolveSpinner({ intervalMs: 80 })).toEqual({
      ...DEFAULT_SPINNER,
      intervalMs: 80,
    });
    expect(resolveSpinner({ frames: ["-", "\\", "|", "/"] })).toEqual({
      ...DEFAULT_SPINNER,
      frames: ["-", "\\", "|", "/"],
    });
  });

  test("a string label becomes a one-element list", () => {
    expect(resolveSpinner({ label: "Working…" }).labels).toEqual(["Working…"]);
  });

  test("an array label is kept as given, including an empty one", () => {
    expect(resolveSpinner({ label: ["A", "B"] }).labels).toEqual(["A", "B"]);
    expect(resolveSpinner({ label: [] }).labels).toEqual([]);
  });

  test("colours pass through and are absent by default", () => {
    expect(resolveSpinner().frameColor).toBeUndefined();
    expect(resolveSpinner().labelColor).toBeUndefined();
    const r = resolveSpinner({ frameColor: 4, labelColor: "#8a8a8a" });
    expect(r.frameColor).toBe(4);
    expect(r.labelColor).toBe("#8a8a8a");
  });

  test("the result does not alias the caller's arrays", () => {
    const frames = ["x", "y"];
    const resolved = resolveSpinner({ frames });
    frames.push("z");
    expect(resolved.frames).toEqual(["x", "y"]);
  });
});
