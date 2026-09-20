/** Reproduces the measurement from issue #95: how much CPU an idle,
 * headless Chromium burns on an animated page, with and without
 * `prefers-reduced-motion: reduce`.
 *
 * Not a test — CPU readings are far too machine-dependent for CI. Run it
 * by hand and paste the numbers into
 * docs/spike-notes/2026-09-20-idle-browser-cpu.md:
 *
 *   bun run build && bun scripts/measure-idle-cpu.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@chatbridge/provider";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";

const SAMPLE_MS = 10_000;

/** A page that animates forever but honours the media query, which is the
 * behaviour the setting is there to exploit. */
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<title>Animated</title>
<style>
  .box { width: 80px; height: 80px; background: #39c; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .box { animation: none; } }
</style>
${'<div class="box"></div>'.repeat(200)}`)}`;

function providerFor(reducedMotion: "reduce" | "no-preference"): Provider {
  return {
    name: "measure-idle-cpu",
    chatUrl: PAGE,
    browser: { reducedMotion },
    async navigateToLogin() {},
    async isLoggedIn() {
      return true;
    },
    async startNewChat() {},
    async sendMessage() {},
    async waitForResponse() {
      return "";
    },
  };
}

/** Total CPU seconds consumed so far by every Chromium process of this
 * machine's Playwright browser, as `ps` reports it. */
function chromiumCpuSeconds(): number {
  const out = execFileSync("ps", ["-axo", "time=,command="], {
    encoding: "utf8",
  });
  let total = 0;
  for (const line of out.split("\n")) {
    if (!/chromium|Chromium|headless_shell/.test(line)) continue;
    const time = line.trim().split(/\s+/)[0] ?? "";
    const parts = time.split(":").map(Number);
    if (parts.some(Number.isNaN)) continue;
    // mm:ss.ss or hh:mm:ss
    total += parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  return total;
}

async function measure(
  reducedMotion: "reduce" | "no-preference",
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-cpu-"));
  const authStore = new AuthStore({
    configDir: "chatbridge",
    providerName: "measure-idle-cpu",
    baseDir: dir,
  });
  const provider = providerFor(reducedMotion);
  const rt = await BrowserRuntime.launch({
    headless: true,
    provider,
    authStore,
  });
  try {
    await rt.page.goto(provider.chatUrl);
    // Let the page settle so the first paint is not part of the sample.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const before = chromiumCpuSeconds();
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    const after = chromiumCpuSeconds();
    return after - before;
  } finally {
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const results: Array<[string, number]> = [];
for (const mode of ["no-preference", "reduce"] as const) {
  const seconds = await measure(mode);
  results.push([mode, seconds]);
}
console.log(`sample: ${SAMPLE_MS / 1000} s idle, animated page, headless`);
for (const [mode, seconds] of results) {
  const percent = (seconds / (SAMPLE_MS / 1000)) * 100;
  console.log(
    `${mode.padEnd(14)} ${seconds.toFixed(2)} CPU s  (${percent.toFixed(1)}% of one core)`,
  );
}
