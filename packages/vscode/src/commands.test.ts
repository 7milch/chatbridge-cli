import { describe, expect, test } from "bun:test";
import { BrowserUnavailableError, LoginAbortedError } from "@chatbridge/core";
import { type CommandDeps, createCommands } from "./commands.js";
import type { SessionController } from "./session-controller.js";
import type { EditorSnapshot, VscodeUi } from "./vscode-ui.js";

interface Fake {
  ui: VscodeUi;
  log: string[];
  editor: EditorSnapshot | undefined;
  errorChoice: string | undefined;
  controller: Pick<
    SessionController,
    | "send"
    | "retryLast"
    | "newChat"
    | "reopen"
    | "discard"
    | "markLoggedIn"
    | "addAttachment"
    | "removeAttachment"
    | "getState"
  >;
  sendResults: Array<Awaited<ReturnType<SessionController["send"]>>>;
  /** Drives both `getState().status` and what `discard` returns. */
  busy: boolean;
  login: CommandDeps["runLogin"];
  install: CommandDeps["installBrowser"];
  cleared: number;
}

function fake(): Fake {
  const f = {
    log: [],
    sendResults: [],
    cleared: 0,
    busy: false,
  } as unknown as Fake;
  f.ui = {
    showErrorMessage: async (m, ...items) => {
      f.log.push(`error:${m}${items.length ? `[${items.join(",")}]` : ""}`);
      return f.errorChoice;
    },
    showWarningMessage: (m) => f.log.push(`warn:${m}`),
    showInformationMessage: (m) => f.log.push(`info:${m}`),
    withProgress: async (title, _cancellable, task) => {
      f.log.push(`progress:${title}`);
      return task(
        { report: (t) => f.log.push(`report:${t}`) },
        new AbortController().signal,
      );
    },
    activeEditor: () => f.editor,
    parseUri: (uri) => uri,
    openDocument: async (uri) => {
      const raw = String(uri);
      if (raw.endsWith("/dir") || !raw.startsWith("file:")) {
        throw new Error(`cannot open ${raw}`);
      }
      return { path: `doc:${raw}`, text: "DOC" };
    },
    focusView: () => f.log.push("focus"),
  };
  f.controller = {
    send: async (t) => {
      f.log.push(`send:${t}`);
      return f.sendResults.shift() ?? { ok: true };
    },
    retryLast: async () => {
      f.log.push("retry");
      return { ok: true };
    },
    newChat: async () => {
      f.log.push("newChat");
      return !f.busy;
    },
    reopen: async () => {
      f.log.push("reopen");
    },
    discard: async (s) => {
      f.log.push(`discard:${s}`);
      return !f.busy;
    },
    markLoggedIn: () => f.log.push("markLoggedIn"),
    addAttachment: (a) => {
      f.log.push(`attach:${a.path}:${a.bytes}`);
      return a.path.includes("toobig")
        ? { ok: false, reason: "too big" }
        : { ok: true };
    },
    removeAttachment: (i) => f.log.push(`remove:${i}`),
    getState: () => ({
      status: f.busy ? ("busy" as const) : ("idle" as const),
      messages: [],
      pendingAttachments: [],
    }),
  };
  f.login = async (o) => {
    f.log.push("runLogin");
    o.onProgress?.("Opening browser...");
  };
  f.install = async (o) => {
    f.log.push("installBrowser");
    o.onProgress?.("Downloading Chromium");
  };
  return f;
}

function commands(f: Fake) {
  return createCommands({
    displayName: "Acme AI",
    controller: f.controller as SessionController,
    ui: f.ui,
    runLogin: f.login,
    installBrowser: f.install,
    loginOptions: () => ({}) as never,
    installOptions: () => ({ cliPath: "/x/cli.js" }),
    clearAuth: async () => {
      f.cleared++;
    },
  });
}

