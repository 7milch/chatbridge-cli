import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MentionError,
  expandMentions,
  formatSize,
} from "./expand-mentions.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mentions-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function file(rel: string, content: string | Uint8Array) {
  const abs = join(cwd, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function problemsOf(text: string): Promise<string[]> {
  try {
    await expandMentions(text, cwd);
  } catch (err) {
    if (err instanceof MentionError) return err.problems;
    throw err;
  }
  throw new Error("expected MentionError");
}

describe("expandMentions", () => {
  test("no mentions: prompt unchanged, no attachments", async () => {
    const r = await expandMentions("plain text", cwd);
    expect(r).toEqual({ prompt: "plain text", attachments: [] });
  });

  test("one file: body, blank line, heading, fenced content", async () => {
    await file("src/foo.ts", "const a = 1;\n");
    const r = await expandMentions("explain @src/foo.ts please", cwd);
    expect(r.prompt).toBe(
      "explain @src/foo.ts please\n\n### src/foo.ts\n```ts\nconst a = 1;\n```",
    );
    expect(r.attachments).toEqual([{ path: "src/foo.ts", bytes: 13 }]);
  });

  test("two files in order of first appearance; duplicates expand once", async () => {
    await file("a.md", "# A\n");
    await file("b.json", "{}\n");
    const r = await expandMentions("@b.json then @a.md then @b.json", cwd);
    expect(r.prompt).toBe(
      "@b.json then @a.md then @b.json\n\n### b.json\n```json\n{}\n```\n\n### a.md\n```md\n# A\n```",
    );
    expect(r.attachments.map((a) => a.path)).toEqual(["b.json", "a.md"]);
  });

  test("a missing trailing newline is added; content is not trimmed", async () => {
    await file("x.txt", "  two spaces");
    const r = await expandMentions("@x.txt", cwd);
    expect(r.prompt).toBe("@x.txt\n\n### x.txt\n```\n  two spaces\n```");
  });

  test("fence grows past the longest backtick run at a line start", async () => {
    await file("doc.md", "text\n````\ncode\n````\n");
    const r = await expandMentions("@doc.md", cwd);
    expect(r.prompt).toBe(
      "@doc.md\n\n### doc.md\n`````md\ntext\n````\ncode\n````\n`````",
    );
  });

  test("backticks not at a line start do not lengthen the fence", async () => {
    await file("n.md", "use ```js``` inline\n");
    const r = await expandMentions("@n.md", cwd);
    expect(r.prompt).toContain("\n```md\nuse ```js``` inline\n```");
  });

  test("language table", async () => {
    const cases: Array<[string, string]> = [
      ["a.ts", "ts"],
      ["a.js", "js"],
      ["a.tsx", "tsx"],
      ["a.jsx", "jsx"],
      ["a.json", "json"],
      ["a.md", "md"],
      ["a.py", "py"],
      ["a.sh", "sh"],
      ["a.yaml", "yaml"],
      ["a.yml", "yml"],
      ["a.toml", "toml"],
      ["a.html", "html"],
      ["a.css", "css"],
      ["a.rs", "rs"],
      ["a.go", "go"],
      ["Makefile", ""],
      ["a.unknownext", ""],
    ];
    for (const [name, lang] of cases) {
      await file(name, "x\n");
      const r = await expandMentions(`@${name}`, cwd);
      expect(r.prompt).toContain(`### ${name}\n\`\`\`${lang}\nx\n\`\`\``);
    }
  });

  test("dedupe is by resolved path", async () => {
    await file("a.ts", "x\n");
    const r = await expandMentions("@a.ts @./a.ts", cwd);
    expect(r.attachments).toEqual([{ path: "a.ts", bytes: 2 }]);
    expect(r.prompt.match(/### a\.ts/g)).toHaveLength(1);
  });

  test("not found", async () => {
    expect(await problemsOf("@no/such.ts")).toEqual(["@no/such.ts: not found"]);
  });

  test("directory", async () => {
    await mkdir(join(cwd, "src"));
    expect(await problemsOf("@src")).toEqual(["@src: is a directory"]);
  });

  test("binary: NUL byte", async () => {
    await file("a.png", new Uint8Array([0x89, 0x50, 0x00, 0x47]));
    expect(await problemsOf("@a.png")).toEqual(["@a.png: binary file"]);
  });

  test("binary: invalid UTF-8", async () => {
    await file("bad.txt", new Uint8Array([0xff, 0xfe, 0x41]));
    expect(await problemsOf("@bad.txt")).toEqual(["@bad.txt: binary file"]);
  });

  test("file over the per-file limit", async () => {
    await file("big.log", "x".repeat(312 * 1024));
    expect(await problemsOf("@big.log")).toEqual([
      "@big.log: 312 KB exceeds 200 KB",
    ]);
  });

  test("file exactly at the per-file limit is accepted", async () => {
    await file("edge.log", "x".repeat(MAX_FILE_BYTES));
    const r = await expandMentions("@edge.log", cwd);
    expect(r.attachments[0]?.bytes).toBe(MAX_FILE_BYTES);
  });

  test("total over the limit", async () => {
    for (let i = 0; i < 8; i++) {
      await file(`p${i}.log`, "x".repeat(180 * 1024));
    }
    const text = Array.from({ length: 8 }, (_, i) => `@p${i}.log`).join(" ");
    expect(await problemsOf(text)).toEqual([
      "attachments total 1.4 MB exceeds 1 MB",
    ]);
    expect(8 * 180 * 1024).toBeGreaterThan(MAX_TOTAL_BYTES);
  });

  test("outside the working directory", async () => {
    expect(await problemsOf("@../x")).toEqual([
      "@../x: outside working directory",
    ]);
  });

  test("all problems are collected in one error, in mention order", async () => {
    await mkdir(join(cwd, "dir"));
    const err = await expandMentions("@missing @dir @../out", cwd).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MentionError);
    expect((err as MentionError).problems).toEqual([
      "@missing: not found",
      "@dir: is a directory",
      "@../out: outside working directory",
    ]);
    expect((err as MentionError).message).toBe(
      "@missing: not found\n@dir: is a directory\n@../out: outside working directory",
    );
  });
});

describe("formatSize", () => {
  test("bytes, KB, MB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });
});

describe("expandMentions paths that look like traversal", () => {
  test("a file whose name starts with two dots is attached", async () => {
    await file("..hidden", "secret\n");
    const out = await expandMentions("look @..hidden", cwd);
    expect(out.attachments).toEqual([{ path: "..hidden", bytes: 7 }]);
    expect(out.prompt).toContain("### ..hidden");
  });

  test("@. reports the working directory as a directory", async () => {
    const err = await expandMentions("@.", cwd).catch((e) => e);
    expect((err as MentionError).problems).toEqual(["@.: is a directory"]);
  });

  test("@.. is still outside the working directory", async () => {
    const err = await expandMentions("@..", cwd).catch((e) => e);
    expect((err as MentionError).problems).toEqual([
      "@..: outside working directory",
    ]);
  });
});
