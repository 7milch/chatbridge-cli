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

  test("reads the shell section", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ shell: { leadIn: "Check:", autoSend: false } }),
    );
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.shell).toEqual({ leadIn: "Check:", autoSend: false });
  });

  test("a partial shell section keeps only the given keys", async () => {
    writeFileSync(setup(), JSON.stringify({ shell: { leadIn: "Check:" } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.shell).toEqual({ leadIn: "Check:" });
    expect("autoSend" in (cfg.shell ?? {})).toBe(false);
  });

  test("no shell section leaves the key absent", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "@x/p" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect("shell" in cfg).toBe(false);
  });

  test.each([
    [{ shell: [] }, '"shell" must be an object'],
    [{ shell: "x" }, '"shell" must be an object'],
    [{ shell: { leadIn: 5 } }, '"shell.leadIn" must be a string'],
    [{ shell: { autoSend: "no" } }, '"shell.autoSend" must be a boolean'],
  ])("%j is INVALID_CONFIG", async (doc: unknown, why: string) => {
    writeFileSync(setup(), JSON.stringify(doc));
    let caught: unknown;
    try {
      await loadConfig({ configDir: "test-cli", baseDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatBridgeError);
    expect((caught as ChatBridgeError).code).toBe("INVALID_CONFIG");
    expect((caught as ChatBridgeError).message).toContain(why);
  });

  test("providerPinned: defaultProvider is ignored even when invalid", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ defaultProvider: 5, shell: { autoSend: false } }),
    );
    const cfg = await loadConfig(
      { configDir: "test-cli", baseDir },
      { providerPinned: true },
    );
    expect(cfg).toEqual({ shell: { autoSend: false } });
  });

  test("reads the open section", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ open: { timeoutSec: 30, retries: 2 } }),
    );
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.open).toEqual({ timeoutSec: 30, retries: 2 });
  });

  test("a partial open section keeps only the given keys", async () => {
    writeFileSync(setup(), JSON.stringify({ open: { retries: 1 } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.open).toEqual({ retries: 1 });
  });

  test.each([
    [{ open: 5 }, '"open" must be an object'],
    [
      { open: { timeoutSec: "30" } },
      '"open.timeoutSec" must be a positive number',
    ],
    [
      { open: { timeoutSec: 0 } },
      '"open.timeoutSec" must be a positive number',
    ],
    [
      { open: { retries: -1 } },
      '"open.retries" must be a non-negative integer',
    ],
    [
      { open: { retries: 1.5 } },
      '"open.retries" must be a non-negative integer',
    ],
  ])("rejects %j", async (doc, message) => {
    writeFileSync(setup(), JSON.stringify(doc));
    const p = loadConfig({ configDir: "test-cli", baseDir });
    await expect(p).rejects.toBeInstanceOf(ChatBridgeError);
    await expect(p).rejects.toThrow(message);
  });

  test.each([
    // JSON.stringify(Infinity) is null, so this row's file content is
    // written by hand: JSON.parse reads 1e999 as Infinity.
    [
      '{"open":{"timeoutSec":1e999}}',
      '"open.timeoutSec" must be a positive number',
    ],
  ])("rejects %s", async (content, message) => {
    writeFileSync(setup(), content);
    const p = loadConfig({ configDir: "test-cli", baseDir });
    await expect(p).rejects.toBeInstanceOf(ChatBridgeError);
    await expect(p).rejects.toThrow(message);
  });

  test("reads the idle section", async () => {
    writeFileSync(setup(), JSON.stringify({ idle: { timeoutMin: 30 } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.idle).toEqual({ timeoutMin: 30 });
  });

  test("idle.timeoutMin 0 is allowed: it disables the idle close", async () => {
    writeFileSync(setup(), JSON.stringify({ idle: { timeoutMin: 0 } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.idle).toEqual({ timeoutMin: 0 });
  });

  test.each([
    [{ idle: 5 }, '"idle" must be an object'],
    [
      { idle: { timeoutMin: "30" } },
      '"idle.timeoutMin" must be a non-negative number',
    ],
    [
      { idle: { timeoutMin: -1 } },
      '"idle.timeoutMin" must be a non-negative number',
    ],
  ])("rejects %j", async (doc, message) => {
    writeFileSync(setup(), JSON.stringify(doc));
    const p = loadConfig({ configDir: "test-cli", baseDir });
    await expect(p).rejects.toBeInstanceOf(ChatBridgeError);
    await expect(p).rejects.toThrow(message);
  });
});
