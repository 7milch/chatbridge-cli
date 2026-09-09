/** One `@path` occurrence. `start` is the index of `@`; `end` is the index
 * just after the last path character. */
export interface Mention {
  path: string;
  start: number;
  end: number;
}

/** `@` counts only at the start of the text or right after whitespace, so
 * `foo@example.com` is not a mention. The path runs to the next whitespace. */
const MENTION = /(?<=^|\s)@(\S*)/g;

/** Every non-empty mention, in order of appearance, duplicates kept. */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[1] ?? "";
    if (!path) continue;
    out.push({ path, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The mention the cursor is typing into, for the popup query. A bare `@`
 * counts here (empty path) so the popup opens as soon as `@` is typed. The
 * cursor must sit after the `@` and no further than the end of the path. */
export function mentionAtCursor(
  text: string,
  cursor: number,
): Mention | undefined {
  for (const m of text.matchAll(MENTION)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < cursor && cursor <= end) {
      return { path: m[1] ?? "", start, end };
    }
  }
  return undefined;
}
