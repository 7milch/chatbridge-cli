import { resolve } from "node:path";
import { type Provider, ProviderLoadError } from "@chatbridge/core";

const REQUIRED_METHODS = [
  "navigateToLogin",
  "isLoggedIn",
  "startNewChat",
  "sendMessage",
  "waitForResponse",
] as const;

function isProvider(value: unknown): value is Provider {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.chatUrl === "string" &&
    REQUIRED_METHODS.every((m) => typeof v[m] === "function")
  );
}

/** Loads a Provider from a local file path or an npm package name.
 * The module's default export must implement the Provider interface. */
export async function resolveProvider(spec: string): Promise<Provider> {
  const isPath =
    spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
  const target = isPath ? resolve(process.cwd(), spec) : spec;
  let mod: { default?: unknown };
  try {
    mod = await import(target);
  } catch (err) {
    throw new ProviderLoadError(
      `Could not load provider "${spec}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isProvider(mod.default)) {
    throw new ProviderLoadError(
      `Module "${spec}" does not default-export a Provider (name, chatUrl, and the five methods are required).`,
    );
  }
  return mod.default;
}
