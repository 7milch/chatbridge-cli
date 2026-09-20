import { describe, expect, test } from "bun:test";
import { BrowserUnavailableError, LoginAbortedError } from "@chatbridge/core";
import { SLASH_COMMANDS } from "@chatbridge/core/slash-commands";
import { type CommandDeps, createCommands } from "./commands.js";
import {
  type ChatSessionLike,
  SessionController,
} from "./session-controller.js";
import type { EditorSnapshot, VscodeUi } from "./vscode-ui.js";

interface Fake {
  ui: VscodeUi;
  log: string[];
  editor: EditorSnapshot | undefined;
  errorChoice: string | undefined;
  /** What the fake file picker returns; `[]` is a cancelled dialog. */
  picked: string[];
  controller: Pick<
    SessionController,
    | "send"
    | "runCommand"
    | "retryLast"
    | "newChat"
    | "reopen"
    | "discard"
    | "markLoggedIn"
    | "pushHelp"
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
    picked: [],
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
    isUri: (x) => typeof x === "string" && x.startsWith("file:"),
    parseUri: (uri) => uri,
    openDocument: async (uri) => {
      const raw = String(uri);
      if (raw.endsWith("/dir") || !raw.startsWith("file:")) {
        throw new Error(`cannot open ${raw}`);
      }
      return { path: `doc:${raw}`, text: "DOC" };
    },
    focusView: () => f.log.push("focus"),
    pickFiles: async () => {
      f.log.push("pickFiles");
      return f.picked;
    },
  };
  f.controller = {
    send: async (t) => {
      f.log.push(`send:${t}`);
      return f.sendResults.shift() ?? { ok: true };
    },
    runCommand: async (name, args, text) => {
      f.log.push(`runCommand:${name}:${args}:${text}`);
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
    pushHelp: (t: string) => f.log.push(`help:${t}`),
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

function commands(f: Fake, extra: Partial<CommandDeps> = {}) {
  return createCommands({
    displayName: "Acme AI",
    controller: f.controller as SessionController,
    ui: f.ui,
    runLogin: f.login,
    installBrowser: f.install,
    loginOptions: () => ({}) as never,
    installOptions: () => ({ cliPath: "/x/cli.js" }),
    clearAuth: async () => {
      f.log.push("clearAuth");
      f.cleared++;
    },
    ...extra,
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

  test("help pushes the slash-command listing into the history", () => {
    const f = fake();
    commands(f).help();
    expect(f.log).toHaveLength(1);
    const listing = f.log[0] ?? "";
    expect(listing.startsWith("help:")).toBe(true);
    for (const c of SLASH_COMMANDS) {
      expect(listing).toContain(`/${c.name}`);
      expect(listing).toContain(c.description);
    }
  });

  test("help also lists the provider's own commands", () => {
    const f = fake();
    commands(f, {
      commands: [{ name: "model", description: "Show the model" }],
    }).help();
    const listing = f.log[0] ?? "";
    expect(listing).toContain("/model");
    expect(listing).toContain("Show the model");
  });

  test("customCommand forwards name, args and the typed line", async () => {
    const f = fake();
    await commands(f).customCommand("model", "", "/model");
    expect(f.log).toEqual(["runCommand:model::/model"]);
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

  test("logout clears the auth state before discarding the session", async () => {
    const f = fake();
    await commands(f).logout();
    expect(f.log).toEqual(["clearAuth", "discard:Logged out"]);
    expect(f.cleared).toBe(1);
  });

  test("logout while a turn is in flight warns and keeps the auth state", async () => {
    const f = fake();
    f.busy = true;
    await commands(f).logout();
    expect(f.log).toEqual([
      "warn:Wait for the current reply to finish, then log out.",
    ]);
    expect(f.cleared).toBe(0);
  });

  test("logout warns when a turn starts while the auth state is deleted", async () => {
    const f = fake();
    // The turn starts during the clearAuth await: discard then refuses.
    const handlers = createCommands({
      displayName: "Acme AI",
      controller: f.controller as SessionController,
      ui: f.ui,
      runLogin: f.login,
      installBrowser: f.install,
      loginOptions: () => ({}) as never,
      installOptions: () => ({ cliPath: "/x/cli.js" }),
      clearAuth: async () => {
        f.log.push("clearAuth");
        f.busy = true;
      },
    });
    await handlers.logout();
    expect(f.log).toEqual([
      "clearAuth",
      "discard:Logged out",
      "warn:Wait for the current reply to finish, then log out.",
    ]);
  });

  test("a queued entry is not sent under the auth state logout deletes", async () => {
    const f = fake();
    const order: string[] = [];
    let rejectFirst!: (e: unknown) => void;
    const session: ChatSessionLike = {
      send: () =>
        new Promise<string>((_res, rej) => {
          rejectFirst = rej;
        }),
      close: async () => {},
      kill: async () => {},
    };
    const controller = new SessionController({
      openSession: async () => {
        order.push("openSession");
        return session;
      },
      closeTimeoutMs: 20,
    });
    const first = controller.send("in flight");
    await new Promise((r) => setTimeout(r, 0));
    await controller.send("queued");
    // The turn dies, leaving the queued entry waiting with no turn running.
    rejectFirst(new BrowserUnavailableError("gone"));
    await first;
    expect(controller.getState().status).toBe("dead");
    expect(controller.getState().queue).toHaveLength(1);
    const handlers = createCommands({
      displayName: "Acme AI",
      controller,
      ui: f.ui,
      runLogin: f.login,
      installBrowser: f.install,
      loginOptions: () => ({}) as never,
      installOptions: () => ({ cliPath: "/x/cli.js" }),
      clearAuth: async () => {
        order.push("clearAuth");
      },
    });
    await handlers.logout();
    await new Promise((r) => setTimeout(r, 0));
    // The queue drains after the logout, but never before the auth state is
    // gone: the reopen for it must not use the deleted credentials.
    expect(order).toEqual(["openSession", "clearAuth", "openSession"]);
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

  test("send returns the controller's result so the caller can refill the composer", async () => {
    const f = fake();
    f.sendResults.push({
      ok: false,
      code: "URL_HOOK",
      message: "https://w/x: 403",
    });
    expect(await commands(f).send("https://w/x")).toEqual({
      ok: false,
      code: "URL_HOOK",
      message: "https://w/x: 403",
    });
    // A hook refusal is the user's to fix: no install prompt.
    expect(f.log).toEqual(["send:https://w/x"]);
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

  test("sendFile with a non-Uri argument warns instead of throwing", async () => {
    const f = fake();
    await commands(f).sendFile({ not: "a uri" });
    expect(f.log).toEqual(["warn:Nothing to attach."]);
  });

  test("pasted: a whitespace-only selection never matches", () => {
    const f = fake();
    f.editor = {
      path: "/w/a.ts",
      text: "x",
      selection: { text: "   \n", startLine: 1, endLine: 2 },
    };
    expect(commands(f).pasted("   \n")).toBe(false);
  });

  test("attachUris deduplicates repeated URIs", async () => {
    const f = fake();
    await commands(f).attachUris(["file:///w/a", "file:///w/a"]);
    expect(f.log.filter((l) => l.startsWith("attach:"))).toHaveLength(1);
  });

  test("pickFiles attaches every picked URI through attachUris", async () => {
    const f = fake();
    f.picked = ["file:///a.ts", "file:///b.ts"];
    await commands(f).pickFiles();
    expect(f.log).toEqual([
      "pickFiles",
      "attach:doc:file:///a.ts:3",
      "focus",
      "attach:doc:file:///b.ts:3",
      "focus",
    ]);
  });

  test("a cancelled file picker does nothing", async () => {
    const f = fake();
    await commands(f).pickFiles();
    expect(f.log).toEqual(["pickFiles"]);
  });

  test("a VscodeUi without pickFiles makes the command a no-op", async () => {
    // `pickFiles` is optional so a vendor's own VscodeUi, written against
    // 0.9.0, keeps compiling and activating on a patch bump.
    const f = fake();
    const { pickFiles: _omitted, ...ui } = f.ui;
    f.ui = ui as typeof f.ui;
    await commands(f).pickFiles();
    expect(f.log).toEqual([]);
  });

  test("pickFiles reports what it could not read, like a drop does", async () => {
    const f = fake();
    f.picked = ["file:///dir"];
    await commands(f).pickFiles();
    expect(f.log).toEqual(["pickFiles", "warn:Skipped: file:///dir"]);
  });

  test("helpInView focuses the view before listing the commands", () => {
    const f = fake();
    commands(f).helpInView();
    expect(f.log).toHaveLength(2);
    expect(f.log[0]).toBe("focus");
    expect(f.log[1] ?? "").toStartWith("help:");
  });
});
