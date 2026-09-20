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
import type { Provider } from "../packages/provider/dist/index.js";
import { AuthStore, BrowserRuntime } from "../packages/runtime/dist/index.js";

const SAMPLE_MS = 10_000;

/** A page that animates forever but honours the media query, which is the
 * behaviour the setting is there to exploit. */
function pageFor(animated: boolean): string {
  const boxes = '<div class="box"></div>'.repeat(200);
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<title>${animated ? "Animated" : "Static"}</title>
<style>
  .box { width: 80px; height: 80px; background: #39c; ${
    animated ? "animation: spin 1s linear infinite;" : ""
  } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .box { animation: none; } }
</style>
${boxes}`)}`;
}

function providerFor(
  chatUrl: string,
  reducedMotion: "reduce" | "no-preference",
): Provider {
  return {
    name: "measure-idle-cpu",
    chatUrl,
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

/** Parses a `ps time=` value (`mm:ss`, `hh:mm:ss`, or `d-hh:mm:ss`) into
 * seconds. */
function parsePsTime(time: string): number | undefined {
  const [dayPart, rest] = time.includes("-")
    ? time.split("-")
    : [undefined, time];
  const parts = (rest ?? "").split(":").map(Number);
  if (parts.length === 0 || parts.some(Number.isNaN)) return undefined;
  let seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
  if (dayPart !== undefined) {
    const days = Number(dayPart);
    if (Number.isNaN(days)) return undefined;
    seconds += days * 86_400;
  }
  return seconds;
}

/** Total CPU seconds consumed so far by every descendant process of `pid`
 * (the browser server this script launched, and its renderer / GPU /
 * utility children), as `ps` reports it. Scoped to the script's own
 * process tree so unrelated Chromium/Playwright sessions elsewhere on the
 * machine are not counted. */
function descendantCpuSeconds(pid: number): number {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,time=,command="], {
    encoding: "utf8",
  });
  const byPid = new Map<number, { ppid: number; time: string }>();
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+/);
    if (!match) continue;
    const [, pidStr, ppidStr, time] = match;
    byPid.set(Number(pidStr), { ppid: Number(ppidStr), time: time ?? "" });
  }

  const childrenOf = new Map<number, number[]>();
  for (const [childPid, { ppid }] of byPid) {
    const list = childrenOf.get(ppid) ?? [];
    list.push(childPid);
    childrenOf.set(ppid, list);
  }

  let total = 0;
  const stack = [...(childrenOf.get(pid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const entry = byPid.get(current);
    if (entry) {
      const seconds = parsePsTime(entry.time);
      if (seconds !== undefined) total += seconds;
    }
    stack.push(...(childrenOf.get(current) ?? []));
  }
  return total;
}

async function measure(
  chatUrl: string,
  reducedMotion: "reduce" | "no-preference",
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-cpu-"));
  const authStore = new AuthStore({
    configDir: "chatbridge",
    providerName: "measure-idle-cpu",
    baseDir: dir,
  });
  const provider = providerFor(chatUrl, reducedMotion);
  const rt = await BrowserRuntime.launch({
    headless: true,
    provider,
    authStore,
  });
  try {
    await rt.page.goto(provider.chatUrl);
    // Let the page settle so the first paint is not part of the sample.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const before = descendantCpuSeconds(process.pid);
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    const after = descendantCpuSeconds(process.pid);
    return after - before;
  } finally {
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases: Array<[string, string, "reduce" | "no-preference"]> = [
  ["no-preference (animated)", pageFor(true), "no-preference"],
  ["reduce (animated)", pageFor(true), "reduce"],
  ["no-preference (static, control)", pageFor(false), "no-preference"],
];

const results: Array<[string, number]> = [];
for (const [label, chatUrl, reducedMotion] of cases) {
  const seconds = await measure(chatUrl, reducedMotion);
  results.push([label, seconds]);
}
console.log(
  `sample: ${SAMPLE_MS / 1000} s idle, scoped to this script's own browser process tree`,
);
for (const [label, seconds] of results) {
  const percent = (seconds / (SAMPLE_MS / 1000)) * 100;
  console.log(
    `${label.padEnd(32)} ${seconds.toFixed(2)} CPU s  (${percent.toFixed(1)}% of one core)`,
  );
}
