import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type ChildLike,
  installBrowser,
  splitProgressLines,
} from "./install-browser.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe("splitProgressLines", () => {
  test("splits on \\n and \\r, trims, drops empty", () => {
    expect(
      splitProgressLines(
        "Downloading Chromium 131\r|■■  | 20%\r|■■■■| 40%\n\n",
      ),
    ).toEqual(["Downloading Chromium 131", "|■■  | 20%", "|■■■■| 40%"]);
  });
});

describe("installBrowser", () => {
  test("spawns playwright's CLI with the host binary as node", async () => {
    let call:
      | { cmd: string; args: string[]; env: Record<string, string | undefined> }
      | undefined;
    const child = new FakeChild();
    const lines: string[] = [];
    const p = installBrowser({
      cliPath: "/ext/node_modules/playwright/cli.js",
      execPath: "/Applications/Code.app/Code Helper (Plugin)",
      env: { PATH: "/usr/bin" },
      spawn: (cmd, args, opts) => {
        call = { cmd, args, env: opts.env };
        return child;
      },
      onProgress: (l) => lines.push(l),
    });
    child.stdout.emit("data", Buffer.from("Downloading Chromium\r|■| 50%\n"));
    child.emit("exit", 0);
    await p;
    expect(call).toEqual({
      cmd: "/Applications/Code.app/Code Helper (Plugin)",
      args: ["/ext/node_modules/playwright/cli.js", "install", "chromium"],
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(lines).toEqual(["Downloading Chromium", "|■| 50%"]);
  });

  test("rejects on a non-zero exit with the last stderr line", async () => {
    const child = new FakeChild();
    const p = installBrowser({ cliPath: "/x/cli.js", spawn: () => child });
    child.stderr.emit("data", "Error: no space left\n");
    child.emit("exit", 1);
    await expect(p).rejects.toThrow(
      "playwright install chromium exited with 1: Error: no space left",
    );
  });

  test("rejects when the process cannot be spawned", async () => {
    const child = new FakeChild();
    const p = installBrowser({ cliPath: "/x/cli.js", spawn: () => child });
    child.emit("error", new Error("spawn ENOENT"));
    await expect(p).rejects.toThrow("spawn ENOENT");
  });
});
