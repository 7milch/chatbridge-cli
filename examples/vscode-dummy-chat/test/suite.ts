import assert from "node:assert/strict";
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
  const { controller, handlers } = api;

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

  // Reopen: the browser is replaced and the history marked.
  await vscode.commands.executeCommand("chatbridge-dummy.reopen");
  s = controller.getState();
  assert.equal(s.status, "idle");
  assert.deepEqual(s.messages.at(-1), { role: "separator", text: "reopened" });

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
  assert.deepEqual(s.messages.filter((m) => m.role === "separator").at(-1), {
    role: "separator",
    text: "reopened",
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
