import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

/** @vscode/test-electron 2.5.2 still points at `Contents/MacOS/Electron`,
 * which VSCode renamed to `Code`; fall back to the current name. */
function resolveExecutable(downloaded: string): string {
  if (existsSync(downloaded)) return downloaded;
  const renamed = downloaded.replace(/\/Electron$/, "/Code");
  if (renamed !== downloaded && existsSync(renamed)) return renamed;
  return downloaded;
}

const server = await startDummyChat(0);
const baseDir = mkdtempSync(join(tmpdir(), "cb-vsc-"));
// Short path: VSCode's IPC socket lives under --user-data-dir and macOS caps
// unix socket paths at 104 bytes.
const userDataDir = mkdtempSync(join(tmpdir(), "cb-ud-"));
try {
  // Seed the auth state headlessly; the extension's login command is the
  // same runLogin the CLI uses and is covered by the core E2E.
  const provider = createDummyProvider(server.url);
  const store = new AuthStore({
    configDir: "chatbridge",
    providerName: provider.name,
    baseDir,
  });
  const rt = await BrowserRuntime.launch({
    headless: true,
    provider,
    authStore: store,
  });
  await provider.navigateToLogin(rt.page);
  await rt.page.locator("#login-button").click();
  await rt.page.waitForURL("**/chat");
  await rt.saveAuthState();
  await rt.close();

  const vscodeExecutablePath = resolveExecutable(
    await downloadAndUnzipVSCode(),
  );

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: resolve(import.meta.dirname, ".."),
    extensionTestsPath: resolve(import.meta.dirname, "../dist/test/suite.cjs"),
    launchArgs: [
      "--user-data-dir",
      userDataDir,
      "--disable-extensions",
      "--disable-workspace-trust",
    ],
    extensionTestsEnv: {
      DUMMY_CHAT_URL: server.url,
      CHATBRIDGE_DUMMY_BASE_DIR: baseDir,
    },
  });
} finally {
  server.stop();
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
