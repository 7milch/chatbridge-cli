import { parseArgs } from "node:util";
import {
  ChatBridgeError,
  type Provider,
  ProviderLoadError,
  createAuthStore,
  runLogin,
  runOneShot,
} from "@chatbridge/core";
import { configPath, loadConfig } from "./config.js";
import { resolveProvider } from "./resolve-provider.js";
import { supportsInteractive } from "./tui/runtime-check.js";

export interface CreateCliOptions {
  /** CLI name shown in help and errors, e.g. "chatbridge" or "company-ai-cli". */
  name: string;
  /** Shown by --version and in the interactive startup banner. */
  version?: string;
  /** Interactive startup banner, one element per row; replaces the default
   * (name, version and a one-line hint). Used verbatim. */
  banner?: string[];
  /** Pinned provider. When set, --provider is rejected and config is not read. */
  provider?: Provider;
  /** Config directory name under ~/.config; defaults to `name`. */
  configDir?: string;
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
  /** Test-only: overrides "stdin and stdout are a TTY". */
  isTerminal?: boolean;
}

/** Single source of truth for `ChatBridgeError.code` → process exit code. */
const EXIT_CODES: Record<string, number> = {
  INVALID_ARGUMENT: 1,
  INVALID_CONFIG: 1,
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
  INVALID_PROVIDER: 5,
  INVALID_STATE: 1,
  BLOCKED: 6,
};

const DEFAULT_TIMEOUT_SEC = 120;

/** Validates --timeout before any browser is launched. */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_SEC * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ChatBridgeError(
      "INVALID_ARGUMENT",
      "--timeout must be a positive number of seconds",
    );
  }
  return seconds * 1000;
}

function isParseArgsError(err: unknown): err is Error & { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    err instanceof Error &&
    typeof code === "string" &&
    code.startsWith("ERR_PARSE_ARGS_")
  );
}

export function createCli(opts: CreateCliOptions) {
  const configDir = opts.configDir ?? opts.name;
  const location = { configDir, baseDir: opts.baseDir };

  function help(): string {
    const providerFlag = opts.provider ? "" : " [--provider <name|path>]";
    return [
      "Usage:",
      `  ${opts.name}${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} -p <prompt>${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} auth login${providerFlag}`,
      `  ${opts.name} auth logout${providerFlag}`,
      `  ${opts.name} auth status${providerFlag}`,
      `  ${opts.name} --version | -V`,
      "",
      "Without -p, an interactive chat opens (needs a terminal and Bun >= 1.3 or Node >= 26.4).",
      "One-shot mode prints the AI response to stdout.",
      "Exit codes: 1 usage/config, 2 not logged in, 3 auth expired, 4 timeout, 5 provider load, 6 blocked by the service (try --headful).",
      ...(opts.provider
        ? []
        : [
            "",
            `Without --provider, "defaultProvider" from ${configPath(location)} is used.`,
          ]),
    ].join("\n");
  }

  // Progress goes to stderr, and only when stderr is a TTY (stdout stays
  // pipe-safe: response body only).
  function progress(message: string): void {
    if (process.stderr.isTTY) process.stderr.write(`${message}\n`);
  }

  /** Resolution order: pinned provider → --provider → config defaultProvider. */
  async function getProvider(flag: string | undefined): Promise<Provider> {
    if (opts.provider) {
      if (flag !== undefined) {
        throw new ChatBridgeError(
          "INVALID_ARGUMENT",
          `${opts.name} has a fixed provider; --provider is not accepted`,
        );
      }
      return opts.provider;
    }
    const spec = flag ?? (await loadConfig(location)).defaultProvider;
    if (!spec) {
      throw new ProviderLoadError(
        `No provider specified. Pass --provider <npm-package|./path> or set "defaultProvider" in ${configPath(location)}.`,
      );
    }
    return resolveProvider(spec);
  }

  function reportError(err: unknown): number {
    if (isParseArgsError(err)) {
      process.stderr.write(`${opts.name}: ${err.message}\n\n${help()}\n`);
      return 1;
    }
    if (err instanceof ChatBridgeError) {
      process.stderr.write(`${opts.name}: ${err.message}\n`);
      if (process.env.CHATBRIDGE_DEBUG === "1" && err.cause !== undefined) {
        const cause = err.cause;
        const detail =
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : String(cause);
        process.stderr.write(`Caused by: ${detail}\n`);
      }
      return EXIT_CODES[err.code] ?? 1;
    }
    process.stderr.write(
      `${opts.name}: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  async function run(argv: string[]): Promise<number> {
    try {
      const { values, positionals } = parseArgs({
        args: argv.slice(2),
        options: {
          prompt: { type: "string", short: "p" },
          provider: { type: "string" },
          headful: { type: "boolean", default: false },
          timeout: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
          version: { type: "boolean", short: "V", default: false },
        },
        allowPositionals: true,
      });

      if (values.help) {
        console.log(help());
        return 0;
      }

      if (values.version) {
        console.log(
          opts.version === undefined
            ? opts.name
            : `${opts.name} v${opts.version}`,
        );
        return 0;
      }

      const [cmd, sub] = positionals;

      if (
        cmd === "auth" &&
        (sub === "login" || sub === "logout" || sub === "status")
      ) {
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        if (sub === "login") {
          await runLogin({ provider, authStore, onProgress: progress });
          return 0;
        }
        if (sub === "logout") {
          await authStore.clear();
          progress("✓ Auth state deleted");
          return 0;
        }
        console.log(
          authStore.has()
            ? `Auth state present for "${provider.name}" (${authStore.path()})`
            : `No auth state for "${provider.name}"`,
        );
        return 0;
      }

      if (cmd === undefined && values.prompt === undefined) {
        const isTerminal =
          opts.isTerminal ??
          (process.stdin.isTTY === true && process.stdout.isTTY === true);
        if (!isTerminal) {
          throw new ChatBridgeError(
            "INVALID_ARGUMENT",
            "interactive mode needs a terminal; use -p <prompt> for one-shot",
          );
        }
        if (
          !supportsInteractive({
            bun: process.versions.bun,
            node: process.versions.node,
          })
        ) {
          throw new ChatBridgeError(
            "INVALID_ARGUMENT",
            "interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on this runtime",
          );
        }
        const timeoutMs = parseTimeoutMs(values.timeout);
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        // Loaded lazily so one-shot and auth never evaluate @opentui/core.
        const { runInteractive } = await import("./tui/run-interactive.js");
        const result = await runInteractive({
          title: opts.name,
          version: opts.version,
          banner: opts.banner,
          provider,
          authStore,
          headless: !values.headful,
          timeoutMs,
          onProgress: progress,
        });
        return result.fatal === undefined ? 0 : reportError(result.fatal);
      }

      if (typeof values.prompt === "string") {
        const timeoutMs = parseTimeoutMs(values.timeout);
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        const reply = await runOneShot({
          provider,
          authStore,
          prompt: values.prompt,
          headless: !values.headful,
          timeoutMs,
          onProgress: progress,
        });
        // stdout: response body only.
        process.stdout.write(`${reply}\n`);
        return 0;
      }

      console.log(help());
      return 1;
    } catch (err) {
      return reportError(err);
    }
  }

  return { run };
}
