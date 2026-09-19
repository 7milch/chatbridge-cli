/** Commands typed as `/name` on their own in either UI. The table is the
 * single source for the TUI, the webview and `/help`. No UI dependency. */
export const SLASH_COMMANDS = [
  { name: "login", description: "Log in in a browser window" },
  { name: "logout", description: "Delete the saved login and close the chat" },
  { name: "new", description: "Start a new chat" },
  { name: "reopen", description: "Reopen the browser (also Ctrl+R)" },
  { name: "help", description: "List these commands" },
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number]["name"];

const NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));
/** `/word` alone on one line; `word` is letters only so paths like
 * `/usr/bin` never match. */
const PATTERN = /^\/([a-z]+)$/;

/** The bare form only: `/login` (surrounding whitespace allowed) is a
 * command; `/login now`, a second line, or a path is an ordinary message. */
export function parseSlashCommand(
  text: string,
): { command: SlashCommand } | { unknown: string } | undefined {
  const word = PATTERN.exec(text.trim())?.[1];
  if (word === undefined) return undefined;
  return NAMES.has(word)
    ? { command: word as SlashCommand }
    : { unknown: word };
}

export function unknownCommandMessage(word: string): string {
  return `Unknown command: /${word}. Type /help.`;
}

/** One line per command, aligned, for the history. */
export function helpText(): string {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 1;
  return SLASH_COMMANDS.map(
    (c) => `/${c.name.padEnd(width)} ${c.description}`,
  ).join("\n");
}
