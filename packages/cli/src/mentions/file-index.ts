import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface FileIndexOptions {
  cwd: string;
  /** Stop listing after this many files. Default 20_000. */
  limit?: number;
}

const DEFAULT_LIMIT = 20_000;
/** Skipped everywhere, so the walk stays cheap outside a git repository. */
const ALWAYS_SKIP = new Set([".git", "node_modules"]);

interface Scope {
  /** Absolute directory the .gitignore lives in. */
  dir: string;
  ig: Ignore;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Snapshot of the files under a directory plus a fuzzy search over them. */
export class FileIndex {
  private constructor(private readonly paths: string[]) {}

  get size(): number {
    return this.paths.length;
  }

  /** Walks cwd once, depth-first, honouring every .gitignore on the path
   * from cwd down. Always skips `.git` and `node_modules`; never follows
   * symlinks. Returns relative POSIX paths, sorted. */
  static async build(opts: FileIndexOptions): Promise<FileIndex> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const paths: string[] = [];
    await walk(opts.cwd, opts.cwd, [], paths, limit);
    paths.sort();
    return new FileIndex(paths);
  }

  /** Test-only: an index over a fixed list (kept in the given order after
   * sorting, like `build`). */
  static fromPaths(paths: string[]): FileIndex {
    return new FileIndex([...paths].sort());
  }

  /** Every query character must appear in order (case-insensitive). Score
   * favours matches at path-segment starts, then shorter paths, then
   * alphabetical order. Empty query returns the first `limit` paths. */
  search(query: string, limit: number): string[] {
    if (query === "") return this.paths.slice(0, limit);
    const q = query.toLowerCase();
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of this.paths) {
      const score = scoreMatch(q, path.toLowerCase());
      if (score !== undefined) scored.push({ path, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return scored.slice(0, limit).map((s) => s.path);
  }
}

/** Greedy left-to-right subsequence match. Returns undefined when some
 * query character is missing. A character matched at a segment start
 * (index 0 or right after `/`) scores 3, after `.`, `-`, `_` scores 2,
 * elsewhere 1. */
function scoreMatch(query: string, path: string): number | undefined {
  let score = 0;
  let from = 0;
  for (const ch of query) {
    const at = path.indexOf(ch, from);
    if (at === -1) return undefined;
    const prev = at === 0 ? "/" : path[at - 1];
    score +=
      prev === "/" ? 3 : prev === "." || prev === "-" || prev === "_" ? 2 : 1;
    from = at + 1;
  }
  return score;
}

async function walk(
  cwd: string,
  dir: string,
  scopes: Scope[],
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently, the index is best effort
  }
  let here = scopes;
  const gitignore = entries.find((e) => e.isFile() && e.name === ".gitignore");
  if (gitignore) {
    try {
      const content = await readFile(join(dir, ".gitignore"), "utf8");
      here = [...scopes, { dir, ig: ignore().add(content) }];
    } catch {
      // Unreadable or vanished: treat this directory as having no
      // .gitignore. The parent scopes still apply; the index is best
      // effort and must never fail the whole walk.
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.isSymbolicLink()) continue;
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;
    if (isDir && ALWAYS_SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (isIgnored(abs, isDir, here)) continue;
    if (isDir) {
      await walk(cwd, abs, here, out, limit);
    } else {
      out.push(toPosix(relative(cwd, abs)));
    }
  }
}

/** A path is ignored when any enclosing .gitignore matches it, tested
 * relative to that .gitignore's directory (trailing `/` for directories,
 * which is how `ignore` distinguishes `dist/` from `dist`). */
function isIgnored(abs: string, isDir: boolean, scopes: Scope[]): boolean {
  for (const { dir, ig } of scopes) {
    const rel = toPosix(relative(dir, abs)) + (isDir ? "/" : "");
    if (ig.ignores(rel)) return true;
  }
  return false;
}
