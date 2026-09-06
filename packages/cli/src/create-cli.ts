import { parseArgs } from "node:util";
import {
  AuthStore,
  ChatBridgeError,
  type Provider,
  ProviderLoadError,
  runLogin,
  runOneShot,
} from "@chatbridge/core";
import { resolveProvider } from "./resolve-provider.js";

export interface CreateCliOptions {
  /** CLI name shown in help and errors, e.g. "chatbridge" or "company-ai-cli". */
  name: string;
  /** Pinned provider. When set, --provider is not accepted. */
  provider?: Provider;
  /** Config directory name under ~/.config; defaults to `name`. */
  configDir?: string;
  /** Test-only: overrides the auth-store base directory. */
  baseDir?: string;
}

const EXIT_CODES: Record<string, number> = {
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
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

export function createCli(opts: CreateCliOptions) {
  const configDir = opts.configDir ?? opts.name;

  function help(): string {
    const providerFlag = opts.provider ? "" : " [--provider <name|path>]";
    return [
      "Usage:",
      `  ${opts.name} -p <prompt>${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} auth login${providerFlag}`,
      `  ${opts.name} auth logout${providerFlag}`,
      `  ${opts.name} auth status${providerFlag}`,
      "",
      "One-shot mode prints the AI response to stdout.",
    ].join("\n");
  }

  // Progress goes to stderr, and only when stderr is a TTY (stdout stays
  // pipe-safe: response body only).
  function progress(message: string): void {
    if (process.stderr.isTTY) process.stderr.write(`${message}\n`);
  }

  async function getProvider(flag: string | undefined): Promise<Provider> {
    if (opts.provider) return opts.provider;
    if (!flag) {
      throw new ProviderLoadError(
        "No provider specified. Pass --provider <npm-package|./path>.",
      );
    }
    return resolveProvider(flag);
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
        },
        allowPositionals: true,
      });

      if (values.help) {
        console.log(help());
        return 0;
      }

      const [cmd, sub] = positionals;

      if (
        cmd === "auth" &&
        (sub === "login" || sub === "logout" || sub === "status")
      ) {
        const provider = await getProvider(values.provider);
        const authStore = new AuthStore({
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

      if (typeof values.prompt === "string") {
        const timeoutMs = parseTimeoutMs(values.timeout);
        const provider = await getProvider(values.provider);
        const authStore = new AuthStore({
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
      return cmd === undefined ? 0 : 1;
    } catch (err) {
      if (err instanceof ChatBridgeError) {
        process.stderr.write(`${opts.name}: ${err.message}\n`);
        return EXIT_CODES[err.code] ?? 1;
      }
      process.stderr.write(
        `${opts.name}: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  return { run };
}
