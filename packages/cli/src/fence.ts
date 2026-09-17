/** Three backticks, or one more than the longest backtick run that starts
 * a line in the content, so the fence can never be closed early. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/^`+/gm)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}
