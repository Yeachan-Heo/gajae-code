# TUI / Engine Runtime Performance Audit

Read-only architect audit of TUI + engine runtime performance. 13 evidence-backed findings; no files modified.

Severity breakdown: P1 ×5, P2 ×6, P3 ×2.

## Top 5 Prioritized

1. **P1** — Full-transcript normalize/diff every frame; `PI_TUI_VIRTUAL_VIEWPORT` fast path opt-in — `packages/tui/src/tui.ts:1533-1756`
2. **P1** — Streaming markdown re-lexes full accumulated message per delta (O(n²)) — `packages/tui/src/components/markdown.ts:196-300`
3. **P1** — Status line does synchronous git repo walk + full segment rebuild per frame; branch cache checked after the expensive call — `packages/coding-agent/src/modes/components/status-line.ts:325-1016`
4. **P1** — Per-delta structuredClone + JSON.stringify of full tool args in tool-execution `updateArgs` / event-controller `message_update` — `packages/coding-agent/src/modes/controllers/event-controller.ts:375-469`
5. **P1** — RPC mode JSON.stringify's the full accumulated message per token with randomUUID per frame (O(n²) wire serialization) — `packages/coding-agent/src/modes/rpc/rpc-mode.ts:636-641`

## Findings

### 1. perf(tui): streaming text re-parses full markdown per delta (O(n²) over a message) — P1
`packages/tui/src/components/markdown.ts:196-300`

Every `message_update` delta calls `AssistantMessageComponent.updateContent` → `Markdown.setText(trimmed)` which invalidates the per-instance cache (markdown.ts:196-205). On the next frame, `Markdown.render()` runs `replaceTabs` (full-text replaceAll), `Bun.hash` over the whole text (markdown.ts:68-70), and — because the content key changes every token — `markdownParser.lexer(normalizedText)` re-tokenizes the entire accumulated message (markdown.ts:~290-300). Only the code-block highlight step is incrementally cached. For a long assistant message this is O(len) per delta ⇒ O(n²) per stream, executed up to ~60×/s (frame budget 16ms).

**Suggestion:** exploit the append-only property of streaming text — cache lexed tokens for the stable prefix (all blocks except the trailing incomplete one) and re-lex only the tail, or throttle setText-driven re-parse to e.g. 50-100ms while streaming and force a final full parse on message_end.

### 2. perf(tui): default render path normalizes/diffs full transcript every frame; fast path is opt-in — P1
`packages/tui/src/tui.ts:1533-1756`

`#doRender` renders the whole component tree (`this.render(width)`), then `#applyLineResetsAndTruncate` walks EVERY line of the transcript each frame (tui.ts:1565-1570 default branch; helper at tui.ts:1380-1386), and the diff loop scans `maxLines` from 0 (tui.ts:1743-1756). Per-line work is cached (`#lineNormalizationCache`), but the O(total-lines) map lookups + full-array diff run per frame — with streaming + a 16ms budget this is a steady per-frame cost proportional to session length. The mitigation exists (`PI_TUI_VIRTUAL_VIEWPORT`, tui.ts:1540-1563 reuses the previous normalized prefix and starts the diff at the window boundary) but defaults OFF, so real users on long sessions pay the O(n) cost. The prefix-stability check itself is also an O(offscreen) string compare per frame.

**Suggestion:** promote the virtual-viewport path to default after burn-in (metrics hooks already exist), and/or maintain a dirty-line watermark from components instead of comparing every line.

### 3. perf(agent): per-token message spread + per-event listener fan-out on the stream hot path — P2
`packages/agent/src/agent-loop.ts:874-896` + `packages/coding-agent/src/session/agent-session.ts:1745-1786`

