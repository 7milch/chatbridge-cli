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
  const { controller } = api;

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

  await controller.close();
  assert.equal(controller.getState().status, "closed");
}
