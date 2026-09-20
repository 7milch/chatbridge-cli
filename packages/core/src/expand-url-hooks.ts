import type { UrlHook } from "@chatbridge/provider";
import {
  type Attachment,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatAttachment,
  totalSizeProblem,
} from "./attachment.js";

/** Every problem found in one message, thrown together so the user fixes
 * all of them at once. Shaped like the CLI's MentionError; the UIs treat
 * both as "the user's to fix": nothing is sent, the input is refilled. */
export class UrlHookError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "UrlHookError";
    this.problems = problems;
  }
}

export interface ResolvedUrl {
  label: string;
  bytes: number;
  content: string;
}

export interface UrlExpansion {
  /** `text`, then one fenced section per resolved URL. */
  prompt: string;
  attachments: Attachment[];
}

export interface UrlHookOptions {
  /** Per-URL cap on `resolve`; the session timeout in both UIs. */
  timeoutMs: number;
  /** Bytes already attached by an earlier expansion (`@file` mentions), so
   * MAX_TOTAL_BYTES covers the whole message. */
  alreadyBytes?: number;
}

const URL_TOKEN = /https?:\/\/\S+/g;
/** Prose and Markdown put these right after a link. `)` is not here: it
 * needs the balance rule below. */
const TRAILING = new Set([">", ".", ",", ";", ":", "'", '"', "!", "?", "]"]);

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/** Drops the punctuation prose puts after a link. A `)` is kept when the
 * URL still has an unclosed `(` — `.../Foo_(bar)` is one URL, while the
 * `)` of `[foo](https://x/)` belongs to the Markdown around it. */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] as string;
    if (TRAILING.has(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const head = url.slice(0, end);
      if (count(head, ")") > count(head, "(")) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Every distinct URL in `text`, in first-occurrence order. */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_TOKEN)) {
    const url = trimTrailing(m[0]);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function matches(hook: UrlHook, url: string): boolean {
  return hook.match instanceof RegExp ? hook.match.test(url) : hook.match(url);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const utf8 = new TextEncoder();

type Outcome = { problem: string } | { ok: ResolvedUrl };

async function resolveOne(
  url: string,
  hook: UrlHook,
  timeoutMs: number,
): Promise<Outcome> {
  try {
    const { label, content } = await withTimeout(hook.resolve(url), timeoutMs);
    const bytes = utf8.encode(content).byteLength;
    if (bytes > MAX_FILE_BYTES) {
      return {
        problem: `${url}: ${Math.ceil(bytes / 1024)} KB exceeds ${MAX_FILE_BYTES / 1024} KB`,
      };
    }
    return { ok: { label, bytes, content } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { problem: `${url}: ${message}` };
  }
}

/** Resolves every URL in `text` that some hook accepts (first hook wins),
 * all in parallel. Throws UrlHookError when any of them fails, times out
 * or is too large, or when the total exceeds MAX_TOTAL_BYTES. */
export async function resolveUrlHooks(
  text: string,
  hooks: readonly UrlHook[],
  opts: UrlHookOptions,
): Promise<ResolvedUrl[]> {
  if (hooks.length === 0) return [];
  const jobs: Array<Promise<Outcome>> = [];
  for (const url of findUrls(text)) {
    const hook = hooks.find((h) => matches(h, url));
    if (hook) jobs.push(resolveOne(url, hook, opts.timeoutMs));
  }
  if (jobs.length === 0) return [];
  const outcomes = await Promise.all(jobs);
  const problems: string[] = [];
  const resolved: ResolvedUrl[] = [];
  for (const o of outcomes) {
    if ("problem" in o) problems.push(o.problem);
    else resolved.push(o.ok);
  }
  const total =
    (opts.alreadyBytes ?? 0) + resolved.reduce((n, r) => n + r.bytes, 0);
  if (total > MAX_TOTAL_BYTES) problems.push(totalSizeProblem(total));
  if (problems.length > 0) throw new UrlHookError(problems);
  return resolved;
}

/** `resolveUrlHooks`, then the prompt with one fenced section per result
 * appended to `text` (the same layout as `@file` mentions). */
export async function expandUrlHooks(
  text: string,
  hooks: readonly UrlHook[],
  opts: UrlHookOptions,
): Promise<UrlExpansion> {
  const resolved = await resolveUrlHooks(text, hooks, opts);
  if (resolved.length === 0) return { prompt: text, attachments: [] };
  const sections = resolved.map((r) => formatAttachment(r.label, r.content));
  return {
    prompt: [text, ...sections].join("\n\n"),
    attachments: resolved.map(({ label, bytes }) => ({ path: label, bytes })),
  };
}
