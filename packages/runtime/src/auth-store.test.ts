import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "./auth-store.js";

let dir: string;
function makeStore(): AuthStore {
  dir = mkdtempSync(join(tmpdir(), "chatbridge-test-"));
  return new AuthStore({
    configDir: "chatbridge",
    providerName: "dummy",
    baseDir: dir,
  });
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AuthStore", () => {
  test("save/load round trip with restrictive permissions", async () => {
    const store = makeStore();
    expect(store.has()).toBe(false);
    await store.save({ cookies: [{ name: "sid", value: "x" }] });
    expect(store.has()).toBe(true);
    expect(statSync(store.path()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "chatbridge", "auth")).mode & 0o777).toBe(0o700);
    const loaded = (await store.load()) as { cookies: Array<{ name: string }> };
    expect(loaded.cookies[0]?.name).toBe("sid");
  });

  test("clear deletes the file and is idempotent", async () => {
    const store = makeStore();
    await store.save({ cookies: [] });
    await store.clear();
    expect(store.has()).toBe(false);
    await store.clear(); // no throw
  });

  test("load throws when no state exists", async () => {
    const store = makeStore();
    await expect(store.load()).rejects.toThrow();
  });
});