Every streamed provider event (text_delta, thinking_delta, toolcall_delta — i.e. per token/chunk) pushes `{ type: "message_update", message: { ...partialMessage } }` (agent-loop.ts:889-893), allocating a shallow message copy per token. Downstream, `AgentSession.#emit` copies the listener array per event (`[...this.#eventListeners]`, agent-session.ts:1745-1750) and `#emitSessionEvent` allocates a `persistRuntimeState` closure per event (agent-session.ts:1777-1786) even though `stateForEvent` returns null for `message_update` (session-state-sidecar.ts:128-136), so the closure + async call is pure overhead per token. `#queueExtensionEvent` also chains a promise per token (agent-session.ts:1766-1773) even when no extensions consume message_update.

**Suggestion:** skip persistRuntimeState/queueExtensionEvent entirely for message_update when no extension subscribes; reuse a stable listeners snapshot invalidated on subscribe/unsubscribe; consider coalescing deltas (flush partial message at most every N ms) before fan-out.

### 4. perf(ui): #handleMessageUpdate walks all content blocks and clones tool args per delta — P1
`packages/coding-agent/src/modes/controllers/event-controller.ts:375-469`

`EventController.#handleMessageUpdate` runs on every streaming delta and: (1) filters the entire content array to count thinking blocks (:380-383); (2) iterates every content block twice — once for tool-call routing (:388-446) and once for intent extraction (:448-467), the latter calling `tool.intent(args)` per delta; (3) for each in-flight tool call spreads args into a new object (`{ ...content.arguments, __partialJson }`, :415-418) and calls `component.updateArgs`, which `structuredClone`s the args (tool-execution.ts:222-223 via cloneToolArgs at :45-51) and re-runs `JSON.stringify(effectiveArgs)` for the coalescing key (tool-execution.ts:258-262). For large streamed args (e.g. a multi-KB edit diff) this is clone+stringify of the whole accumulated args per delta — O(n²) per tool call.

**Suggestion:** key coalescing on `partialJson.length`/delta count instead of stringify of full args; clone lazily (only when the renderer actually mutates); process only the content block indicated by `assistantMessageEvent.contentIndex` instead of the full array.

### 5. perf(ui): AssistantMessageComponent.updateContent rebuilds the child tree per delta — P2
`packages/coding-agent/src/modes/components/assistant-message.ts:216-262`

`updateContent` is invoked per `message_update` and starts with `this.#contentContainer.clear()` (:216-219), then re-allocates Spacer/Text/Markdown wrappers and re-scans all content blocks (`content.some(...)` twice, per-block `slice(i+1).some(...)` look-ahead at :236-239 which is O(blocks²)). The Markdown component instance itself is reused via `#contentBlocksCache` (:156-172), so the expensive highlight work is cached — but every delta still churns the container: `clear()` calls `dispose()` on children including reused cached components' siblings, and new Spacer/Text objects are created each time. This runs at token frequency.

