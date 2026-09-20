import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type Attachment,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatAttachment,
  formatSize,
  totalSizeProblem,
} from "@chatbridge/core";
import { parseMentions } from "./parse-mentions.js";

export type { Attachment };
export { formatSize, MAX_FILE_BYTES, MAX_TOTAL_BYTES };

export interface Expansion {
  /** The text to send: body, then one fenced section per file. */
  prompt: string;
  attachments: Attachment[];
}

/** Every problem found in one send, thrown together so the user fixes all
 * of them at once. */
export class MentionError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "MentionError";
    this.problems = problems;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface Loaded {
  path: string;
  bytes: number;
  content: string;
}

type LoadResult = { problem: string } | { abs: string; ok: Loaded };

/** Resolves one mention to its content, or returns the problem line. */
async function load(mention: string, cwd: string): Promise<LoadResult> {
  const abs = resolve(cwd, mention);
  const rel = relative(cwd, abs);
  // `rel === ""` is cwd itself (`@.`), which falls through to stat and is
  // reported as a directory. Only a real `..` segment escapes cwd; a name
  // that merely starts with two dots (`..hidden`) stays inside.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { problem: `@${mention}: outside working directory` };
  }
  const path = rel.split(sep).join("/");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return { problem: `@${mention}: not found` };
  }
  if (info.isDirectory()) return { problem: `@${mention}: is a directory` };
  if (info.size > MAX_FILE_BYTES) {
    const kb = Math.ceil(info.size / 1024);
    const limit = MAX_FILE_BYTES / 1024;
    return { problem: `@${mention}: ${kb} KB exceeds ${limit} KB` };
  }
  const buf = await readFile(abs);
  if (buf.includes(0)) return { problem: `@${mention}: binary file` };
  let content: string;
  try {
    content = utf8.decode(buf);
  } catch {
    return { problem: `@${mention}: binary file` };
  }
  return { abs, ok: { path, bytes: buf.byteLength, content } };
}

/** Appends every mentioned file to `text` as a fenced section. Throws
 * `MentionError` with every problem when any mention cannot be attached. */
export async function expandMentions(
  text: string,
  cwd: string,
): Promise<Expansion> {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, attachments: [] };

  const problems: string[] = [];
  const loaded: Loaded[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const r = await load(m.path, cwd);
    if ("problem" in r) {
      problems.push(r.problem);
      continue;
    }
    if (seen.has(r.abs)) continue;
    seen.add(r.abs);
    loaded.push(r.ok);
  }
  const total = loaded.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_TOTAL_BYTES) problems.push(totalSizeProblem(total));
  if (problems.length > 0) throw new MentionError(problems);

  const sections = loaded.map((f) => formatAttachment(f.path, f.content));
  return {
    prompt: [text, ...sections].join("\n\n"),
    attachments: loaded.map((f) => ({ path: f.path, bytes: f.bytes })),
  };
}
