import { describe, expect, test } from "bun:test";
import type { UrlHook } from "@chatbridge/provider";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./attachment.js";
import {
  UrlHookError,
  expandUrlHooks,
  findUrls,
  resolveUrlHooks,
} from "./expand-url-hooks.js";

const wiki: UrlHook = {
  match: /^https:\/\/wiki\.test\//,
  async resolve(url) {
    return { label: `Wiki: ${url.slice(-3)}`, content: `body of ${url}` };
  },
};
const opts = { timeoutMs: 200 };

describe("findUrls", () => {
  test("finds http and https tokens, strips trailing punctuation, dedupes", () => {
    expect(
      findUrls(
        "see https://wiki.test/a, (http://x.test/b). <https://wiki.test/a> 'https://q.test/c'",
      ),
    ).toEqual(["https://wiki.test/a", "http://x.test/b", "https://q.test/c"]);
  });
  test("keeps inner punctuation and query strings", () => {
    expect(findUrls("https://wiki.test/p?id=1&x=(2).3")).toEqual([
      "https://wiki.test/p?id=1&x=(2).3",
    ]);
  });
  test("nothing without a scheme", () => {
    expect(findUrls("wiki.test/a and /usr/bin")).toEqual([]);
  });
});

describe("resolveUrlHooks", () => {
  test("no hooks or no matching URL: empty", async () => {
    expect(await resolveUrlHooks("https://wiki.test/a", [], opts)).toEqual([]);
    expect(await resolveUrlHooks("https://other.test/a", [wiki], opts)).toEqual(
      [],
    );
    expect(await resolveUrlHooks("no urls", [wiki], opts)).toEqual([]);
  });
  test("first matching hook wins; results in URL order; bytes are UTF-8", async () => {
    const first: UrlHook = {
      match: (u) => u.endsWith("/b"),
      async resolve() {
        return { label: "B", content: "é" };
      },
    };
    const r = await resolveUrlHooks(
      "https://wiki.test/b then https://wiki.test/a",
      [first, wiki],
      opts,
    );
    expect(r).toEqual([
      { label: "B", bytes: 2, content: "é" },
      { label: "Wiki: t/a", bytes: 27, content: "body of https://wiki.test/a" },
    ]);
  });
  test("resolves in parallel", async () => {
    let running = 0;
    let peak = 0;
    const slow: UrlHook = {
      match: () => true,
      async resolve(url) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { label: url, content: "x" };
      },
    };
    await resolveUrlHooks("https://a.test/ https://b.test/", [slow], opts);
    expect(peak).toBe(2);
  });
  test("a throw, a timeout and an oversized result are reported together", async () => {
    const hooks: UrlHook[] = [
      {
        match: (u) => u.includes("throw"),
        async resolve() {
          throw new Error("403 from wiki");
        },
      },
      {
        match: (u) => u.includes("hang"),
        resolve: () => new Promise(() => {}),
      },
      {
        match: (u) => u.includes("big"),
        async resolve() {
          return { label: "big", content: "x".repeat(MAX_FILE_BYTES + 1) };
        },
      },
    ];
    const p = resolveUrlHooks(
      "https://t/throw https://t/hang https://t/big",
      hooks,
      { timeoutMs: 30 },
    );
    await expect(p).rejects.toBeInstanceOf(UrlHookError);
    await expect(p).rejects.toMatchObject({
      problems: [
        "https://t/throw: 403 from wiki",
        "https://t/hang: timed out after 30 ms",
        "https://t/big: 201 KB exceeds 200 KB",
      ],
    });
  });
  test("total size counts alreadyBytes", async () => {
    const half: UrlHook = {
      match: () => true,
      async resolve(url) {
        return { label: url, content: "x".repeat(MAX_FILE_BYTES) };
      },
    };
    const text = "https://t/1";
    await expect(
      resolveUrlHooks(text, [half], {
        timeoutMs: 100,
        alreadyBytes: MAX_TOTAL_BYTES - MAX_FILE_BYTES + 1,
      }),
    ).rejects.toMatchObject({
      problems: ["attachments total 1.0 MB exceeds 1 MB"],
    });
    expect(
      await resolveUrlHooks(text, [half], {
        timeoutMs: 100,
        alreadyBytes: MAX_TOTAL_BYTES - MAX_FILE_BYTES,
      }),
    ).toHaveLength(1);
  });
});

describe("expandUrlHooks", () => {
  test("appends one fenced section per result and lists attachments", async () => {
    const r = await expandUrlHooks("read https://wiki.test/a", [wiki], opts);
    expect(r.prompt).toBe(
      "read https://wiki.test/a\n\n### Wiki: t/a\n```\nbody of https://wiki.test/a\n```",
    );
    expect(r.attachments).toEqual([{ path: "Wiki: t/a", bytes: 27 }]);
  });
  test("an unmatched URL stays in the prefix; only the matched one is attached", async () => {
    const r = await expandUrlHooks(
      "compare https://wiki.test/a with https://other.test/b",
      [wiki],
      opts,
    );
    expect(r.prompt).toBe(
      "compare https://wiki.test/a with https://other.test/b\n\n### Wiki: t/a\n```\nbody of https://wiki.test/a\n```",
    );
    expect(r.attachments).toEqual([{ path: "Wiki: t/a", bytes: 27 }]);
  });
  test("unchanged text when nothing matches", async () => {
    expect(await expandUrlHooks("plain", [wiki], opts)).toEqual({
      prompt: "plain",
      attachments: [],
    });
  });
});