**Suggestion:** diff the desired child list against current children and only mutate when block count/type changes; move the abort/error/usage trailer construction to message_end (it can't appear mid-stream); replace the per-block `slice().some()` look-ahead with a single reverse pre-pass computing "hasVisibleContentAfter" indices.

### 6. perf(ui): status line rebuilds all segments and re-resolves git repo synchronously on every render — P1
`packages/coding-agent/src/modes/components/status-line.ts:325-1016`

`StatusLineComponent.render` has no output cache: each frame calls `#buildStatusRows` → `#collectStatusSegments` → `#buildSegmentContext` (:1002-1016 → 789-850 → 644-693). That per-frame work includes: `#getCurrentBranch()` → `resolveCurrentBranch` → `git.head.resolveSync` which does a synchronous directory walk (`resolveRepositorySync`, git.ts:508-521), sync `readFileSync` of HEAD, and on ref HEADs `readRefSync` reading loose ref + packed-refs files (git.ts:563-575) — sync FS on the render path, per frame, while the loader animates at up to 60fps. It also recomputes `getCachedContextBreakdown` (walks all messages; cached per message but still O(messages) map/fingerprint work, :597-622), `#getTokensPerSecond` (reverse scan of messages, :428-459), `#resolveSettings` (re-merges preset objects, called twice per build), and re-renders every segment with fresh string allocation. Note the "cache" in #getCurrentBranch is ineffective: it calls resolveCurrentBranch (the expensive part) BEFORE consulting the cache (:325-334).

**Suggestion:** cache the rendered status rows keyed by (width, inputs-fingerprint) and invalidate from the existing fs.watch/branch-change/event hooks; at minimum, TTL the branch resolution like git status (1s) instead of per-frame resolveSync.

### 7. perf(tui): Loader ticks a 16ms interval per instance and recomposes theme strings every tick — P2
`packages/tui/src/components/loader.ts:62-104`

Each `Loader` runs `setInterval(..., 16)` (:62-71) calling `#updateDisplay` which recomposes `spinnerColorFn(frame) + messageColorFn(message)` every 16ms (:90-104). The `#lastDisplayed` guard suppresses redundant requestRender for static colorizers, but with shimmer/KITT colorizers (the default working-message accent in interactive mode, interactive-mode.ts:2197-2205) the text changes every tick, so the full TUI render pipeline executes at ~60fps for a one-line spinner. Multiple concurrent loaders (status loader + retry loader + compaction loader + per-tool spinners at tool-execution.ts:373-381, each their own 80ms interval) each independently schedule renders.

**Suggestion:** drop the recompute tick to the spinner cadence (80ms) unless a time-dependent colorizer is registered; share a single animation timer across all animated components; or give the TUI a "partial invalidation" hint so a spinner frame doesn't trigger full-tree render.

### 8. perf(tui): editor render re-segments graphemes and re-measures widths per keystroke without layout caching — P3
`packages/tui/src/components/editor.ts:791-1560`

`Editor.render` (:791-1030) runs on every keystroke (input-priority render). Per call it: re-runs `#layoutText` over ALL logical lines (:1448-1560) — wrap results are cached per line (`#wrappedLineCache`) but layout-line assembly, cursor placement, and `visibleWidth(layoutLine.text)` per visible line (:851) are recomputed; materializes `[...segmenter.segment(...)]` arrays for cursor rendering (:710, 754-756, 936-938); and calls `truncateToWidth`/`visibleWidth` (Rust FFI + Bun.stringWidth) repeatedly for borders/hints. For large pasted buffers each keystroke re-walks every layout line even though only the cursor line changed.

**Suggestion:** cache LayoutLine[] keyed by (docVersion, width, cursorLine/cursorCol) and patch only the cursor line's entries on cursor movement; memoize per-layout-line visibleWidth alongside the wrapped-line cache entries.

### 9. perf(ts↔rust): width/wrap/truncate natives called per line per frame with per-call getDefaultTabWidth + JS↔UTF16 marshalling — P2
`packages/tui/src/utils.ts:36-149` + `crates/pi-natives/src/text.rs:864-1349`

The width-measurement layer crosses the N-API boundary one line at a time: `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, `extractSegments` in utils.ts:36-81 each wrap a single-string Rust call (text.rs:864-1349, each doing `text.into_utf16()` conversion per call). Meanwhile `visibleWidth`/`visibleWidthRaw` is pure TS (utils.ts:119-149) using char-code scans + `Bun.stringWidth` even though the crate exports `visible_width` (text.rs:1345-1349) — measurement logic exists twice and TS-side NFC normalization (`normalizeForWidth`) may disagree with the Rust width used inside truncate/wrap. On hot paths like `#applyLineResetsAndTruncate` (tui.ts:1380-1386) and `#compositeOverlays`, N lines ⇒ N boundary crossings per frame. Each helper also re-reads `getDefaultTabWidth()` per call.

**Suggestion:** add batched natives (e.g. `truncateLinesToWidth(lines[], width)` / `visibleWidths(lines[])`) so a frame's normalization is one FFI call over the array; consolidate on one width implementation; hoist tab width to a module-level cached value invalidated on settings change.

### 10. perf(session): sidecar runtime-state writer does sync read + pretty-print JSON write per state event — P2
`packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts:139-300`

`persistCoordinatorRuntimeStateFromEvent` runs for every session event via `#emitSessionEvent` (agent-session.ts:1777-1786, 1812). For events that map to a state (agent_start/turn_start/agent_end) it calls `readPreviousPayload` which is a **synchronous** `fsSync.readFileSync` + JSON.parse (:139-145) on the event/render path, then writes `JSON.stringify(payload, null, 2)` (:272-276). turn_start fires per agent turn, so during multi-turn tool loops this sync read happens repeatedly while the TUI is animating.

**Suggestion:** make `readPreviousPayload` async (Bun.file().text()) or cache the last-written payload in memory (the process is the only writer), avoiding both the sync read and the re-parse; drop pretty-printing for the hot path.

### 11. perf(session): streaming-edit guards re-run getStreamingEditToolCall + full diff split per toolcall delta — P2
`packages/coding-agent/src/session/agent-session.ts:3019-3063`

For every `message_update` carrying a toolcall event, the session runs the streaming-edit machinery twice per event: once from the assistant-message interceptor (agent-session.ts:1361-1369 → #preCacheStreamingEditFile + #maybeAbortStreamingEdit) and again from `#handleAgentEvent` (agent-session.ts:2056-2069). `#maybeAbortStreamingEdit` (:3019 ff) does per-delta work proportional to the accumulated diff: `diff.replace(/\r/g,"")`, `normalizeDiff`, optional deobfuscate, `split("\n")`, and a `lines.some(...)` scan — all on the FULL diff so far, per delta ⇒ O(n²) per edit tool call. The `#streamingEditCheckedLineCounts` guard only skips when line count hasn't grown, but streaming edits grow nearly every delta.

**Suggestion:** process only the new suffix of the diff (track last-processed offset and check only newly completed removed lines); dedupe the double invocation; short-circuit when the tool call isn't `edit` by caching the per-toolCallId verdict.

### 12. perf(rpc): every message_update is JSON.stringify'd as a full wire frame with randomUUID per token — P1
`packages/coding-agent/src/modes/rpc/rpc-mode.ts:636-641`

In RPC mode, `session.subscribe` forwards EVERY session event — including per-token `message_update`s — through `toAgentWireEventFrame` + `JSON.stringify` + stdout write (rpc-mode.ts:636-641, 289-294). Each `message_update` embeds the FULL accumulated assistant message (agent-loop.ts:889-893), so serialization cost grows with message length per token — O(n²) bytes serialized per streamed message — plus a `randomUUID()` allocation per frame (event-envelope.ts:96 in AgentWireFrameSequencer.next). For a 10k-token response that's ~10k stringify passes of an ever-growing object.

**Suggestion:** for message_update frames, serialize a delta form (event contains `assistantMessageEvent` already — the delta) and let clients reconstruct, or send the full message only every N frames / on message_end; replace randomUUID with a cheap counter-derived frame id (seq already provides ordering/idempotency per session).

### 13. perf(tui): render-loop debug flag checks and appendFileSync inside #doRender — P3
`packages/tui/src/tui.ts:1687-1861`

`#doRender` evaluates `$flag("PI_DEBUG_REDRAW")` per frame (:1687) and both `multiplexerViewportRepaint` (:1666-1670) and the truncation guard in the differential path (:1848-1861) call `fs.appendFileSync` when debugging is enabled — synchronous file I/O inside the frame writer. When the flag is off the cost is repeated env parsing per frame. More importantly, the last-resort truncation guard calls `visibleWidth(line)` on every changed line in the differential loop (:1846) — a Bun.stringWidth pass per changed line per frame on top of the normalization pass that already measured it.

**Suggestion:** cache the debug flag once at TUI construction; carry the measured width from `#normalizeLineForEmit` alongside the cached terminated string so the differential loop can compare against `width` without re-measuring.

## Healthy Areas

- Render scheduler: tick-debounced, 16ms frame budget, input-priority expediting (tui.ts:852-955)
- Markdown highlight cache (per-code-block LRU) and L1/L2 render caches
- Per-message token cache with fingerprint invalidation in status line
- Loader `#lastDisplayed` suppression for static colorizers
- Line normalization/truncation caches bounded to 2x line count
