import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UrlHookError } from "@chatbridge/core";
import type { UrlHook } from "@chatbridge/core";
import { MentionError } from "../mentions/expand-mentions.js";
import { expandInput } from "./expand-input.js";

const wiki: UrlHook = {
  match: /^https:\/\/wiki\.test\//,
  async resolve(url) {
    return { label: `Wiki: ${url.slice(-1)}`, content: "body" };
  },
};

function dir(files: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), "chatbridge-expand-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(base, name), content);
  }
  return base;
}

describe("expandInput", () => {
  test("no hooks: the mention expansion is returned as it is", async () => {
    const cwd = dir({ "a.txt": "A\n" });
    try {
      expect(
        await expandInput("see @a.txt", { cwd, hooks: [], timeoutMs: 100 }),
      ).toEqual({
        prompt: "see @a.txt\n\n### a.txt\n```\nA\n```",
        attachments: [{ path: "a.txt", bytes: 2 }],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("hook sections follow the mention sections, in that order", async () => {
    const cwd = dir({ "a.txt": "A\n" });
    try {
      expect(
        await expandInput("see @a.txt and https://wiki.test/x", {
          cwd,
          hooks: [wiki],
          timeoutMs: 100,
        }),
      ).toEqual({
        prompt:
          "see @a.txt and https://wiki.test/x\n\n### a.txt\n```\nA\n```\n\n### Wiki: x\n```\nbody\n```",
        attachments: [
          { path: "a.txt", bytes: 2 },
          { path: "Wiki: x", bytes: 4 },
        ],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a URL only inside an attached file is not a request", async () => {
    const cwd = dir({ "a.txt": "https://wiki.test/x\n" });
    try {
      const r = await expandInput("see @a.txt", {
        cwd,
        hooks: [wiki],
        timeoutMs: 100,
      });
      expect(r.attachments).toEqual([{ path: "a.txt", bytes: 20 }]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("hook bytes count against the mention bytes", async () => {
    // Five files of exactly MAX_FILE_BYTES: 1_024_000 bytes, still under the
    // 1 MB total. The hook's 25 KB is what pushes the message over.
    const big = "x".repeat(200 * 1024);
    const cwd = dir({
      "a.txt": big,
      "b.txt": big,
      "c.txt": big,
      "d.txt": big,
      "e.txt": big,
    });
    const huge: UrlHook = {
      match: () => true,
      async resolve() {
        return { label: "Big", content: "y".repeat(25_000) };
      },
    };
    try {
      await expandInput(
        "@a.txt @b.txt @c.txt @d.txt @e.txt https://any.test/x",
        {
          cwd,
          hooks: [huge],
          timeoutMs: 100,
        },
      );
      throw new Error("expected a UrlHookError");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlHookError);
      expect((err as UrlHookError).problems).toEqual([
        "attachments total 1.0 MB exceeds 1 MB",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a mention problem is reported before any hook runs", async () => {
    const cwd = dir();
    let ran = false;
    const spy: UrlHook = {
      match: () => true,
      async resolve() {
        ran = true;
        return { label: "X", content: "x" };
      },
    };
    try {
      await expandInput("@missing.txt https://wiki.test/x", {
        cwd,
        hooks: [spy],
        timeoutMs: 100,
      });
      throw new Error("expected a MentionError");
    } catch (err) {
      expect(err).toBeInstanceOf(MentionError);
      expect(ran).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
