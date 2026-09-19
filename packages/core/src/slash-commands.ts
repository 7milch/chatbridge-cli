import type { BUILTIN_COMMAND_NAMES } from "@chatbridge/provider";

/** Commands typed as `/name` in either UI. The table is the single source
 * for the TUI, the webview and `/help`. No UI dependency. The names are
 * `BUILTIN_COMMAND_NAMES` from the provider package, so `defineProvider`'s
 * collision check and this table cannot drift apart. */
export const SLASH_COMMANDS = [
  { name: "login", description: "Log in in a browser window" },
  { name: "logout", description: "Delete the saved login and close the chat" },
  { name: "new", description: "Start a new chat" },
  { name: "reopen", description: "Reopen the browser (also Ctrl+R)" },
  { name: "help", description: "List these commands" },
] as const satisfies readonly {
  name: (typeof BUILTIN_COMMAND_NAMES)[number];
  description: string;
}[];

export type SlashCommand = (typeof SLASH_COMMANDS)[number]["name"];

/** Name and description of a command, for `/help` and the webview. */
export interface CommandInfo {
  name: string;
  description: string;
}

export type ParsedSlash =
  /** A built-in, which takes no arguments. */
  | { command: SlashCommand }
  /** A provider command; `args` is the rest of the line, trimmed. */
  | { custom: string; args: string }
  /** `/word` with a word nobody defines. */
  | { unknown: string }
  /** Recognised but unusable, e.g. a built-in given arguments. */
  | { error: string };

const NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));
const EMPTY: ReadonlySet<string> = new Set();
/** `/word` then optionally whitespace and the arguments; `word` is letters
 * only so paths like `/usr/bin` never match. */
const PATTERN = /^\/([a-z]+)(?:\s+([\s\S]*))?$/;

/** Parses one submitted text. `custom` is the provider's command names
 * (`commandNamesOf`). Returns undefined for anything that is not `/word`:
 * that is an ordinary message. */
export function parseSlashCommand(
  text: string,
  custom: ReadonlySet<string> = EMPTY,
): ParsedSlash | undefined {
  const m = PATTERN.exec(text.trim());
  if (m === null) return undefined;
  const word = m[1] as string;
  const args = (m[2] ?? "").trim();
  if (NAMES.has(word)) {
    return args === ""
      ? { command: word as SlashCommand }
      : { error: `/${word} takes no arguments.` };
  }
  if (custom.has(word)) return { custom: word, args };
  return { unknown: word };
}

export function unknownCommandMessage(word: string): string {
  return `Unknown command: /${word}. Type /help.`;
}

/** One line per command, aligned: the built-ins, then `custom` in the
 * provider's order. */
export function helpText(custom: readonly CommandInfo[] = []): string {
  const all: readonly CommandInfo[] = [...SLASH_COMMANDS, ...custom];
  const width = Math.max(...all.map((c) => c.name.length)) + 1;
  return all.map((c) => `/${c.name.padEnd(width)} ${c.description}`).join("\n");
}

/** The provider's command names, for `parseSlashCommand`. */
export function commandNamesOf(provider: {
  commands?: readonly CommandInfo[];
}): ReadonlySet<string> {
  return new Set((provider.commands ?? []).map((c) => c.name));
}

/** The provider's commands as plain name/description pairs, safe to post
 * to a webview (no functions). */
export function commandInfoOf(provider: {
  commands?: readonly CommandInfo[];
}): CommandInfo[] {
  return (provider.commands ?? []).map(({ name, description }) => ({
    name,
    description,
  }));
}
