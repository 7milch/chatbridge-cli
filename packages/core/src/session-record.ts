/** The shape of a saved interactive session. UI-neutral: the TUI and the
 * VSCode host each convert between this and their own message type. */
export const SESSION_RECORD_VERSION = 1;
/** Longest picker title, in code points, the ellipsis included. */
export const TITLE_MAX = 60;
export const NO_PROMPT_TITLE = "(no prompt)";

export interface StoredShell {
  command: string;
  output: string;
  /** null when the command was killed or stopped. */
  exitCode: number | null;
  interrupted: boolean;
  droppedBytes: number;
  durationMs: number;
  signal?: string;
}

export type StoredRole = "user" | "assistant" | "error" | "separator" | "shell";

export interface StoredMessage {
  role: StoredRole;
  text: string;
  attachments?: { path: string; bytes: number }[];
  format?: "markdown";
  incomplete?: true;
  failed?: true;
  shell?: StoredShell;
}

export interface SessionRecord {
  version: typeof SESSION_RECORD_VERSION;
  id: string;
  provider: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** The provider's conversation handle as of the last successful turn.
   * Sensitive in the way a URL is: never log it. */
  conversation?: string;
  messages: StoredMessage[];
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  /** First line of the first user message, cleaned and truncated. */
  title: string;
  /** Number of user messages. */
  turns: number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An id becomes a file name, so nothing but a lowercase UUID is one. */
export function isSessionId(id: string): boolean {
  return ID.test(id);
}

const ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "error",
  "separator",
  "shell",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function parseShell(v: unknown): StoredShell | undefined {
  if (!isObject(v)) return undefined;
  const {
    command,
    output,
    exitCode,
    interrupted,
    droppedBytes,
    durationMs,
    signal,
  } = v;
  if (typeof command !== "string" || typeof output !== "string") {
    return undefined;
  }
  if (exitCode !== null && typeof exitCode !== "number") return undefined;
  if (typeof interrupted !== "boolean") return undefined;
  if (typeof droppedBytes !== "number" || typeof durationMs !== "number") {
    return undefined;
  }
  if (signal !== undefined && typeof signal !== "string") return undefined;
  return {
    command,
    output,
    exitCode,
    interrupted,
    droppedBytes,
    durationMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

function parseMessage(v: unknown): StoredMessage | undefined {
  if (!isObject(v)) return undefined;
  const { role, text, attachments, format, incomplete, failed, shell } = v;
  if (typeof role !== "string" || !ROLES.has(role)) return undefined;
  if (typeof text !== "string") return undefined;
  const out: StoredMessage = { role: role as StoredRole, text };
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return undefined;
    const list: { path: string; bytes: number }[] = [];
    for (const a of attachments) {
      if (
        !isObject(a) ||
        typeof a.path !== "string" ||
        typeof a.bytes !== "number"
      ) {
        return undefined;
      }
      list.push({ path: a.path, bytes: a.bytes });
    }
    out.attachments = list;
  }
  if (format !== undefined) {
    if (format !== "markdown") return undefined;
    out.format = "markdown";
  }
  if (incomplete !== undefined) {
    if (incomplete !== true) return undefined;
    out.incomplete = true;
  }
  if (failed !== undefined) {
    if (failed !== true) return undefined;
    out.failed = true;
  }
  if (shell !== undefined) {
    const parsed = parseShell(shell);
    if (parsed === undefined) return undefined;
    out.shell = parsed;
  }
  return out;
}

/** Validates what was read from disk, which is untrusted input. Returns a
 * copy holding only the known fields, or undefined for anything else: a
 * file this build cannot read is skipped, never repaired. */
export function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isObject(value)) return undefined;
  const {
    version,
    id,
    provider,
    createdAt,
    updatedAt,
    conversation,
    messages,
  } = value;
  if (version !== SESSION_RECORD_VERSION) return undefined;
  if (typeof id !== "string" || !isSessionId(id)) return undefined;
  if (typeof provider !== "string" || provider === "") return undefined;
  if (!isTime(createdAt) || !isTime(updatedAt)) return undefined;
  if (
    conversation !== undefined &&
    (typeof conversation !== "string" || conversation === "")
  ) {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const list: StoredMessage[] = [];
  for (const m of messages) {
    const parsed = parseMessage(m);
    if (parsed === undefined) return undefined;
    list.push(parsed);
  }
  return {
    version: SESSION_RECORD_VERSION,
    id,
    provider,
    createdAt,
    updatedAt,
    ...(conversation === undefined ? {} : { conversation }),
    messages: list,
  };
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** A title is drawn in a terminal and in a QuickPick: a control character
 * in it (an escape sequence in a prompt, a hand-edited file) becomes a
 * space. By code point, so a surrogate pair is never split. */
function clean(text: string): string[] {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : ch;
  });
}

function titleOf(text: string): string {
  // Trimmed after cleaning: a trailing control character became a space.
  const chars = Array.from(clean(text).join("").trim());
  if (chars.length <= TITLE_MAX) return chars.join("");
  return `${chars.slice(0, TITLE_MAX - 1).join("")}…`;
}

export function summarize(record: SessionRecord): SessionSummary {
  let prompt: string | undefined;
  let shell: string | undefined;
  let turns = 0;
  for (const m of record.messages) {
    if (m.role === "user") {
      turns++;
      if (prompt === undefined) {
        const line = firstLine(m.text);
        if (line !== "") prompt = line;
      }
    } else if (m.role === "shell" && shell === undefined) {
      const line = firstLine(m.text);
      if (line !== "") shell = `! ${line}`;
    }
  }
  return {
    id: record.id,
    updatedAt: record.updatedAt,
    title: titleOf(prompt ?? shell ?? NO_PROMPT_TITLE),
    turns,
  };
}

/** `MM-DD HH:mm` in local time, for the pickers. */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
