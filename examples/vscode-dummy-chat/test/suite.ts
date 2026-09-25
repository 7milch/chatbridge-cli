import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionApi } from "@chatbridge/vscode";
import * as vscode from "vscode";

const EXTENSION_ID = "chatbridge-examples.chatbridge-example-vscode-dummy-chat";

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(
    ext,
    `extension ${EXTENSION_ID} not found; installed: ${vscode.extensions.all
      .map((e) => e.id)
      .join(", ")}`,
  );
  const api = (await ext.activate()) as ExtensionApi;
  const { controller, handlers, bridge } = api;

  assert.equal(controller.getState().status, "closed");

  // First turn: opens the browser lazily.
  const first = await controller.send("hello from vscode");
  assert.deepEqual(first, { ok: true });
  let s = controller.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1]?.role, "assistant");
  assert.match(s.messages[1]?.text ?? "", /^Echo: hello from vscode/);

  // Attachment through the command path.
  await vscode.commands.executeCommand("chatbridge-dummy.newChat");
  s = controller.getState();
  assert.equal(s.status, "closed");
  assert.deepEqual(s.messages.at(-1), { role: "separator", text: "New chat" });

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "# note\n",
  });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("chatbridge-dummy.sendSelection");
  assert.equal(controller.getState().pendingAttachments.length, 1);

  const second = await controller.send("with file");
  assert.deepEqual(second, { ok: true });
  s = controller.getState();
  assert.equal(s.messages.at(-2)?.attachments?.length, 1);
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: with file/);

  // Queue: a second send while busy waits, then drains.
  const busy = controller.send("first of two");
  const queued = await controller.send("second of two");
  assert.deepEqual(queued, { ok: true, queued: true });
  assert.equal(controller.getState().queue.length, 1);
  await busy;
  await waitForIdle(controller);
  s = controller.getState();
  assert.equal(s.queue.length, 0);
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: second of two/);

  // Reopen: the browser is replaced and the history marked. A handle was
  // learned after the three settled turns above ("with file", "first of
  // two", "second of two"), so the dummy provider restores the same
  // server-side conversation and the separator carries the restore note.
  // (`withRestoreNote(REOPENED_SEPARATOR, true)` in @chatbridge/core /
  // @chatbridge/vscode; hardcoded here rather than importing, since neither
  // is a declared dependency of this example.)
  const RESTORED_SEPARATOR = "reopened · conversation restored";
  await vscode.commands.executeCommand("chatbridge-dummy.reopen");
  s = controller.getState();
  assert.equal(s.status, "idle");
  assert.deepEqual(s.messages.at(-1), {
    role: "separator",
    text: RESTORED_SEPARATOR,
  });

  // Prove the restore is real: continuing after reopen lands back in the
  // same server-side conversation, so the dummy server's turn counter picks
  // up where it left off (3 turns settled before the reopen) rather than
  // resetting to 1.
  const turnsReply = await controller.send("turns?");
  assert.deepEqual(turnsReply, { ok: true });
  await waitForIdle(controller);
  s = controller.getState();
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: turns\? \(turn 4\)$/);

  // Reopen mid-turn: the in-flight reply is dropped, not appended.
  const stale = controller.send("stale me");
  await controller.reopen();
  await stale;
  await waitForIdle(controller);
  s = controller.getState();
  assert.equal(
    s.messages.some(
      (m) => m.role === "assistant" && m.text.includes("stale me"),
    ),
    false,
    "the reply from before the reopen must not reach the history",
  );
  // The in-flight "stale me" turn never settled, so the remembered handle
  // is still the one from the last turn that did settle ("turns?" above);
  // it exists, so this reopen restores too.
  assert.deepEqual(s.messages.filter((m) => m.role === "separator").at(-1), {
    role: "separator",
    text: RESTORED_SEPARATOR,
  });
  assert.equal(s.status, "idle");

  // Drop: a workspace file URI becomes a chip.
  const dropDoc = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "dropped\n",
  });
  await handlers.attachUris([dropDoc.uri.toString()]);
  assert.equal(controller.getState().pendingAttachments.length, 1);
  controller.removeAttachment(0);

  // Attach tip: opening a file: document publishes it as the active file,
  // and its uri goes through attachUris like a drop.
  const tipUri = vscode.Uri.file(
    path.join(os.tmpdir(), `chatbridge-tip-${process.pid}.json`),
  );
  await vscode.workspace.fs.writeFile(tipUri, Buffer.from('{"a":1}\n'));
  const tipDoc = await vscode.workspace.openTextDocument(tipUri);
  await vscode.window.showTextDocument(tipDoc);
  await waitFor(() => bridge.activeFile?.uri === tipUri.toString());
  assert.equal(bridge.activeFile?.name, path.basename(tipUri.fsPath));
  await handlers.attachUris([bridge.activeFile?.uri ?? ""]);
  assert.equal(controller.getState().pendingAttachments.length, 1);
  assert.equal(
    controller.getState().pendingAttachments[0]?.path,
    bridge.activeFile?.path,
  );
  controller.removeAttachment(0);

  // An untitled buffer is not a file: the tip clears.
  const untitled = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "scratch\n",
  });
  await vscode.window.showTextDocument(untitled);
  await waitFor(() => bridge.activeFile === undefined);
  await vscode.workspace.fs.delete(tipUri);

  // Paste: the active editor's selection becomes a selection chip.
  const pasteDoc = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "l1\nl2\nl3\n",
  });
  const editor = await vscode.window.showTextDocument(pasteDoc);
  editor.selection = new vscode.Selection(1, 0, 2, 2);
  assert.equal(handlers.pasted("l2\nl3"), true);
  assert.match(
    controller.getState().pendingAttachments[0]?.path ?? "",
    /:L2-L3$/,
  );
  assert.equal(handlers.pasted("unrelated\ntext"), false);
  controller.removeAttachment(0);

  // Provider commands through a real ChatSession: `show` reads the page,
  // `send` continues as an ordinary turn.
  await handlers.customCommand("title", "", "/title");
  await waitForIdle(controller);
  s = controller.getState();
  assert.deepEqual(s.messages.at(-2), {
    role: "user",
    text: "/title",
    attachments: [],
  });
  assert.deepEqual(s.messages.at(-1), { role: "help", text: "Dummy Chat" });

  await handlers.customCommand("shout", "hello", "/shout hello");
  await waitForIdle(controller);
  s = controller.getState();
  assert.deepEqual(s.messages.at(-2), {
    role: "user",
    text: "/shout hello",
    attachments: [],
  });
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: HELLO/);

  // A URL hook that resolves: its content rides along as an attachment.
  const goodUrl = `${process.env.DUMMY_CHAT_URL ?? "http://localhost:8735"}/login`;
  const hooked = await controller.send(`read ${goodUrl}`);
  assert.deepEqual(hooked, { ok: true });
  await waitForIdle(controller);
  s = controller.getState();
  assert.deepEqual(
    s.messages.at(-2)?.attachments?.map((a) => a.path),
    ["Dummy: /login"],
  );
  assert.equal(s.messages.at(-1)?.role, "assistant");

  // A URL hook that refuses: nothing is sent and the result carries the
  // code the extension uses to put the text back in the composer.
  const badUrl = `${process.env.DUMMY_CHAT_URL ?? "http://localhost:8735"}/nope`;
  const refused = await handlers.send(`look at ${badUrl}`);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "URL_HOOK");
  s = controller.getState();
  assert.equal(s.messages.at(-1)?.role, "error");
  assert.match(s.messages.at(-1)?.text ?? "", /404 from dummy chat/);

  await controller.close();
  assert.equal(controller.getState().status, "closed");
}

/** The queue drains asynchronously after `send` resolves; the dummy server's
 * reply delay is 1.5 s per turn, so poll rather than sleep a fixed amount. */
async function waitForIdle(
  controller: ExtensionApi["controller"],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { status, queue } = controller.getState();
    if (status === "idle" && queue.length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `queue did not drain within 10s; status=${controller.getState().status}`,
  );
}

/** `onDidChangeActiveTextEditor` fires asynchronously after
 * `showTextDocument` resolves, so poll the bridge rather than assert at once. */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met within 5s");
}
