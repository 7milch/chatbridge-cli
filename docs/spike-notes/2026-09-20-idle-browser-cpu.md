# Idle browser CPU (milestone 16, issue #95)

A session left open for 2.5 days held one core at ~97%: on macOS headless
Chromium rasterises in software and Playwright disables background
throttling, so a chat page that keeps animating is redrawn for as long as
the session is open. The fix is two-part: ask every context for
`prefers-reduced-motion: reduce`, and close the browser of a session that
has been idle for 24 h.

## Measurement

`scripts/measure-idle-cpu.ts`, run by hand (CPU readings are too
machine-dependent for CI). It launches through `BrowserRuntime.launch()`
against a fixture page with 200 boxes, lets it settle for 2 s, then sums
the CPU seconds accumulated over a 10 s idle sample by every descendant
process of the script's own PID — i.e. only the browser this run launched,
not any other Chromium/Playwright process that happens to be running on
the machine at the same time (the very kind of background load issue #95
is about, so counting it would make the measurement circular).

- Machine: MacBook Air (Mac16,12), Apple M4, 24 GB RAM, macOS 26.5.2 (build 25F84), arm64
- Bun: 1.4.0
- Playwright: 1.63.0 (`packages/runtime`), Chromium build 1243
- Command: `bun run build && bun scripts/measure-idle-cpu.ts`, run from the
  repo root (the script imports `../packages/runtime/dist/index.js` and
  `../packages/provider/dist/index.js` directly, so it no longer depends
  on a workspace symlink being hoisted into a particular package)

Three cases (an animated page with `no-preference` and with `reduce`, plus
a static page with `no-preference` as the floor), two runs back to back:

| Case | CPU s over 10 s idle | % of one core |
|---|---|---|
| `no-preference`, animated (before) — run 1 | 0.96 | 9.6% |
| `reduce`, animated (default now) — run 1 | 0.00 | 0.0% |
| `no-preference`, static (control) — run 1 | 0.00 | 0.0% |
| `no-preference`, animated (before) — run 2 | 0.94 | 9.4% |
| `reduce`, animated (default now) — run 2 | 0.00 | 0.0% |
| `no-preference`, static (control) — run 2 | -0.01 | -0.1% |

(The static-control row's -0.01 in run 2 is not negative CPU usage: the
reading is a difference between two sums over the browser's process tree,
and it goes slightly negative when the tree shrinks between the snapshots —
most likely a short-lived helper process counted in the first one and gone by
the second. The measured cause was not chased down; at -0.1% of one core it
does not change the conclusion.)

## Conclusion

Scoped to the browser this script actually launched, `reducedMotion:
"reduce"` takes the animated page from ~0.95 CPU s (~9.5% of one core)
down to the same ~0 CPU s as the static control — i.e. it removes the
animation's CPU cost entirely on this machine, matching issue #95's own
measurement (0.30 s animated vs 0.00 s with `reduce` and 0.00 s static).
What remains for the 24 h idle close to cover is a page that keeps
animating despite the media query, one that polls the server while idle,
or a provider that opts out with `browser: { reducedMotion:
"no-preference" }`.
