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

---

# Token / Context-Window Efficiency Audit

Read-only architect audit of token/context efficiency: prompt assembly, tool-result payloads, history management, subagent forking, and token accounting. 13 evidence-backed findings; no files modified.

Scope examined: packages/agent (agent-loop, append-only-context, compaction/, pruning, run-collector), packages/coding-agent (system-prompt, sdk, agent-session, messages, task/*, tools/output-meta, bash-executor, file-mentions, settings-schema, prompts/), packages/orchestration-token-benchmark, packages/stats, docs/ttsr-injection-lifecycle.md.

## Top 5 Prioritized

1. **Finding 2** — System prompt embeds current date + mtime-sorted workspace tree mid-prefix → daily full prompt-cache bust and near-zero cross-session prefix reuse. Fix: relocate volatile facts behind the cache breakpoint. Low risk, highest recurring cost.
2. **Finding 6** — TaskTokenLog "Phase 0 instrumentation" has zero producers; benchmark runs on hand-authored fixtures only. Everything else is unmeasurable without this. Fix: persist per-turn Usage as TaskTokenLog entries; implement live-runner `--fixture` mode.
3. **Finding 1** — forkContext seed budgets (receipt=64/last-turn=250/bounded=250 tokens) contradict advisory estimates (2000/4000/8000) by 8–32x; receipt/bounded seeds routinely empty while paying full-history transform cost. Fix: unify budget tables; raise budgets or truncate the newest message instead of returning empty.
4. **Finding 3** — goal-mode-context re-injected every prompt with live counters; prior copies never pruned (~300 tokens × turns of dead weight). Fix: inject static instructions once; supersede prior injections in-place.
5. **Finding 8** — Intent tracing `_i` REQUIRED in every tool schema → mandatory output tokens per tool call. Fix: default to optional; force omit for UI-less subagent sessions.

## Findings

### 1. forkContext: seed budgets contradict advisory estimates by 8–32x; receipt/bounded modes near-empty — P1
`packages/coding-agent/src/task/index.ts:292-317`

`resolveForkSeedParamsForMode` caps `receipt` at 64 tokens, `last-turn` at 250, and `bounded` at 250 tokens (task/index.ts:305-311), while the advisory shown on receipts (`CLONE_BUDGET_BY_MODE`, fork-context-advisory.ts:15-21) advertises receipt≈2000, last-turn≈4000, bounded≈8000. `estimatedClonedTokens` on every task receipt is therefore up to 32x off, and ROI/clonedTokens reconciliation is computed against fiction.

Worse, `buildForkContextSeed` walks newest→oldest and **breaks at the first message that overflows the budget** (agent-session.ts:1582-1585 — the deliberate contiguity fix). With a 64- or 250-token budget, virtually any real message exceeds it, so `receipt`/`last-turn`/`bounded` seeds routinely come back with `includedMessages: 0`. A caller who paid the seed-build cost (full `#transformContext` + `convertToLlm` + provider normalization over the whole history, agent-session.ts:1517-1521) receives zero context.

**Suggestion:** unify the two budget tables into one shared constant; raise receipt/last-turn/bounded to values that can hold a message (e.g. 2000/4000/8000); or include a truncated text rendition for over-budget newest messages. Skip the expensive full-history transform when the mode budget is ≤ a couple hundred tokens.

### 2. prompt-cache: system prompt embeds current date → full-prefix cache bust at midnight; mtime-sorted tree kills cross-session reuse — P1
`packages/coding-agent/src/prompts/system/project-prompt.md:25-36`

`buildSystemPrompt` injects `Today is {{date}}` into the project prompt body (project-prompt.md:36), and `#computeAppliedToolSignature` appends the calendar date to the rebuild signature (agent-session.ts:4222-4223) so a date change forces a rebuild. Because the date sits mid-prefix (before `<critical>` and `{{appendPrompt}}`), any date rollover invalidates the entire provider prompt-cache prefix — tens of KB (system-prompt.md alone is 20.1KB, plus tool descriptions ~100KB of .md sources).

The same file embeds the mtime-sorted workspace tree (project-prompt.md:27-33). Any file touched between sessions changes the rendered tree, so two sessions in the same repo on the same day rarely share a prefix, and `refreshBaseSystemPrompt` calls re-render it mid-session.

**Suggestion:** move volatile facts (date, workspace tree) out of the stable system blocks — into a trailing low-priority system block after the cache breakpoint, or a per-turn user-role context message. The `prefix-stability` benchmark (prefix-stability.ts:69-77) is designed to catch exactly this violation — but nothing feeds real turns into it.

### 3. history: goal-mode context re-injected verbatim every prompt with live counters, never pruned — P1
`packages/coding-agent/src/session/agent-session.ts:5096-5099`

When goal mode is active, `#promptWithMessage` pushes a fresh `goal-mode-context` custom message on every prompt (agent-session.ts:5096-5099 → `#buildGoalModeMessage` at 4829-4840). The template (prompts/goals/goal-mode-active.md) is ~230 words and contains `Tokens used: {{tokensUsed}}` / `Time used: {{timeUsedSeconds}}` — values that change every turn, so consecutive injections are never byte-identical and can't dedupe or cache.

Two compounding costs: (1) every prior turn's goal-context message stays in history — a 50-turn goal session carries ~50 near-duplicate ~300-token blocks (~15k tokens) of stale counters; pruning only targets toolResult/tool-argument entries (pruning.ts:444, 530), not repeated custom injections. Plan-mode context (agent-session.ts:4819-4827) has the same shape. (2) even the newest injection differs from the previous turn's, contributing fresh uncached input tokens each turn.

**Suggestion:** inject static goal instructions once (or into the system prompt tail); carry only volatile counters — or drop counters and let the model call `goal({op:"get"})`. Alternatively supersede prior `goal-mode-context` messages on each new injection so only the latest survives.

### 4. tool-results: `read` tool exempt from artifact spill — up to 50KB×N ranges enter context with no artifact escape hatch — P2
`packages/coding-agent/src/tools/output-meta.ts:592-600`

`spillLargeResultToArtifact` explicitly skips the read tool (`if (toolName === "read") return result;`, output-meta.ts:599). Read has its own head-truncation (DEFAULT_MAX_BYTES = 50KB, streaming-output.ts:22-23), but: (1) the per-range byte budget scales up: `maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLines * 512)` (read.ts:1013, 1723) — a `:1-3000` selector authorizes ~1.5MB per range, and multi-range selectors multiply that with no combined cap; (2) an oversized read result has no `artifact://` reference and the configured spill threshold silently doesn't apply to the most-used tool; (3) re-reads are only reclaimed by staleness pruning which runs only past the compaction threshold.

**Suggestion:** apply the centralized spill to read results above a higher threshold (e.g. 2× normal) with head-retention semantics, or cap combined multi-range output. At minimum enforce a total byte cap across ranges in one call.

### 5. prompt-assembly: file mentions inline whole files (up to 50KB) into history with duplicate-read blindness — P2
`packages/coding-agent/src/session/messages.ts:367-386`

`@filepath` mentions are auto-read and inlined into a `fileMention` message wrapped in `<system-reminder><file>` (messages.ts:367-386). `buildTextOutput` uses `truncateHead` with the 50KB/3000-line default (file-mentions.ts:162-193), so a single mention can add ~12.5k tokens, stacking additively per prompt. No cross-check against files already in context: re-mentioning duplicates the full body. Compaction-era pruning does not reclaim these: `pruneToolOutputs` only inspects toolResult entries (pruning.ts:530-539), and the staleness index keys on tool calls, so fileMention content is invisible to it.

**Suggestion:** (a) treat fileMention bodies as prunable tool-output-equivalents in the staleness index (keyed on resolved path); (b) lower the mention inline cap below the read-tool cap; (c) when the same path was read in the last N entries, inline only the path + a note.

### 6. accounting: TaskTokenLog "Phase 0 instrumentation" exists but nothing produces it — benchmark starves on fixtures only — P2
`packages/coding-agent/src/task/types.ts:383-415`

`TaskTokenLog` is documented as the durable unit the deterministic orchestration-token benchmark consumes (types.ts:383-415), and the benchmark ships `computeTokenMetrics`/`cacheHitRate`/`assertTokenLogShape`. But zero writers exist: no code constructs or persists TaskTokenLog entries; the only inputs are hand-authored fixtures (fixtures.ts:14-73). Likewise `runOneBinary` expects a binary supporting `--fixture <id>` emitting a schema-v1 JSON report (live-runner.ts:168-180), but no CLI entry point implements it — so the "pr9-live-runner" evidence path that HELD_DEFAULT_REDUCTIONS depends on (default-reductions.ledger.ts:100-135) is unrunnable end-to-end. Real regressions in prompt-cache behavior (e.g. the date-in-prompt bust) are invisible; the held default reductions are permanently blocked on evidence that can't be produced.

**Suggestion:** wire per-turn `Usage` (already in run-collector `ChatRecord`, run-collector.ts:26-40) into persisted TaskTokenLog entries; add the `--fixture` report mode to the CLI.

### 7. compaction: chars/4 heuristic drives triggers and cut points; keepRecentTokens correction is one-directional — P2
`packages/agent/src/compaction/compaction.ts:1002-1010`

All compaction decisions run on `estimateMessageTokensHeuristic` — flat chars/4 with a fixed 1200-token image charge (compaction.ts:314-336). Two consequences: (1) `prepareCompaction` corrects `keepRecentTokens` by ratio promptTokens/estimatedTokens (compaction.ts:1002-1010) — but only when ratio > 1. When the heuristic *overestimates* (code-heavy content tokenizes below 4 chars/token), the keep-window is too small in real-token terms, so compaction cuts more history than the configured 20k `keepRecentTokens` intended — silently losing context, forcing re-reads. (2) `#checkEstimatedContextBeforePrompt` triggers threshold compaction purely off the heuristic (agent-session.ts:7201-7215), so systematic overestimate triggers early compactions — each a paid summarization + a permanent provider cache-prefix reset.

**Suggestion:** apply the ratio correction bidirectionally (clamp to [0.5, 2]); track a per-session observed bytes-per-token ratio from real `Usage` and feed it into `HEURISTIC_BYTES_PER_TOKEN`.

### 8. prompt-assembly: intent-tracing `_i` injected as REQUIRED into every tool schema — per-call output-token overhead on by default — P2
`packages/agent/src/agent-loop.ts:346-403`

`tools.intentTracing` defaults to true (settings-schema.ts:2415-2417). `normalizeTools` injects `_i: {type:"string"}` into every tool's wire schema and adds it to `required` (agent-loop.ts:346-398). Cost: (1) schema bytes: +~15-20 tokens per tool × ~15-40 tools per request; (2) output tokens: `_i` is required and ordered first, so the model must generate an intent string for **every tool call** — uncached output tokens, the most expensive class, thousands of pure-overhead tokens in tool-heavy sessions; (3) echo cost: the `_i` value is re-sent as input in every subsequent turn's history. Intents feed UI status lines/telemetry, not model behavior.

**Suggestion:** default `resolveIntentMode` to "optional" or gate on `hasUI`; subagents (`hasUI: false`, executor.ts:1300) have no user watching and are the heaviest tool users — at minimum disable intent tracing for subagent sessions.

### 9. subagents: parent receipts good, but each child re-pays a full ~20KB+ system prompt as cold uncached input — P2
`packages/coding-agent/src/task/executor.ts:1259-1315`

The receipt architecture is token-frugal on the parent side: `sanitizeTaskToolDetails` returns only receipts with preview + `agent://` outputRef (receipt.ts:102-120, 282-293), banned raw keys asserted (receipt.ts:55-74). The child side leaks: every subagent spins a full `createAgentSession` with its own `rebuildSystemPrompt` (executor.ts:1259-1315) — the base system prompt (20.1KB template + workspace tree + context files + inventories) is billed as fresh uncached input per child; the subagent template wraps rather than replaces it (executor.ts:1293-1296). With default `task.maxConcurrency` 8, one large batch pays ~8× the prefix cost, and each child's `cacheIdentity` defaults to its own session id (sdk.ts:962), so children can't share the parent's provider cache even with heavily overlapping prefix bytes.

**Suggestion:** give role-agent children a purpose-trimmed system prompt (no workflow-surface/routing/soul blocks); reuse a shared cacheIdentity for same-batch children with identical toolsets; measure with the (currently unwired) TaskTokenLog cacheWrite/cacheRead per child.

### 10. history: TTSR "keep" contextMode double-pays violating output; injections accumulate un-pruned; ttsr.enabled unenforced — P3
`docs/ttsr-injection-lifecycle.md` §4 + `packages/coding-agent/src/session/agent-session.ts:2005-2010`

`ttsr.contextMode: "keep"` leaves the aborted rule-violating partial assistant message in context and then appends the `<system-interrupt>` injection — paying for the bad output twice plus the retry regeneration. Independent of mode, hidden `ttsr-injection` custom messages accumulate: they persist as custom entries converted to user messages (messages.ts:330-341), outside pruning's reach. With `repeatMode: "after-gap"` (repeatGap 10, settings-schema.ts:1693-1695) the same rule can re-inject every ~10 turns while all prior copies remain. Also, `TtsrSettings.enabled` is loaded but never checked in runtime gating (doc "Setting caveat").

**Suggestion:** on re-injection of the same rule, supersede the previous injection message; honor `ttsr.enabled` in `checkDelta` gating; document the token cost of `contextMode: "keep"`.

### 11. prompt-assembly: append-only stable-prefix manager only auto-enabled for DeepSeek — P2
`packages/coding-agent/src/sdk.ts:625-635`

`AppendOnlyContextManager` — the harness's strongest cache-friendliness mechanism (fingerprinted systemPrompt+tools snapshot, byte-stable append-only provider message log, append-only-context.ts:26-128, 388-396) — is enabled in "auto" mode **only for `provider === "deepseek"`** (sdk.ts:625-635). All other providers rebuild `llmContext` each turn (agent-loop.ts:720-729); any incidental mutation silently busts implicit provider caches with no detection. The comment on `#lastAppliedToolSignature` (agent-session.ts:1081-1085) confirms MCP-reconnect prompt rebuilds were "the dominant cause of prompt-cache invalidation in long sessions."

**Suggestion:** default `provider.appendOnlyContext` on for all providers with prompt caching — the manager already handles compaction shrink and in-place rewrite detection (append-only-context.ts:236-262); or at minimum log fingerprint changes per session as prefix-stability instrumentation.

### 12. tool-results: spill threshold (50KB) far exceeds retained tail (20KB); head-retention off by default — P3
`packages/coding-agent/src/config/settings-schema.ts:525-560`

The truncation stack is generally good (native shell minimizer with lossless artifact splice, bash-executor.ts:333-350; OutputSink head/tail with artifact mirroring; centralized `spillLargeResultToArtifact`). Remaining gaps: (1) threshold/tail mismatch: spill threshold 50KB vs retained tailBytes=20KB — a 49KB output (~12k tokens) enters context whole with no artifact, while a 51KB output shrinks to ~5k tokens; the 20–50KB band is common for search/gh/lsp results. (2) `truncateMiddle` head retention (`tools.artifactHeadBytes`) defaults to 0 → tail-only, yet for compiler/test output the head (error summary) is the valuable half. (3) skip condition trusts `details.meta.truncation.artifactId` presence only (output-meta.ts:603-604) — fragile if a tool sets partial meta.

**Suggestion:** lower default `tools.artifactSpillThreshold` to ~25KB, default `artifactHeadBytes` to 2.5KB, add a byte-size assertion on final tool-result text in wrappedExecute as a backstop.

### 13. compaction: pruning gated behind compaction threshold — stale tool outputs ride at full cost for most of the session — P2
`packages/coding-agent/src/session/agent-session.ts:7113-7123`

The staleness-aware pruner is well designed (digest notices, 40k protect-window, 20k min-savings hysteresis, pruning.ts:1-37, 102-116) but only runs from `#pruneToolOutputs`, gated behind `shouldCompact(...)` (agent-session.ts:7115-7123, 7205-7215). The rationale is the cache-epoch invariant (rewriting sent history busts the provider prefix mid-epoch) — correct for cached input, but the trade is unmeasured: at ~10% cache-read rates, a stale 15k-token file read still costs ~1.5k token-equivalents per turn, every turn. On big-window models (200k–1M) the compaction threshold may never be crossed, so dead tool outputs are re-billed dozens of times.

**Suggestion:** add an intermediate maintenance boundary — prune when estimated stale-prunable savings exceed a threshold (say 30k tokens) even below the compaction trigger, accepting one deliberate, sanctioned cache-epoch reset; compare (cache-read rate × expected remaining turns × stale tokens) against the one-time cache-write cost.

## Positives Noted

- Receipt-only task details with banned raw-key assertion (receipt.ts) — strong anti-leak pattern
- Native shell minimizer + lossless artifact:// splice (bash-executor.ts:333-350)
- Rebuild-skip tool signature covering MCP reconnects (agent-session.ts:4152-4223)
- Staleness-aware pruning design with digest notices and protect-window hysteresis (pruning.ts)
- Emergency compaction floors (heap/providerBytes/imageBytes/messageCount) prevent OOM-by-context
- Default-reduction gate requiring benchmark + human evidence before shrinking defaults

---

# Binary Size & Memory Footprint Audit

Read-only architect audit of distributable/binary size and runtime memory footprint. 12 evidence-backed findings; no files modified, no builds run.

Pipeline overview: `bun build --compile` via `scripts/ci-release-build-binaries.ts` (release) and `packages/coding-agent/scripts/build-binary.ts` (dev); embeds native .node via embed-native.ts file-type imports, stats dashboard tar.gz, worker entrypoints, telegram daemon CLI; only mupdf is `--external`.

## Top 5 Prioritized

1. **HIGH / small effort** — Add `--minify` to release binary builds. Dev build documents 302MB→114MB startup RSS win from `--minify`; release pipeline omits it entirely. `scripts/ci-release-build-binaries.ts:152-181`
2. **HIGH / medium effort** — Stop embedding both modern+baseline native addons in x64 binaries; only one is ever loaded. `packages/natives/scripts/embed-native.ts:61-96`
3. **HIGH / small effort** — Introduce a stripped `dist` Rust profile for shipped addons. Shipped .node files use `[profile.ci]` with strip=none + line tables + thin LTO; the tuned `[profile.release]` is never used for distribution. 20–40% addon shrink plausible. `Cargo.toml:25-36`
4. **MED-HIGH / medium effort** — Lazy-resolve session image blobs instead of materializing all history base64 on resume; images can be pinned 3x. `packages/coding-agent/src/session/session-manager.ts:1002-1028`
5. **MEDIUM / medium effort** — Defer eager heavy imports (1.6MB models.json, 1.1MB docs index, winston/handlebars/xterm/linkedom); fixed ~10-20MB parse-time heap paid by every process including subagent fan-out. `packages/ai/src/models.ts:2`, `packages/coding-agent/src/internal-urls/gjc-protocol.ts:11`, `packages/utils/src/logger.ts:13-16`

## Findings

### 1. [Size/Memory] Release binaries built without `--minify` — HIGH, small effort
`scripts/ci-release-build-binaries.ts:152-181`

The release pipeline invokes `bun build --compile` with `--keep-names`, `--no-compile-autoload-*`, `--define` — but **no `--minify`**. The dev build (`packages/coding-agent/scripts/build-binary.ts:40-50`) passes `--minify` with an explicit comment: "Minify shrinks the bundled JS the compiled binary must parse at startup (302MB → ~114MB --help RSS measured on darwin-arm64)". Shipped release binaries carry unminified JS: larger distributable AND ~2.5x higher startup RSS.

**Fix:** mirror the dev script's flag set (`--minify --keep-names`), or extract a shared arg list consumed by both scripts so they cannot drift. Re-run `--smoke-test` gates and the issue-1150-repro worker-entry contract test.

### 2. [Size] x64 release binaries embed BOTH modern and baseline native addons (~2x native payload) — HIGH, medium effort
`packages/natives/scripts/embed-native.ts:61-96`

For x64 targets the candidate list is `[modern, baseline]` (:61-67) and **every** available candidate is embedded via `import ... with { type: "file" }` (:92-96). CI downloads both variants (`.github/workflows/ci.yml:425-427`, `merge-multiple: true`; `native_linux` builds both at ci.yml:163-166), so linux-x64/darwin-x64/win32-x64 binaries ship two full copies of the pi-natives cdylib (~28 tree-sitter grammars, syntect, brush, grep, image codecs statically linked; plausibly 20–50MB each under the ci profile). At runtime only one variant is extracted (`loader-state.js` `selectEmbeddedAddonFile()`).

**Fix:** (a) ship baseline-only embedded and stage modern lazily, (b) per-variant binaries, or (c) baseline-only as sole compiled-binary variant. Minimal: filter candidates by `EMBED_VARIANTS=baseline` in the release path.

### 3. [Size] Shipped native addons use `ci` profile (strip=none, line tables, thin LTO) — never the size-tuned `release` profile — HIGH, small effort
`Cargo.toml:25-36`

Root Cargo.toml defines a well-tuned `[profile.release]` (:17-23: opt-level 3, lto="fat", codegen-units=1, strip=true, panic="abort") but it is dead for distribution: `build-native.ts:149-151` selects `local` for dev and `ci` for every CI/cross build, and `[profile.ci]` sets `lto="thin"`, `codegen-units=16`, `debug="line-tables-only"`, **`strip="none"`**. The `panic="unwind"` override is genuinely required (pi-natives catch_unwind guard), but strip/debug/lto/codegen-units are not coupled to it.

**Fix:** add a `dist` profile: `inherits = "release"`, `panic = "unwind"`, `strip = true` (or `"debuginfo"`), optionally `lto = "fat"`; have build-native.ts select it for release tags; keep `ci` for test builds.

### 4. [Size/Memory] 1.1 MB docs corpus embedded as a TS module in the eagerly-imported internal-urls barrel — MEDIUM, small/medium effort
`packages/coding-agent/src/internal-urls/gjc-protocol.ts:11`

`generate-docs-index.ts:46-67` inlines the full text of every `docs/**/*.md` (76+ files) into `docs-index.generated.ts` — 1.1 MB of string literals. Statically imported by gjc-protocol.ts:11, re-exported from the barrel (index.ts:13), imported by sdk.ts:85. Cost: +1.1 MB in every compiled binary and npm package, and the whole corpus is parsed into JS heap at startup of every session — including subagent runs that never resolve a `gjc://docs` URL.

**Fix:** (1) lazy `await import("./docs-index.generated")` inside the resolve handler; (2) better: emit docs as embedded assets or a gzipped archive (like packages/stats' `embedded-client.generated.txt` pattern), decompressed on demand — markdown compresses ~4x.

### 5. [Size] Docker runtime base ships full build toolchain; `COPY . /pi/` includes 11.5 MB of brand PNGs — MEDIUM, small effort
`Dockerfile:117-138`

(1) pi-base stage installs `build-essential pkg-config libssl-dev` (~250MB) + rustup launcher into the *runtime* image, even though pi-natives is compiled in a separate `natives-builder` stage and copied prebuilt (:138). (2) `Dockerfile.dockerignore` does NOT exclude `assets/` (7 PNGs, ~11.5MB — README-only brand assets; nothing under packages/ references them), nor `docs/`, `issues/`, `geobench/`, `.plans/`.

**Fix:** add `assets/`, `issues/`, `.plans/`, `geobench/` to Dockerfile.dockerignore; move toolchain out of pi-base into a `pi-dev` target or behind a build ARG.

### 6. [Size] pi-natives statically links 28 always-on tree-sitter grammars + unused syntect default-themes — MEDIUM
`Cargo.toml:286-290`

(1) `crates/pi-ast/Cargo.toml:20-77` marks ~37 grammars optional behind `full-langs`, but 28 are unconditional (cpp and typescript are each multi-MB of static tables). The embed guard already enforces `languageSet: "default"` — the default tier is just wide. (2) syntect `default-themes` feature is dead weight: highlight.rs never loads a `ThemeSet` — theme colors are passed in from TS as ANSI strings (highlight.rs:132-135); zero uses of ThemeSet workspace-wide. ~0.5MB serialized theme dump is baggage; only `default-syntaxes` + `regex-fancy` are needed. (3) `inferno` (flamegraph SVGs, prof.rs:200) ships in the production addon for a dev-profiling feature.

**Fix:** drop `default-themes` (small); audit the default grammar tier and feature-flag inferno (medium).

### 7. [Memory] Session resume materializes every historical image blob into inline base64 heap strings for session lifetime — MED-HIGH, medium effort
`packages/coding-agent/src/session/session-manager.ts:1002-1028`

`resolveBlobRefsInEntries` rehydrates **all** blob refs in **all** loaded entries back into inline base64 on load (:1019; plus `resolvePersistedBlobRefs` at :959-980). Concurrency is bounded (BLOB_RESOLVE_CONCURRENCY=8) but *retained* footprint is not: after resume, every image in history lives in heap as base64 (≈1.37x binary size) even if behind a compaction summary. The blob store's externalization is undone at load. The emergency `imageBytes` floor (64MiB, compaction.ts:270) only counts provider-visible messages; the MemoryBlobStore LRU governs a different store — a resumed image-heavy session can pin hundreds of MB indefinitely.

**Fix:** resolve blob refs lazily — keep `blob:sha256:` refs in loaded entries and materialize only in provider-visible context building and display rendering (the resident-blob sentinel system already demonstrates the lazy pattern for text). Or restrict eager resolution to active-branch entries ahead of the latest compaction.

### 8. [Memory] TUI chatContainer grows unboundedly; Image components retain base64 + rendered escape sequences — MEDIUM, medium effort
`packages/coding-agent/src/modes/interactive-mode.ts:418`

One flat `chatContainer` only ever grows within a conversation (addChild sites: event-controller.ts:437,552,846; ui-helpers.ts:81-243); nothing evicts scrolled-off components until whole-session `clear()`. (1) `packages/tui/src/components/image.ts:21,37` stores `#base64Data` for component lifetime plus `#cachedLines` with the kitty/sixel escape sequence — combined with finding 7, each screenshot exists ≥3x in heap. (2) Each Text/Markdown/Box caches `#cachedLines`, so TUI heap is O(total conversation render output), not O(viewport). The 1.5GiB emergency heap floor is very high for weak hardware.

**Fix:** virtualize or cap chatContainer children beyond N components (collapsed placeholder); null out `Image#base64Data` after first successful protocol render (re-fetchable from blob store).

### 9. [Size] npm package ships generated 1.1MB docs index, duplicated HTML template, vendored minified JS, vendored Python engine tests — LOW/MEDIUM, small effort
`packages/coding-agent/package.json:83-91`

`files` publishes `src`, `scripts`, `examples`, `vendor` wholesale: `docs-index.generated.ts` (1.1MB), `template.generated.ts` (112KB inlined duplicate of template.html/js/css which are *also* shipped), `vendor/highlight.min.js` (118.9KB) + `marked.min.js` (38.1KB), and `vendor/insane-search/**` including Python test files.

**Fix:** negation patterns in `files` or .npmignore for `vendor/insane-search/engine/tests`; reconsider publishing `scripts`/`examples`.

### 10. [Memory] Eagerly-imported heavy TS deps (winston, handlebars, xterm-headless, linkedom) inflate baseline RSS of every process — MEDIUM, medium effort
`packages/utils/src/logger.ts:13-16`

- logger.ts:14-15 — winston + winston-daily-rotate-file imported statically; rotating-file logger constructed at module load. `@gajae-code/utils` is imported by every package — universal cost before a single log line.
- prompt.ts:1-2 — handlebars (full compiler, ~1MB parsed) statically imported in the same universal package.
- bash-interactive.ts:15 — `@xterm/headless` (full terminal emulator) at module scope even when interactive bash never runs.
- fetch.ts:8 + 6 scrapers — linkedom statically imported even when fetch/browser tools are never invoked.

Together O(10MB) baseline RSS per gjc process, multiplied by subagent/team fan-out. In compiled binaries all get bundled (only mupdf is `--external`). The lazy pattern is already proven in-repo (puppeteer-core, markit-ai, turndown).

**Fix:** lazy `await import()` behind first use; logger transport created on first write; consider replacing winston with a tiny append-only JSONL writer (format is already hand-rolled JSON, logger.ts:27-43).

### 11. [Memory] #streamingEditFileCache holds full file contents per touched path with no size cap — LOW/MEDIUM, small effort
`packages/coding-agent/src/session/agent-session.ts:2970-2979`

`#ensureFileCache` does `readFileSync` and stores the **entire normalized file text** keyed by path — no per-entry cap, no LRU. Cleared at streaming-cycle boundaries (:2859) and per-path on edit completion (:2986), so not a permanent leak, but during a multi-file streaming turn it holds sum(all touched file sizes) unbounded. Contrast the neighboring FileReadCache which is LRU-bounded at 30 paths and stores only line hashes.

**Fix:** skip caching files above a threshold (reuse the existing 8MiB edit/read guard constant), or cap the map at N entries / M bytes with oldest-eviction.

### 12. [Size/Memory] 1.6MB models.json bundled and parsed eagerly at import; ~40 provider modules load statically — MEDIUM, medium effort
`packages/ai/src/models.ts:2`

`import MODELS from "./models.json" with { type: "json" }` — a 1.6MB catalog at module scope. Per-provider Map conversion is lazy (good), but the full parsed JSON object graph materializes at import in every process (JSON graphs inflate 3–6x over source → ~5–10MB retained), plus 1.6MB in every binary/tarball. model-registry layers 20+ Maps on top, often duplicating catalog data. Secondary: auth-storage.ts is 166.5KB, anthropic.ts 103KB; all ~40 providers load via static `register-builtins.ts` even when one provider is used.

**Fix:** lazy loader behind the public API; embed as asset and parse on demand for compiled binaries; defer provider module bodies behind factory thunks.

## Memory Guard Coverage Assessment

**Present and sound:**
- Emergency compaction floors, non-disableable: heap 1.5GiB / providerBytes 24MiB / messageCount 4000 / imageBytes 64MiB (compaction.ts:266-271), red-team tested.
- MemoryBlobStore LRU 64MiB/4096 entries; bounded blob-resume concurrency.
- Output truncation everywhere: 50KB default, 10MB artifact cap, TailBuffer ring.
- TUI render caches bounded to 2x screen lines; markdown LRUs 256/128/512 with 200KB highlight ceiling; token-estimate WeakMap.
- Rust: FS scan cache 16 entries/1s TTL; native highlight 16MiB input cap; prof circular buffer.

**Gaps:**
1. Heap floor (1.5GiB) not scaled to `os.totalmem()` — on a 2GB box it fires at OOM-kill territory. Fix: `min(1.5GiB, 0.5 * os.totalmem())` — small effort.
2. Emergency floors sample only provider-visible messages (agent-session.ts:7155-7177) — TUI component retention, resident blob caches, session-entry copies invisible; only the blunt heapUsed check catches them.
3. pi-natives PTY timeout path leaks one thread per timed-out openpty by design (`std::mem::forget`, pty.rs:497) — documented/bounded, but worth a counter.
