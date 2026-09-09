import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex } from "./file-index.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "file-index-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function file(rel: string, content = "") {
  const abs = join(cwd, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

describe("FileIndex.build", () => {
  test("lists files recursively as sorted POSIX paths", async () => {
    await file("b.ts");
    await file("src/a.ts");
    await file("src/deep/c.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["b.ts", "src/a.ts", "src/deep/c.ts"]);
  });

  test("an unreadable .gitignore is treated as absent", async () => {
    await file("sub/.gitignore", "keep.ts\n");
    await file("sub/keep.ts");
    await chmod(join(cwd, "sub/.gitignore"), 0o000);
    const index = await FileIndex.build({ cwd });
    const paths = index.search("", 10);
    expect(paths).toContain("sub/keep.ts");
    if (process.getuid?.() === 0) return; // root reads it anyway; skip
    expect(paths).toContain("sub/.gitignore");
  });

  test("always skips .git and node_modules", async () => {
    await file(".git/HEAD");
    await file("node_modules/pkg/index.js");
    await file("src/node_modules/x.js");
    await file("keep.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["keep.ts"]);
  });

  test("honours the root .gitignore for files and directories", async () => {
    await file(".gitignore", "dist/\n*.log\n");
    await file("dist/out.js");
    await file("app.log");
    await file("src/app.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual([".gitignore", "src/app.ts"]);
  });

  test("a nested .gitignore applies to its own subtree only", async () => {
    await file("sub/.gitignore", "*.tmp\n");
    await file("sub/a.tmp");
    await file("sub/a.ts");
    await file("root.tmp");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual([
      "root.tmp",
      "sub/.gitignore",
      "sub/a.ts",
    ]);
  });

  test("does not follow symlinks", async () => {
    await file("real/a.ts");
    await symlink(join(cwd, "real"), join(cwd, "link"));
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["real/a.ts"]);
  });

  test("stops at the limit", async () => {
    for (let i = 0; i < 5; i++) await file(`f${i}.ts`);
    const index = await FileIndex.build({ cwd, limit: 3 });
    expect(index.size).toBe(3);
  });
});

describe("FileIndex.search", () => {
  const index = FileIndex.fromPaths([
    "src/chat-view.ts",
    "src/xab.ts",
    "src/ab.ts",
    "ab.ts",
    "docs/README.md",
    "packages/cli/src/tui/chat-view.test.ts",
  ]);

  test("empty query returns the first `limit` paths in index order", () => {
    expect(index.search("", 2)).toEqual(["ab.ts", "docs/README.md"]);
  });

  test("every query character must appear in order", () => {
    expect(index.search("zzz", 10)).toEqual([]);
    expect(index.search("readme", 10)).toEqual(["docs/README.md"]);
  });

  test("a match at a path-segment start beats a mid-word match", () => {
    const r = index.search("ab", 10);
    expect(r.indexOf("src/ab.ts")).toBeLessThan(r.indexOf("src/xab.ts"));
  });

  test("shorter path wins ties", () => {
    const r = index.search("ab", 10);
    expect(r.indexOf("ab.ts")).toBeLessThan(r.indexOf("src/ab.ts"));
  });

  test("matching is case-insensitive", () => {
    expect(index.search("ReAdMe", 10)).toEqual(["docs/README.md"]);
  });

  test("respects the limit", () => {
    expect(index.search("ts", 2)).toHaveLength(2);
  });

  test("segment-start bonus ranks the short view file first", () => {
    expect(index.search("chatview", 10)[0]).toBe("src/chat-view.ts");
  });
});
