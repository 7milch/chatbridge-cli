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
    | "discard"
    | "markLoggedIn"
    | "addAttachment"
    | "removeAttachment"
    | "getState"
  >;
  sendResults: Array<Awaited<ReturnType<SessionController["send"]>>>;
  login: CommandDeps["runLogin"];
  install: CommandDeps["installBrowser"];
  cleared: number;
}

function fake(): Fake {
  const f = { log: [], sendResults: [], cleared: 0 } as unknown as Fake;
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
    openDocument: async (uri) => ({ path: `doc:${String(uri)}`, text: "DOC" }),
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
    newChat: async () => f.log.push("newChat"),
    discard: async (s) => f.log.push(`discard:${s}`),
    markLoggedIn: () => f.log.push("markLoggedIn"),
    addAttachment: (a) => {
      f.log.push(`attach:${a.path}:${a.bytes}`);
      return a.path.includes("toobig")
        ? { ok: false, reason: "too big" }
        : { ok: true };
    },
    removeAttachment: (i) => f.log.push(`remove:${i}`),
    getState: () => ({ status: "idle", messages: [], pendingAttachments: [] }),
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
});
