# ADR: Inline transcript selection promotion gate

## Decision

**HOLD — keep selection overlay-only.**

The benchmark now exercises actual `TUI.#doRender` frames rather than a copied-array microbenchmark. It shows that changing one selected row causes the real renderer to normalize and diff all 100,000 transcript rows. This violates the selection design's fundamental bounded-work requirement. No product inline-selection wiring is approved by this ADR.

## Measured evidence

`packages/tui/test/transcript-selection-perf.test.ts` builds a 100,000-row tree of real `Text` components, attaches it to two `TUI` instances backed by `VirtualTerminal`, and interleaves 12 navigation-equivalent control frames with 12 selected-row-change frames. Each measured frame is requested through `TUI.requestRender()` and flushed through the real render loop. The test obtains `renderTree`, total `#doRender` frame time, and `renderMetrics.snapshot().lineCounts` from that pipeline; it does not write metric values itself.

The rows reserve a two-cell gutter in both arms. The selection arm adds ANSI background/accent only to that gutter. The test explicitly verifies first, previous-selected, selected, and last rows, CJK wrapping through real `Text` and `Markdown` renderers at widths 40 and 120, content byte parity after ANSI stripping and gutter removal, and equal wrapped anchor topology between arms.

### Three recorded local runs — 2026-07-16, Apple M5 Max

| Run | Control renderTree | Selection renderTree | Ratio | Control total frame | Selection total frame | Ratio | Line counts (control → selection: normalized / diffed / offscreenScan) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 49.38 ms | 68.43 ms | 1.386 | 164.44 ms | 905.77 ms | 5.508 | 28 / 28 / 99,972 → 100,000 / 100,000 / 0 |
| 2 | 55.45 ms | 56.55 ms | 1.020 | 132.11 ms | 885.57 ms | 6.703 | 28 / 28 / 99,972 → 100,000 / 100,000 / 0 |
| 3 | 57.33 ms | 61.61 ms | 1.075 | 165.71 ms | 808.96 ms | 4.882 | 28 / 28 / 99,972 → 100,000 / 100,000 / 0 |

The advisory benchmark is enabled with `PI_TUI_PERF_GATES=1` and logs renderTree and total-frame ratios plus all line-count measurements while asserting only the stable parity and measurement-production invariants. The executable promotion evaluation is `PI_TUI_PERF_GATES=1 PI_TUI_PROMOTION_GATE=1 bun --cwd=packages/tui run test:perf`; it hard-fails when renderTree ratio > 1.15, total-frame ratio > 1.15, or selection normalized, diffed, or offscreenScan counts exceed 64. It currently fails by design, so this ADR remains HOLD: the recorded results fail all bounded-work line-count criteria and every total-frame ratio; run 1 also fails the renderTree ratio. The line-count evidence is decisive: a single-row decoration forces full-tree normalization and diffing.

## Required change before reconsidering promotion

A future inline implementation must make a selected-row change diff-friendly and bounded:

1. Preserve the fixed reserved gutter, but memoize row decoration so unchanged rows retain identity/cache entries rather than being re-normalized.
2. Update only the selected and previous-selected rows, with renderer invalidation/diff behavior that does not scan or normalize the whole transcript.
3. Re-run the paired real-TUI benchmark three times with stable margins under all hard limits, including the 64-row line-count bounds, before changing this ADR to PROMOTE.
4. Add product interaction, registry identity, viewport-anchor, and accessibility coverage only after this gate passes.

The existing overlay path remains the supported selection mechanism. CI continues to run the benchmark through `test:perf` and the `tui-perf-gates` lane; no project-wide gate or product UI wiring is introduced here.
