import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ProviderLoadError } from "@chatbridge/core";
import { resolveProvider } from "./resolve-provider.js";

// `bun test` runs with cwd = repo root, so build absolute paths from this
// file's location instead of relying on the working directory.
const examplesDir = resolve(import.meta.dir, "../../../examples/dummy-chat");

describe("resolveProvider", () => {
  test("loads a local provider file by path", async () => {
    const p = await resolveProvider(resolve(examplesDir, "provider.ts"));
    expect(p.name).toBe("dummy-chat");
    expect(typeof p.sendMessage).toBe("function");
  });

  test("rejects a module whose default export is not a Provider", async () => {
    // The server module exists but does not default-export a Provider.
    await expect(
      resolveProvider(resolve(examplesDir, "server.ts")),
    ).rejects.toBeInstanceOf(ProviderLoadError);
  });

  test("rejects an unresolvable spec", async () => {
    await expect(
      resolveProvider("@chatbridge/definitely-not-a-real-package"),
    ).rejects.toBeInstanceOf(ProviderLoadError);
  });
});
