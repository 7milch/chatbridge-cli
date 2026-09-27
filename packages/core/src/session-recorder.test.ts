import { describe, expect, test } from "bun:test";
import type { SessionRecord, StoredMessage } from "./session-record.js";
import {
  SessionRecorder,
  type SessionRecorderOptions,
  type SessionStoreLike,
} from "./session-recorder.js";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An in-memory store that logs every call. `gate`, when set, holds the
 * next save until the test resolves it. */
function fakeStore() {
  const files = new Map<string, SessionRecord>();
  const log: string[] = [];
  const state = {
    failSave: false,
    failClear: false,
    gate: undefined as ReturnType<typeof deferred<void>> | undefined,
  };
  const store: SessionStoreLike = {
    async save(record) {
      log.push(`save:${record.id}:${record.messages.length}`);
      if (state.gate) {
        const gate = state.gate;
        state.gate = undefined;
        await gate.promise;
      }
      if (state.failSave) throw new Error("disk full");
      files.set(record.id, structuredClone(record));
    },
    async load(id) {
      log.push(`load:${id}`);
      return files.get(id);
    },
    async list(opts) {
      log.push(`list:${opts?.current ?? "-"}`);
      return [...files.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((r) => ({
          id: r.id,
          updatedAt: r.updatedAt,
          title: r.messages[0]?.text ?? "",
          turns: r.messages.filter((m) => m.role === "user").length,
        }));
    },
    async prune(opts) {
      log.push(`prune:${opts?.current ?? "-"}`);
    },
    async clear() {
      log.push("clear");
      if (state.failClear) throw new Error("permission denied");
      files.clear();
    },
  };
  return { store, files, log, state };
}

function setup(over: Partial<SessionRecorderOptions> = {}) {
  const s = fakeStore();
  let clock = NOW;
  let next = 1;
  const failures: number[] = [];
  const recorder = new SessionRecorder({
    store: s.store,
    provider: "dummy-chat",
    now: () => clock,
    newId: () => `id-${next++}`,
    onSaveFailed: () => failures.push(1),
    ...over,
  });
  return {
    ...s,
    recorder,
    failures,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const user = (text: string): StoredMessage => ({ role: "user", text });
const reply = (text: string): StoredMessage => ({ role: "assistant", text });
const turn = (n: number): StoredMessage[] => [user(`q${n}`), reply(`a${n}`)];

describe("SessionRecorder", () => {
  test("saves nothing until there is a user or shell message", async () => {
    const t = setup();
    t.recorder.record({
      conversation: undefined,
      messages: [{ role: "separator", text: "reopened" }],
    });
    await t.recorder.flush();
    expect(t.log).toEqual([]);
    expect(t.recorder.id).toBeUndefined();
  });

  test("the first save creates the record and prunes once", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    await t.recorder.flush();
    expect(t.recorder.id).toBe("id-1");
    expect(t.files.get("id-1")).toEqual({
      version: 1,
      id: "id-1",
      provider: "dummy-chat",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      conversation: "H1",
      messages: turn(1),
    });
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1"]);
  });

  test("a shell message alone is enough to start a session", async () => {
    const t = setup();
    t.recorder.record({
      conversation: undefined,
      messages: [{ role: "shell", text: "ls" }],
    });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
  });

  test("later saves rewrite the same file, keep createdAt, move updatedAt, and do not prune", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    await t.recorder.flush();
    t.tick(5000);
    t.recorder.record({
      conversation: "H2",
      messages: [...turn(1), ...turn(2)],
    });
    await t.recorder.flush();
    const saved = t.files.get("id-1");
    expect(saved?.createdAt).toBe(new Date(NOW).toISOString());
    expect(saved?.updatedAt).toBe(new Date(NOW + 5000).toISOString());
    expect(saved?.conversation).toBe("H2");
    expect(saved?.messages).toHaveLength(4);
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1", "save:id-1:4"]);
  });

  test("a snapshot without a handle writes no conversation key", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect("conversation" in (t.files.get("id-1") ?? {})).toBe(false);
  });

  test("the snapshot is copied: a later mutation does not reach the file", async () => {
    const t = setup();
    const messages = turn(1);
    t.recorder.record({ conversation: undefined, messages });
    messages.push(user("later"));
    await t.recorder.flush();
    expect(t.files.get("id-1")?.messages).toHaveLength(2);
  });

  // Review Focus 3.
  test("saves are serialised: the newer snapshot lands last", async () => {
    const t = setup();
    t.state.gate = deferred<void>();
    const gate = t.state.gate;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.record({
      conversation: undefined,
      messages: [...turn(1), ...turn(2)],
    });
    // Only the first save has started; the second waits for it.
    await Promise.resolve();
    await Promise.resolve();
    expect(t.log).toEqual(["save:id-1:2"]);
    gate.resolve();
    await t.recorder.flush();
    expect(t.files.get("id-1")?.messages).toHaveLength(4);
  });

  test("startNew makes the next record a new session", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    t.recorder.startNew();
    expect(t.recorder.id).toBeUndefined();
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    await t.recorder.flush();
    expect([...t.files.keys()]).toEqual(["id-1", "id-2"]);
    expect(t.files.get("id-1")?.messages).toEqual(turn(1));
  });

  test("adopt continues the adopted record", async () => {
    const t = setup();
    const old: SessionRecord = {
      version: 1,
      id: "old",
      provider: "dummy-chat",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      conversation: "H9",
      messages: turn(9),
    };
    t.files.set("old", old);
    t.recorder.adopt(old);
    expect(t.recorder.id).toBe("old");
    t.recorder.record({
      conversation: "H9",
      messages: [...turn(9), ...turn(10)],
    });
    await t.recorder.flush();
    expect(t.files.get("old")?.createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(t.files.get("old")?.updatedAt).toBe(new Date(NOW).toISOString());
    // Adopted, not created: no prune.
    expect(t.log).toEqual(["save:old:4"]);
  });

  test("list waits for queued saves and leaves the current session out", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.startNew();
    t.tick(1000);
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    const list = await t.recorder.list();
    expect(list.map((s) => s.id)).toEqual(["id-1"]);
    expect(t.log.at(-1)).toBe("list:id-2");
  });

  test("load passes through", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect((await t.recorder.load("id-1"))?.id).toBe("id-1");
    expect(await t.recorder.load("nope")).toBeUndefined();
  });

  // Review Focus 4.
  test("a failed save reports once per session and the next save tries again", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.failures).toHaveLength(1);
    t.state.failSave = false;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
    // The first successful save of the session prunes.
    expect(t.log.at(-1)).toBe("prune:id-1");
  });

  test("a new session reports its own first failure", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.startNew();
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    await t.recorder.flush();
    expect(t.failures).toHaveLength(2);
  });

  test("a throwing prune is not a failed save", async () => {
    const t = setup();
    t.store.prune = async () => {
      throw new Error("boom");
    };
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.failures).toEqual([]);
    expect(t.files.has("id-1")).toBe(true);
  });

  test("flush never rejects", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
  });

  test("clear runs after queued saves, deletes, and starts a new session", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.clear();
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1", "clear"]);
    expect(t.files.size).toBe(0);
    expect(t.recorder.id).toBeUndefined();
  });

  test("clear rejects when the delete failed, and the recorder stays usable", async () => {
    const t = setup();
    t.state.failClear = true;
    await expect(t.recorder.clear()).rejects.toThrow("permission denied");
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
  });

  describe("when saving is off", () => {
    test("record and list do nothing", async () => {
      const t = setup({ enabled: () => false });
      expect(t.recorder.enabled).toBe(false);
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      expect(await t.recorder.list()).toEqual([]);
      await t.recorder.flush();
      expect(t.log).toEqual([]);
    });

    test("clear still deletes", async () => {
      const t = setup({ enabled: () => false });
      await t.recorder.clear();
      expect(t.log).toEqual(["clear"]);
    });

    test("the setting is read on every call", async () => {
      let on = false;
      const t = setup({ enabled: () => on });
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      on = true;
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      await t.recorder.flush();
      expect(t.log).toEqual(["save:id-1:2", "prune:id-1"]);
    });
  });
});
