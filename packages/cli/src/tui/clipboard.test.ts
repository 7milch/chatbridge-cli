import { describe, expect, test } from "bun:test";
import {
  type ClipboardDeps,
  clipboardCommand,
  copyToClipboard,
  spawnClipboardProcess,
} from "./clipboard.js";

function deps(over: Partial<ClipboardDeps> & { exit?: number | Error } = {}) {
  const runs: Array<{ command: string; args: string[]; stdin: string }> = [];
  const osc: string[] = [];
  const d: ClipboardDeps = {
    env: {},
    platform: "darwin",
    process: {
      run: async (command, args, stdin) => {
        runs.push({ command, args, stdin });
        if (over.exit instanceof Error) throw over.exit;
        return over.exit ?? 0;
      },
    },
    osc52: (text) => {
      osc.push(text);
      return true;
    },
    ...over,
  };
  return { d, runs, osc };
}

describe("clipboardCommand", () => {
  test("per platform", () => {
    expect(clipboardCommand("darwin", {})).toEqual({
      command: "pbcopy",
      args: [],
    });
    expect(clipboardCommand("win32", {})).toEqual({
      command: "clip.exe",
      args: [],
    });
    expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(
      { command: "wl-copy", args: [] },
    );
    expect(clipboardCommand("linux", {})).toEqual({
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
    expect(clipboardCommand("freebsd", {})).toBeUndefined();
  });
});

describe("copyToClipboard", () => {
  test("local: the platform command gets the text on stdin, OSC 52 is not used", async () => {
    const { d, runs, osc } = deps();
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(runs).toEqual([{ command: "pbcopy", args: [], stdin: "hello" }]);
    expect(osc).toEqual([]);
  });

  test.each(["SSH_TTY", "SSH_CONNECTION"])(
    "over SSH (%s): OSC 52 only",
    async (name) => {
      const { d, runs, osc } = deps({ env: { [name]: "x" } });
      expect(await copyToClipboard("hello", d)).toBe(true);
      expect(runs).toEqual([]);
      expect(osc).toEqual(["hello"]);
    },
  );

  test("falls back to OSC 52 when the command is missing", async () => {
    const { d, osc } = deps({ exit: new Error("ENOENT") });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(osc).toEqual(["hello"]);
  });

  test("falls back to OSC 52 on a non-zero exit", async () => {
    const { d, osc } = deps({ exit: 1 });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(osc).toEqual(["hello"]);
  });

  test("false when the command fails and OSC 52 is not written", async () => {
    const { d } = deps({ exit: 1, osc52: () => false });
    expect(await copyToClipboard("hello", d)).toBe(false);
  });

  test("no command for the platform: OSC 52", async () => {
    const { d, runs, osc } = deps({ platform: "freebsd" });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(runs).toEqual([]);
    expect(osc).toEqual(["hello"]);
  });
});

describe("spawnClipboardProcess", () => {
  test.skipIf(process.platform === "win32")(
    "resolves 0 for a real, harmless command",
    async () => {
      expect(await spawnClipboardProcess.run("cat", [], "hello", 2000)).toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects when the command does not exist",
    async () => {
      await expect(
        spawnClipboardProcess.run(
          "definitely-not-a-command-xyz",
          [],
          "x",
          2000,
        ),
      ).rejects.toBeTruthy();
    },
  );
});
