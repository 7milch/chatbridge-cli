/** One file appended to a prompt; the history shows one line per entry. */
export interface Attachment {
  /** Display string: a relative `/`-separated path (may carry a `:L1-L2`
   * suffix), or a URL hook's label. */
  path: string;
  bytes: number;
}

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ts: "ts",
  js: "js",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  md: "md",
  py: "py",
  sh: "sh",
  yaml: "yaml",
  yml: "yml",
  toml: "toml",
  html: "html",
  css: "css",
  rs: "rs",
  go: "go",
};

/** Three backticks, or one more than the longest backtick run that starts
 * a line in the content, so the fence can never be closed early. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/^`+/gm)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** `N B` under 1 KiB, otherwise one decimal in KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The refusal line when a message carries too much. Shared: the TUI's
 * `@file` mentions, the URL hooks and the VSCode composer must refuse in
 * the same words, and one helper makes that a property of the code rather
 * than of three copies of the same template. */
export function totalSizeProblem(totalBytes: number): string {
  const limit = formatSize(MAX_TOTAL_BYTES).replace(".0", "");
  return `attachments total ${formatSize(totalBytes)} exceeds ${limit}`;
}

function languageOf(path: string): string {
  const file = path.replace(/:L\d+-L\d+$/, "");
  const dot = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  if (dot === -1 || dot <= slash) return "";
  return LANGUAGES[file.slice(dot + 1)] ?? "";
}

/** The attachment shape shared by the CLI's `@file` mentions and the
 * VSCode extension's send-selection / send-file:
 *
 *   ### <path>
 *   ```<lang>
 *   <content, newline-terminated>
 *   ```
 */
export function formatAttachment(path: string, content: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  const fence = fenceFor(body);
  return `### ${path}\n${fence}${languageOf(path)}\n${body}${fence}`;
}