describe("commands", () => {
  test("login runs runLogin under progress and marks the controller", async () => {
    const f = fake();
    await commands(f).login();
    expect(f.log).toEqual([
      "progress:Log in to Acme AI",
      "runLogin",
      "report:Opening browser...",
      "markLoggedIn",
    ]);
  });

  test("a cancelled login is silent; another failure is shown", async () => {
    const f = fake();
    f.login = async () => {
      throw new LoginAbortedError();
    };
    await commands(f).login();
    expect(f.log.filter((l) => l.startsWith("error"))).toEqual([]);
    f.login = async () => {
      throw new Error("navigateToLogin failed");
    };
    await commands(f).login();
    expect(f.log.at(-1)).toBe("error:Login failed: navigateToLogin failed");
  });

  test("logout discards the session and clears the auth state", async () => {
    const f = fake();
    await commands(f).logout();
    expect(f.log).toEqual(["discard:Logged out"]);
    expect(f.cleared).toBe(1);
  });

  test("logout while a turn is in flight warns and keeps the auth state", async () => {
    const f = fake();
    f.busy = true;
    await commands(f).logout();
    expect(f.log).toEqual([
      "discard:Logged out",
      "warn:Wait for the current reply to finish, then log out.",
    ]);
    expect(f.cleared).toBe(0);
  });

  test("login while a turn is in flight warns and does not run runLogin", async () => {
    const f = fake();
    f.busy = true;
    await commands(f).login();
    expect(f.log).toEqual([
      "warn:Wait for the current reply to finish, then log in.",
    ]);
  });

  test("send forwards to the controller; a missing browser offers Install and retries", async () => {
    const f = fake();
    f.sendResults.push({
      ok: false,
      code: "BROWSER_UNAVAILABLE",
      message: new BrowserUnavailableError(
        "Chromium is not installed (expected at /x).",
      ).message,
    });
    f.errorChoice = "Install";
    await commands(f).send("hi");
    expect(f.log).toEqual([
      "send:hi",
      "error:Chromium is not installed (expected at /x).[Install]",
      "progress:Installing Chromium",
      "installBrowser",
      "report:Downloading Chromium",
      "retry",
    ]);
  });

  test("declining the install leaves the error in the history only", async () => {
    const f = fake();
    f.sendResults.push({
      ok: false,
      code: "BROWSER_UNAVAILABLE",
      message: "missing",
    });
    f.errorChoice = undefined;
    await commands(f).send("hi");
    expect(f.log).toEqual(["send:hi", "error:missing[Install]"]);
  });

  test("a failed install is reported and nothing is retried", async () => {
    const f = fake();
    f.sendResults.push({
      ok: false,
      code: "BROWSER_UNAVAILABLE",
      message: "missing",
    });
    f.errorChoice = "Install";
    f.install = async () => {
      throw new Error("exited with 1");
    };
    await commands(f).send("hi");
    expect(f.log.at(-1)).toBe("error:Chromium install failed: exited with 1");
    expect(f.log).not.toContain("retry");
  });

  test("other send failures are left to the history", async () => {
    const f = fake();
    f.sendResults.push({ ok: false, code: "AUTH_EXPIRED", message: "expired" });
    await commands(f).send("hi");
    expect(f.log).toEqual(["send:hi"]);
  });

  test("reopen delegates to the controller", async () => {
    const f = fake();
    await commands(f).reopen();
    expect(f.log).toEqual(["reopen"]);
  });

  test("newChat while busy warns instead of silently ignoring", async () => {
    const f = fake();
    f.busy = true;
    await commands(f).newChat();
    expect(f.log).toEqual([
      "newChat",
      "warn:Wait for the current reply to finish, or press Ctrl+R to reopen.",
    ]);
  });

  test("newChat while idle does not warn", async () => {
    const f = fake();
    await commands(f).newChat();
    expect(f.log).toEqual(["newChat"]);
  });

  test("send that was queued does not prompt for a browser install", async () => {
    const f = fake();
    f.sendResults.push({ ok: true, queued: true });
    await commands(f).send("two");
    expect(f.log).toEqual(["send:two"]);
  });

  test("installBrowser command runs the install under progress", async () => {
    const f = fake();
    await commands(f).installBrowser();
    expect(f.log).toEqual([
      "progress:Installing Chromium",
      "installBrowser",
      "report:Downloading Chromium",
      "info:Chromium installed.",
    ]);
  });

  test("sendSelection attaches the selection with a line range and focuses the view", async () => {
    const f = fake();
    f.editor = {
      path: "src/a.ts",
      text: "line1\nline2\nline3\n",
      selection: { text: "line2\nline3", startLine: 2, endLine: 3 },
    };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:src/a.ts:L2-L3:11", "focus"]);
  });

  test("sendSelection without a selection attaches the whole document", async () => {
    const f = fake();
    f.editor = { path: "src/a.ts", text: "abc" };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:src/a.ts:3", "focus"]);
  });

  test("sendSelection without an editor warns", async () => {
    const f = fake();
    await commands(f).sendSelection();
    expect(f.log).toEqual(["warn:No active editor."]);
  });

  test("an over-limit attachment is refused with the controller's reason", async () => {
    const f = fake();
    f.editor = { path: "toobig.ts", text: "x" };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:toobig.ts:1", "warn:too big"]);
  });

  test("sendFile with a uri opens that document; without one uses the editor", async () => {
    const f = fake();
    await commands(f).sendFile("file:///w/b.md");
    expect(f.log).toEqual(["attach:doc:file:///w/b.md:3", "focus"]);
    f.log.length = 0;
    f.editor = {
      path: "src/a.ts",
      text: "abcd",
      selection: { text: "b", startLine: 1, endLine: 1 },
    };
    await commands(f).sendFile(undefined);
    expect(f.log).toEqual(["attach:src/a.ts:4", "focus"]);
  });

  test("bytes are UTF-8 bytes, not characters", async () => {
    const f = fake();
    f.editor = { path: "j.md", text: "日本" };
    await commands(f).sendSelection();
    expect(f.log[0]).toBe("attach:j.md:6");
  });

  test("attachUris attaches every readable file and warns once about the rest", async () => {
    const f = fake();
    await commands(f).attachUris([
      "file:///w/a.ts",
      "file:///w/dir",
      "untitled:x",
      "file:///w/b.ts",
    ]);
    expect(f.log).toEqual([
      "attach:doc:file:///w/a.ts:3",
      "focus",
      "attach:doc:file:///w/b.ts:3",
      "focus",
      "warn:Skipped: file:///w/dir, untitled:x",
    ]);
  });

  test("pasted text equal to the editor selection becomes a selection chip", () => {
    const f = fake();
    f.editor = {
      path: "src/x.ts",
      text: "a\nb\nc\nd",
      selection: { text: "b\nc", startLine: 2, endLine: 3 },
    };
    expect(commands(f).pasted("b\r\nc")).toBe(true);
    expect(f.log).toEqual(["attach:src/x.ts:L2-L3:3", "focus"]);
  });

  test("pasted text that differs is not attached", () => {
    const f = fake();
    f.editor = {
      path: "src/x.ts",
      text: "a\nb",
      selection: { text: "a", startLine: 1, endLine: 1 },
    };
    expect(commands(f).pasted("zzz")).toBe(false);
    expect(f.log).toEqual([]);
  });
});
