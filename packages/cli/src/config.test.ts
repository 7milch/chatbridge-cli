import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridgeError } from "@chatbridge/core";
import { configPath, loadConfig } from "./config.js";

let baseDir: string;
function setup(): string {
  baseDir = mkdtempSync(join(tmpdir(), "chatbridge-config-"));
  mkdirSync(join(baseDir, "test-cli"), { recursive: true });
  return join(baseDir, "test-cli", "config.json");
}
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

describe("loadConfig", () => {
  test("configPath is <baseDir>/<configDir>/config.json", () => {
    const file = setup();
    expect(configPath({ configDir: "test-cli", baseDir })).toBe(file);
  });

  test("returns {} when the file does not exist", async () => {
    setup();
    expect(await loadConfig({ configDir: "test-cli", baseDir })).toEqual({});
  });

  test("reads defaultProvider as an npm package name", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "@x/prov" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.defaultProvider).toBe("@x/prov");
  });

  test("resolves a relative defaultProvider against the config directory", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "./prov.ts" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.defaultProvider).toBe(join(baseDir, "test-cli", "prov.ts"));
  });

  test("ignores unknown keys", async () => {
    writeFileSync(setup(), JSON.stringify({ future: 1 }));
    expect(await loadConfig({ configDir: "test-cli", baseDir })).toEqual({});
  });

  test("invalid JSON becomes INVALID_CONFIG with cause and the file path", async () => {
    const file = setup();
    writeFileSync(file, "{ not json");
    let caught: unknown;
    try {
      await loadConfig({ configDir: "test-cli", baseDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatBridgeError);
    const e = caught as ChatBridgeError;
    expect(e.code).toBe("INVALID_CONFIG");
    expect(e.message).toContain(file);
    expect(e.cause).toBeInstanceOf(SyntaxError);
  });

  test("a non-object document is INVALID_CONFIG", async () => {
    writeFileSync(setup(), "[1,2]");
    await expect(
      loadConfig({ configDir: "test-cli", baseDir }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("a non-string defaultProvider is INVALID_CONFIG", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: 5 }));
    await expect(
      loadConfig({ configDir: "test-cli", baseDir }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
