import {
  type UrlHook,
  formatAttachment,
  resolveUrlHooks,
} from "@chatbridge/core";
import { type Expansion, expandMentions } from "../mentions/expand-mentions.js";

export interface ExpandInputOptions {
  /** Working directory `@file` mentions resolve against. */
  cwd: string;
  /** The provider's URL hooks; none means mentions only. */
  hooks: readonly UrlHook[];
  /** Per-URL cap on `resolve`; the session timeout. */
  timeoutMs: number;
}

/** What the TUI sends for one typed line: the `@file` mentions, then the
 * provider's URL hooks, as one prompt. The sections are formatted here
 * rather than sliced out of `expandUrlHooks`'s prompt, so the two
 * expansions are composed rather than one being assumed to be a prefix of
 * the other. */
export async function expandInput(
  text: string,
  opts: ExpandInputOptions,
): Promise<Expansion> {
  const mentions = await expandMentions(text, opts.cwd);
  if (opts.hooks.length === 0) return mentions;
  const alreadyBytes = mentions.attachments.reduce((n, a) => n + a.bytes, 0);
  // Scanned against the typed text, not the expanded prompt: a URL inside
  // an attached file is the file's content, not a request.
  const resolved = await resolveUrlHooks(text, opts.hooks, {
    timeoutMs: opts.timeoutMs,
    alreadyBytes,
  });
  if (resolved.length === 0) return mentions;
  const sections = resolved.map((r) => formatAttachment(r.label, r.content));
  return {
    prompt: [mentions.prompt, ...sections].join("\n\n"),
    attachments: [
      ...mentions.attachments,
      ...resolved.map(({ label, bytes }) => ({ path: label, bytes })),
    ],
  };
}
