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
against an animated fixture page that honours the media query, lets it
settle for 2 s, then sums the CPU seconds of every Chromium process over a
10 s idle sample.

- Machine: MacBook Air (Mac16,12), Apple M4, 24 GB RAM, macOS 26.5.2 (build 25F84), arm64
- Bun: 1.4.0
- Playwright: 1.63.0 (`packages/runtime`), Chromium build 1243
- Command: `bun run build && bun scripts/measure-idle-cpu.ts` (run from
  `packages/core`, where the workspace symlinks for `@chatbridge/runtime`
  and `@chatbridge/provider` are hoisted — running it from the repo root
  fails with `Cannot find module '@chatbridge/runtime'` because the root
  `package.json` declares no dependency on either package)

Two runs, back to back:

| `browser.reducedMotion` | CPU s over 10 s idle | % of one core |
|---|---|---|
| `no-preference` (before) — run 1 | 6.26 | 62.6% |
| `reduce` (default now) — run 1 | 5.40 | 54.0% |
| `no-preference` (before) — run 2 | 6.17 | 61.7% |
| `reduce` (default now) — run 2 | 5.18 | 51.8% |

## Conclusion

`reducedMotion: "reduce"` cuts idle CPU by roughly 15% here (~62% down to
~53% of one core), not the near-zero result the issue's animated-page
theory predicts — on this machine most of the sampled CPU is Chromium's
software compositor/GPU-process overhead for a headless page with 200
elements, independent of whether the CSS animation itself is still
running. `reducedMotion` helps but does not by itself get an idle
headless page near 0%, so the 24 h idle close remains the real backstop
for a session left open unattended, and doubly so for a page that ignores
the media query or one that polls.
