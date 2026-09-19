# Input-to-write benchmark

Run with the package.json-pinned Bun after `bun run setup:worktree`:

```sh
bun packages/tui/bench/input-write.ts > /tmp/input-write.json
```

The fixture uses the native syntax highlighter, real Editor input dispatch, TUI scheduling/preparations, synchronized terminal writes and xterm validation. Timing starts immediately before `sendInput` and ends after the synchronized write returns, before xterm flush; it is not physical display/keyboard latency. Ten warmups and forty measured inputs run in each scenario. Compare repeated runs on the same machine, fixture hash, complete write hash and final viewport hash; timings are advisory, not CI thresholds.

Contracts are covered by `input-render-latency`, `input-render-redteam`, and `revisioned-subtree-render-cache` tests: pending preparations remain visible in the input frame, forced render wins, revisions/width invalidate caches, and ordinary requests remain conservative.

Do not change a tool spinner to layout-only: tool execution is inside the viewport-anchor transcript, unlike the status loader. Without invalidating that subtree, reuse can hide the changing spinner. This candidate instead targets unconditional per-child placement extraction, repeated editor logical-line layout, and markdown highlight cache work without changing scheduling or dropping presentation work.
