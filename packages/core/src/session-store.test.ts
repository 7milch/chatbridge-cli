import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./session-record.js";
import {
  SESSION_MAX_AGE_MS,
  SESSION_MAX_COUNT,
  SessionStore,
  TEMP_MAX_AGE_MS,
} from "./session-store.js";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(now: () => number = () => NOW) {
  const baseDir = mkdtempSync(join(tmpdir(), "chatbridge-sessions-"));
  dirs.push(baseDir);
  const store = new SessionStore({
    configDir: "test-cli",
    providerName: "dummy-chat",
    baseDir,
    now,
  });
  return { baseDir, store };
}

/** A valid id whose last 12 hex digits are `n`. */
function idOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function record(n: number, updatedAt: number): SessionRecord {
  return {
    version: 1,
    id: idOf(n),
    provider: "dummy-chat",
    createdAt: new Date(updatedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    conversation: `https://example.test/chat/c/${n}`,
    messages: [
      { role: "user", text: `prompt ${n}` },
      { role: "assistant", text: `reply ${n}` },
    ],
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("SessionStore", () => {
  test("dir() is <base>/<configDir>/sessions/<provider>", () => {
    const { baseDir, store } = setup();
    expect(store.dir()).toBe(
      join(baseDir, "test-cli", "sessions", "dummy-chat"),
    );
  });

  test("rejects a provider name that is not a file name", () => {
    expect(
      () =>
        new SessionStore({ configDir: "test-cli", providerName: "../escape" }),
    ).toThrow();
  });

  test("save then load round-trips", async () => {
    const { store } = setup();
    const r = record(1, NOW);
    await store.save(r);
    expect(await store.load(r.id)).toEqual(r);
  });

  test("directories are 0700 and files 0600", async () => {
    const { baseDir, store } = setup();
    await store.save(record(1, NOW));
    expect(mode(join(baseDir, "test-cli", "sessions"))).toBe(0o700);
    expect(mode(store.dir())).toBe(0o700);
    expect(mode(join(store.dir(), `${idOf(1)}.json`))).toBe(0o600);
  });

  test("a second save replaces the file and leaves no temporary file", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const next = { ...record(1, NOW + 1000), messages: [] };
    await store.save(next);
    expect(await store.load(idOf(1))).toEqual(next);
    expect(readdirSync(store.dir())).toEqual([`${idOf(1)}.json`]);
  });

  test("save rejects a malformed id and writes nothing", async () => {
    const { store } = setup();
    await expect(
      store.save({ ...record(1, NOW), id: "../escape" }),
    ).rejects.toThrow("Invalid session id.");
    expect(await store.list()).toEqual([]);
  });

  test("load returns undefined for a malformed id", async () => {
    const { store } = setup();
    expect(await store.load("../../etc/passwd")).toBeUndefined();
  });

  test("load returns undefined for a missing file", async () => {
    const { store } = setup();
    expect(await store.load(idOf(9))).toBeUndefined();
  });

  test("load returns undefined for broken JSON, another version, another id, another provider", async () => {
    const { store } = setup();
    mkdirSync(store.dir(), { recursive: true });
    const write = (n: number, body: string) =>
      writeFileSync(join(store.dir(), `${idOf(n)}.json`), body);
    write(1, "{ not json");
    write(2, JSON.stringify({ ...record(2, NOW), version: 2 }));
    write(3, JSON.stringify(record(4, NOW)));
    write(5, JSON.stringify({ ...record(5, NOW), provider: "other" }));
    for (const n of [1, 2, 3, 5]) {
      expect(await store.load(idOf(n))).toBeUndefined();
    }
  });

  test("list is newest first and skips unreadable files", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - 3 * DAY));
    await store.save(record(2, NOW - 1 * DAY));
    await store.save(record(3, NOW - 2 * DAY));
    writeFileSync(join(store.dir(), `${idOf(4)}.json`), "{ not json");
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([idOf(2), idOf(3), idOf(1)]);
    expect(list[0]).toEqual({
      id: idOf(2),
      updatedAt: new Date(NOW - 1 * DAY).toISOString(),
      title: "prompt 2",
      turns: 1,
    });
  });

  test("list on a directory that does not exist is empty", async () => {
    const { store } = setup();
    expect(await store.list()).toEqual([]);
  });

  test("prune deletes records older than the retention period", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - 1));
    await store.save(record(2, NOW - SESSION_MAX_AGE_MS + 1000));
    await store.prune();
    expect(readdirSync(store.dir())).toEqual([`${idOf(2)}.json`]);
  });

  test("prune keeps the current session whatever its age", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - DAY));
    await store.prune({ current: idOf(1) });
    expect(readdirSync(store.dir())).toEqual([`${idOf(1)}.json`]);
  });

  test("prune keeps the newest SESSION_MAX_COUNT records", async () => {
    const { store } = setup();
    for (let n = 1; n <= SESSION_MAX_COUNT + 3; n++) {
      await store.save(record(n, NOW - n * 1000));
    }
    const list = await store.list();
    expect(list).toHaveLength(SESSION_MAX_COUNT);
    expect(list[0]?.id).toBe(idOf(1));
    expect(list.at(-1)?.id).toBe(idOf(SESSION_MAX_COUNT));
  });

  test("the cap never deletes the current session", async () => {
    const { store } = setup();
    for (let n = 1; n <= SESSION_MAX_COUNT + 1; n++) {
      await store.save(record(n, NOW - n * 1000));
    }
    const oldest = idOf(SESSION_MAX_COUNT + 1);
    const list = await store.list({ current: oldest });
    expect(list.map((s) => s.id)).toContain(oldest);
  });

  test("an unreadable file goes by its mtime and is not counted", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const fresh = join(store.dir(), `${idOf(2)}.json`);
    const stale = join(store.dir(), `${idOf(3)}.json`);
    writeFileSync(fresh, "{ not json");
    writeFileSync(stale, "{ not json");
    const old = (NOW - SESSION_MAX_AGE_MS - DAY) / 1000;
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    utimesSync(stale, old, old);
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      [`${idOf(1)}.json`, `${idOf(2)}.json`].sort(),
    );
  });

  test("a stale temporary file is removed, a fresh one is left", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const fresh = join(store.dir(), `${idOf(1)}.aaaa.tmp`);
    const stale = join(store.dir(), `${idOf(1)}.bbbb.tmp`);
    writeFileSync(fresh, "x");
    writeFileSync(stale, "x");
    const old = (NOW - TEMP_MAX_AGE_MS - 1000) / 1000;
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    utimesSync(stale, old, old);
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      [`${idOf(1)}.json`, `${idOf(1)}.aaaa.tmp`].sort(),
    );
  });

  test("files that are neither .json nor .tmp are left alone", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    writeFileSync(join(store.dir(), "README"), "x");
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      ["README", `${idOf(1)}.json`].sort(),
    );
  });

  // Review Focus 2: another process deleted the file first.
  test("prune and list survive a directory another process emptied", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - DAY));
    rmSync(store.dir(), { recursive: true, force: true });
    await store.prune();
    expect(await store.list()).toEqual([]);
  });

  test("clear deletes every session of the provider and nothing else", async () => {
    const { baseDir, store } = setup();
    await store.save(record(1, NOW));
    const other = new SessionStore({
      configDir: "test-cli",
      providerName: "other",
      baseDir,
      now: () => NOW,
    });
    await other.save({ ...record(2, NOW), provider: "other" });
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect((await other.list()).map((s) => s.id)).toEqual([idOf(2)]);
  });

  test("clear on a directory that does not exist resolves", async () => {
    const { store } = setup();
    await store.clear();
  });
});
