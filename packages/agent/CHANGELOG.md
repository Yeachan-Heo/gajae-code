# Changelog

## [Unreleased]

## [0.11.1] - 2026-07-16

### Fixed

- Hardened the managed fallback attempt snapshot: staged agent events and assistant partials were cloned with a bare `structuredClone`, so a single non-cloneable value in a staged payload (e.g. a live `Headers` inside `transportFailure`) threw `DataCloneError` ("The object can not be cloned."), masked the real provider outcome, and deterministically failed every attempt until the fallback chain exhausted. The snapshot now degrades to a cycle-aware sanitizing deep clone that always returns a detached, JSON-serializable value (unsupported leaves become placeholders), so event-time replay semantics are preserved and no local snapshot failure can masquerade as a provider attempt failure. Byte accounting in the provisional buffer measures the raw event before the snapshot duplicates it (over-limit payloads are rejected pre-clone), re-measures degraded snapshots so the retained sanitized form is what gets accounted, and uses the sanitized detached form as the cycle-safe estimator for cyclic payloads.
- Enforced the managed fallback authority boundary for local staging failures: `ManagedAttemptBufferOverflowError` no longer carries a synthetic provider-like `503` status, so exceeding the provisional event buffer limit (like any other local snapshot failure) is non-retryable, never converts into `transportFailure { kind: "transport", status: 503 }` evidence, and never rotates or consumes the model fallback chain — it surfaces as an explicit local error instead. Only original typed provider transport facts may authorize provider fallback.
- Added a bounded, neutralize-only `invalid_prompt` circuit breaker to the agent loop (#2282). A poisoned-history rejection (`Request blocked (code=invalid_prompt)`) is a deterministic content fault: re-sending the same history re-triggers it, so uncontrolled session auto-retry would burn its budget re-poisoning the model. On the first `invalid_prompt` of a run, leaked reserved control tokens are neutralized in place across history (no item is ever dropped). If that changes the outgoing bytes, the turn is resent exactly once with the repaired history; if neutralization cannot change anything, the run fails fast immediately with no resend. The repaired history is persisted for a clean resume, the breaker fires at most once per run (budget = one repaired resend), and it is scoped to the non-managed session path since managed fallback owns its own retry policy.

## [0.10.2] - 2026-07-14

### Fixed

- Extended the gpt-5.6 `Request blocked (code=invalid_prompt)` fix to the compaction paths that bypass the streaming transport. Remote OpenAI compaction (`/responses/compact`, `compaction.remoteEnabled` default on — the "remote compact task" in openai/codex#32028) built its native `input` from reasoning signatures, verbatim history items, and message/tool text without neutralizing leaked Harmony control-token markers (e.g. `<|channel|>analysis`), so gpt-5.6 rejected the compaction request and, on retry, could escalate to account-level blocking. `requestOpenAiRemoteCompaction` now neutralizes reserved control tokens across the whole outgoing `input`, and the generic `requestRemoteCompaction` prompt/systemPrompt are neutralized too. Local summarization was already covered by the streaming-transport request-boundary fix.

### Changed

- `AgentLoopConfig.maintainContext` now receives a required cancellation-aware lifecycle (`signal`, `awaitEventDrain(invocationSignal)`). Agent loops compose the run and maintenance-invocation signals and pass that single signal to EventStream's FIFO consumer-drain barrier, so cancellation removes the pending drain at its owner instead of racing an orphaned wait.

## [0.10.0] - 2026-07-12

### Fixed

- The native-free token heuristic is now script-aware: common-BMP CJK characters (Hangul, unified/compat Han, Kana, CJK punctuation, full-width forms) are charged at 1 token each (measured o200k_base upper bound 0.96 tokens/char) and supplementary code points (surrogate pairs: rare Han extensions, emoji) at 1 token per code point, instead of chars/4 for everything. The old estimate undercounted Korean/CJK-heavy unsent context by 2–4x and could delay threshold compaction past the provider window; ASCII estimates are unchanged. `boundConversationTextForSummary` now derives its truncation cut from the text's own estimated token density, validates the complete assembled excerpt (elision marker included) against the estimator, and fails closed — bare marker only when the marker itself fits the budget, otherwise an empty excerpt, including when the computed input budget is non-positive — instead of assuming 4 chars/token and returning over-budget or unbounded text.

- A tool call for a name absent from the active tool set now appends a recovery hint pointing at `search_tool_bm25` (gated on a callable `search_tool_bm25`, matched by internal name or `customWireName`), so a model no longer abandons a discoverable tool such as `task` after a bare "Tool <name> not found"; the base error wording stays byte-for-byte stable when discovery is unavailable (#2042).

## [0.9.2] - 2026-07-09

### Fixed

- Follow-up queues can now mark individual messages as one-at-a-time, so interactive composer queues can remain sequential without disabling the existing batch mode for other callers.

## [0.8.2] - 2026-07-06
### Added

- Agent queues now expose ordered move helpers for steering and follow-up messages so callers can reorder pending work without removing and re-adding messages.

### Fixed

- Preserved inherited fork-context seed messages when a compacted child rebase receives only child-local normalized messages, avoiding seed loss after task-child compaction (#1567).

## [0.7.7] - 2026-06-28

### Fixed

- Mitigate leaked Anthropic-style `<invoke name="…">` tool-call envelopes across providers, not only `openai-codex`, while keeping Codex `to=functions.*` harmony-header mitigation provider-scoped.

## [0.7.4] - 2026-06-27

### Added

- Added `pruneAssistantToolArguments`: an isolated pre-compaction pruning pass that redacts stale `edit`/`write`/`apply_patch`/`ast_edit` tool-call argument payloads only when every touched path group has a later successful mutation, preserving tool-call identity (id/name/customWireName/signatures/intent/path hints), protecting latest/failed/ambiguous calls, and reporting separate stats from tool-result pruning. Reduces pre-compaction context pressure and the resident footprint of superseded large edit arguments.

## [0.7.3] - 2026-06-25
### Added

- Added Composer evidence publication gates in the agent loop, so Composer-harness turns emit structured evidence under defined publication conditions (#1106).

### Fixed

- Wired the previously-dead GPT-5 harmony-leak detector into the streamed assistant-message path for openai-codex turns: recoverable tool-argument leaks are now recovered and everything else is routed through the existing abort-retry/audit loop, and the contaminated streamed message is removed (abort-retry) or replaced (truncate-resume) from working context so the model does not replay its own leak as history. Added detection of the leaked Anthropic-style `<invoke name="…">` envelope dialect that gpt-5.5 intermittently emits as visible assistant text instead of a native function call (#1069).
- Detect proxy-level context overflow from empty responses: some proxies (notably LiteLLM) return an empty `content: []` with `stopReason: "stop"` and fabricated near-zero usage when the upstream context window is exceeded; the agent loop now recognizes this pattern and promotes it to an error so the existing overflow/compaction recovery path fires instead of freezing the session as a clean completion (#1102).
- Hardened the Composer trace mutation classifier and its recovery-target guard (#1105).

## [0.7.2] - 2026-06-24

### Fixed

- Reserved headroom when trimming OpenAI remote compaction input so `/responses/compact` requests stay below the model context window instead of filling the entire window.

## [0.6.2] - 2026-06-19

### Changed

- Token accounting no longer depends on a native embedded tokenizer. Token usage now anchors on provider-reported usage (`calculatePromptTokens`) and estimates only the unsent delta with a cheap heuristic (~chars/4 × 1.2); emergency compaction floors are unchanged. Compaction, branch summarization, and fork-seed paths were repointed off the removed native token-estimate alias. Part of dropping the bundled tiktoken/o200k tokenizer (#879).

## [0.5.4] - 2026-06-17

### Fixed

- Maintenance one-shot LLM calls now preserve active provider session state and the configured WebSocket transport preference. `SummaryOptions`, `HandoffOptions`, and `GenerateBranchSummaryOptions` accept `sessionId`, `providerSessionState`, and `preferWebsockets`, and `generateSummary`, `generateShortSummary`, `generateTurnPrefixSummary`, `generateHandoff`, `generateBranchSummary`, and `compact()` forward them through to `completeSimple` — previously these fields were dropped, so Codex/OpenAI-compatible compaction summaries, handoff generation, and branch summaries fell back to HTTP/SSE and lost `session_id` affinity even with `providers.openaiWebsockets: "on"`. Split-turn compaction now runs its history and turn-prefix summaries sequentially when they share a single provider WebSocket session, avoiding `websocket request already in progress`; non-WebSocket sessions still run them in parallel. `Agent` exposes a `preferWebsockets` getter so callers can forward the live transport preference (#736).

## [0.5.3] - 2026-06-16

### Fixed

- Bounded agent context growth, compaction, and token accounting for long-running sessions: `appendMessage` pushes in place instead of rebuilding the array; the append-only context keeps rolling per-message hashes instead of rescanning the full digest; an emergency-compaction floor that cannot be disabled now surfaces its reason; `getSessionStats` is single-pass; and `nativeCountTokens` skips the synchronous ~39 MB BPE tokenizer above a 2 MiB input cap, falling back to the cheap heuristic (#717).

## [0.5.2] - 2026-06-15

### Fixed

- Fixed compaction token estimation in Bun standalone binaries by loading the native tokenizer through the sibling native entrypoint instead of package-name dynamic resolution.

## [0.5.1] - 2026-06-14

- Version aligned with the 0.5.1 monorepo release; no functional changes in this package.

## [0.5.0] - 2026-06-13

### Fixed

- Fixed compaction cut-point selection when the newest retained context ends in an uncuttable tool result, so automatic compaction can keep the latest assistant/tool-result pair instead of falling back to a no-op cut.

### Changed

- Optimization Suite v3 Lane 2 (context cost): compaction token estimates now use a shared per-entry cache (`estimateEntryTokens`) keyed by a boundary-lossless fingerprint of the exact estimator fragments, covering `estimateEntriesTokens`, the `findCutPoint` reverse walk, and pruning candidate scoring — repeated full-session estimate p95 −97%, token totals exactly equal to fresh estimates and never stale after prune mutation. Pruned bash/search/grep tool results now carry a one-line digest notice (exit code, match/file count, first error line; capped at 1.25× the generic notice cost) instead of a bare truncation notice, with savings computed from the exact notice string; reads and other tools keep the generic notice. `trimOpenAiCompactInput` is O(n) via per-item serialized lengths and a running character sum (5k-item trim −99.9%) and is now exported.
- Optimization Suite v3 Lane 3 (serialization): `cloneJson` in the append-only context now uses a typed JSON-semantic recursive clone instead of a `JSON.parse(JSON.stringify())` round-trip (−36% median on clone-heavy paths), with exact JSON.stringify byte parity including the toJSON holder-key protocol (single get, no re-dispatch on replacement values), function/symbol dropping, sparse arrays, Dates, and prototype-bearing objects; the helper is now exported.

## [0.4.5] - 2026-06-12

### Changed

- Made tool-output pruning staleness-aware: results superseded by a later same-target result (re-read file, re-run search) or invalidated by a later successful edit/write are pruned before merely-old ones, including inside the recency protect window. New optional `PruneConfig.staleOverridableTools` (default `["read"]`) waives protected-tool immunity for superseded results while the most recent result per target stays protected. Target identity uses collision-proof canonical JSON tuple keys.
- `PruneResult` now returns `prunedEntries` so callers whose entry source materializes copies (e.g. blob-externalized session entries) can write mutations back into their canonical store.

### Fixed

- Preserved Cursor-native tool call rendering and execution through the agent tool-call path, including runtime tool details.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.

## [0.4.3] - 2026-06-10

### Fixed

- Separated a model's total context window from its safe input/prompt-packing budget in the compaction threshold. `effectiveReserveTokens`, `resolveThresholdTokens`, and `shouldCompact` now accept an optional `maxOutputTokens` and reserve at least that completion budget, so a large-output model (e.g. 400K context / 128K max output) caps input near 272K instead of 340K and cannot overflow the total window with reserved output ([#442](https://github.com/Yeachan-Heo/gajae-code/issues/442)).

## [0.4.0] - 2026-06-06

### Changed

- Refreshed agent-core package metadata for the GJC 0.4.0 release.

## [0.3.1] - 2026-06-05

### Fixed

- Moved the env-driven full message content capture warning into agent-core telemetry resolution so direct `@gajae-code/agent-core` consumers receive `full_content_capture_env_active` when `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=full` is used without an explicit `captureMessageContent` override.

### Changed

- Clarified that telemetry `summary` content capture emits bounded real-content snippets in `pi.gen_ai.*` attributes and is not redacted or PII-free.

## [0.2.4] - 2026-06-02

### Added

- Added agent options for provider request and stream retry budgets and thread them through streaming calls.

## [0.2.2] - 2026-05-31

### Changed

- Refreshed agent-core package metadata for the GJC 0.2.2 release.

## [0.2.1] - 2026-05-30

### Changed

- Refreshed agent-core package metadata for the GJC 0.2.1 release.

## [0.2.0] - 2026-05-28

### Changed

- Refreshed agent-core package metadata for the GJC 0.2.0 release.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

## [0.1.1] - 2026-05-28

### Added

- Added `Agent.forceAbort()` so hosts can recover from provider/tool aborts that ignore cooperative cancellation without clearing conversation history.

## [15.3.0] - 2026-05-25
### Fixed

- Fixed `transformContext` receiving the loop config object as the `signal` argument instead of the actual `AbortSignal`, so hooks that check `signal.aborted` or call `signal.addEventListener` now work correctly under abort/timeout conditions
- Fixed `appendOnlyContext` not being re-evaluated after `setModel()` — the mode was decided once at session construction based on the initial model's provider, so switching from/to DeepSeek (or changing `provider.appendOnlyContext`) mid-session produced incorrect mode behavior

## [15.2.3] - 2026-05-22
### Added

- Added `onBeforeYield` hook support so user code can run right before the agent loop checks for follow-up messages

## [15.1.3] - 2026-05-17
### Added

- Added optional `telemetry` support to `generateSummary`, `generateHandoff`, `generateBranchSummary`, and `compact` options so compaction, handoff, and branch summary one-shot LLM calls can emit OpenTelemetry chat telemetry when enabled
- Added shared oneshot telemetry instrumentation for compaction, handoff, and branch summary calls, tagging spans with `pi.gen_ai.oneshot.kind` values such as `compaction_summary`, `compaction_short_summary`, `compaction_turn_prefix`, `handoff`, and `branch_summary`

## [15.1.2] - 2026-05-15
### Added

- Added `responseHeaders` to `ChatUsageEvent` and `ManualChatTelemetryOptions` so telemetry hooks receive captured lowercase upstream response headers for each chat span
- Added automatic gateway/proxy detection from response headers (`litellm`, `helicone`, `portkey`, `openrouter`) and stamped `pi.gen_ai.gateway.*` span attributes for detected routing metadata
- Added exported `detectGatewayFromHeaders` API for header-based gateway detection

## [15.1.0] - 2026-05-15
### Breaking Changes

- Removed the `@gajae-code/agent-core/compaction/handoff` exports from the package surface, including `extractHandoffDocument`, `createHandoffContext`, and `createHandoffFileName`
- Removed legacy telemetry constants from the public enum surface (including `AGGREGATE_ATTR`, `GenAIAttr.System`, and old `gen_ai.*` extension keys such as `gen_ai.request.service_tier`/cost/tool status/handoff fields) and replaced them with `OpenAIAttr`, `PiGenAIAttr`, and `PiGenAIAggregateAttr`

### Added

- Added `generateHandoff(messages, model, apiKey, options)` to `@gajae-code/agent-core/compaction` to generate a handoff document by calling the model directly, using live system/tool context and optional metadata
- Added generation filtering so the returned handoff document now includes only text content blocks from the model output
- Added support for defining `AgentTool` schemas with Zod, with legacy TypeBox schemas still supported when generating tool schemas for model calls
- Added `OpenAIAttr`, `PiGenAIAttr`, and `PiGenAIAggregateAttr` exports so consumers can reference the new `openai.*` and `pi.gen_ai.*` telemetry attribute keys directly
- Added `onChatUsage` to `AgentTelemetryConfig`, an always-fired hook receiving a `ChatUsageEvent` for every chat step that produced usage. The event carries the chat `span`, `agent`, `conversationId`, `stepNumber`, `model`, `provider`, `serviceTier`, `usage`, optional `cost`, and resolved dynamic `attributes` — independent of whether a `costEstimator` is configured.
- Added `agentLoopDetailed(...)` and `agentLoopContinueDetailed(...)` helpers that return the same event stream plus a `detailed()` result with run `telemetry` and `coverage`
- Added `onRunEnd` to `AgentTelemetryConfig` to receive `AgentRunSummary` and `AgentRunCoverage` at the end of each invocation
- Added run-level telemetry and coverage types/helpers (for example `AgentRunSummary`, `AgentRunCoverage`, `aggregateAgentRunSummaries`, and `aggregateAgentRunCoverage`) to package exports
- Added generic telemetry extension hooks for dynamic span attributes, provider/agent-name normalization, per-step cost deltas, warning callbacks, bounded summary content capture, and manual chat telemetry for non-loop model calls.
- Added opt-in OpenTelemetry instrumentation on the agent loop. Pass `telemetry: {}` (or a richer `AgentTelemetryConfig`) on `AgentLoopConfig` / `AgentOptions` / `createAgentSession({ telemetry })` to emit GenAI-semantic-convention spans plus `pi.gen_ai.*` extension attributes:
- `invoke_agent {agent.name}` wraps each `agentLoop` invocation with `gen_ai.operation.name=invoke_agent`, agent identity, conversation id, and `pi.gen_ai.agent.step.count`.
- `chat {model}` per provider call, parented under `invoke_agent`, with OTEL request/response/usage attributes (`gen_ai.request.{model,stream,temperature,top_p,top_k,max_tokens,presence_penalty,stop_sequences}`, `gen_ai.response.{model,id,finish_reasons,time_to_first_chunk}`, `gen_ai.usage.{input_tokens,output_tokens,cache_read.input_tokens,cache_creation.input_tokens,reasoning.output_tokens}`) and project extensions for reasoning effort, tool choice, available tools, usage totals, and cost.
- `execute_tool {tool.name}` per tool call, parented under `invoke_agent`, with `gen_ai.tool.{name,call.id,description,type}` plus the active context so user/MCP/provider spans created inside `tool.execute()` attach as children.
- One-shot `handoff` span available via the public `recordHandoff(...)` helper for agent-to-agent transitions.
- Added `AgentTelemetryConfig` hooks (`onSpanStart`, `onSpanEnd`, `costEstimator`), `agent` identity, `attributes` envelope merged onto every span, `captureMessageContent` toggle (defaults to the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var) emitting OTEL-shaped `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` / `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`, and tracer/tracerName override surfaces.
- Added `Agent#setTelemetry(config)` so consumers can swap or disable instrumentation between invocations.
- Added `@opentelemetry/api` as a runtime dependency; SDK setup (exporters, samplers, processors) remains the host's responsibility per standard OTEL conventions. When no SDK is registered, helpers fall through to no-op spans with zero overhead.
- Added compaction APIs under `@gajae-code/agent-core/compaction`, including context compaction, branch summarization, handoff prompt/context helpers, pruning, token budgeting, prompt templates, and OpenAI `/responses/compact` helpers.

### Changed

- Changed handoff document generation to force `toolChoice: "none"` when calling the model so tool invocation is disabled during generation
- Changed `chat` spans to emit normalized provider identifiers in `gen_ai.provider.name` via OTEL-style values (for example `google` to `gcp.gemini`) instead of the legacy `gen_ai.system` label
- Changed service-tier telemetry to emit `openai.request.service_tier`/`openai.response.service_tier` only when supported by provider via `shouldSendServiceTier`, rather than always using `gen_ai.request.service_tier`
- Changed captured message payloads so full capture now records OTEL-structured message parts with `pi.gen_ai.request.messages`, `pi.gen_ai.system_instructions`, and `gen_ai.output.messages` including assistant `finish_reason`
- Changed the `agent_end` event payload to include optional `telemetry` and `coverage` fields when telemetry is enabled, while keeping the legacy payload shape when disabled
- Changed `invoke_agent` spans to include aggregate `pi.gen_ai.agent.*` attributes for chat/tool counts, latency, usage, cost, errors, and tool coverage

### Fixed

- Fixed intent-field injection for tool schemas defined with Zod by converting them to wire schema before mutation
- Fixed token accounting in `ChatUsageEvent` and usage summaries so `inputTokens` and `totalTokens` now include cached read/write input tokens
- Fixed `execute_tool` span attributes so `pi.gen_ai.tool.status` and `error.type` now reflect run-level tool outcomes (`ok`, `error`, `skipped`, `blocked`, `timeout`, `aborted`) instead of mapping all non-ok cases the same way
- Fixed `onRunEnd` callbacks to be safe and idempotent by invoking them once per run and swallowing thrown callback errors so they cannot fail or duplicate successful runs
- Fixed run telemetry to count interrupted, blocked, or otherwise skipped tool calls so run coverage and tool counters now include those paths
- Fixed chat failure handling so failed chat steps are still represented in run summaries when provider streaming throws before yielding an assistant message
- Fixed double-counting of interrupted tool calls in run summaries: the `runTool` early-return on a queued steering interrupt now defers to the post-batch tail sweep so each call is recorded exactly once
- Fixed `coverage.toolsInvoked` and run-summary tool counters under-reporting tool calls embedded in an aborted/errored assistant message — those calls now record a collector orphan with status `aborted` or `error`
- Fixed `AgentRunSummary.usage.inputTokens` so it now includes `cache_read` and `cache_write` input tokens, matching `ChatUsageEvent.inputTokens`
- Fixed span lifecycle hooks (`onSpanStart`, `onSpanEnd`) so a thrown user callback is caught and surfaced via `onTelemetryWarning` (`on_span_start_failed` / `on_span_end_failed`) instead of leaking and aborting the surrounding span
- Fixed unbounded recursion in summary content capture when a captured value contains a cyclic or deeply nested array — array recursion now respects the same depth cap as plain-object recursion and replaces back-references with `"[Circular]"`

## [15.0.1] - 2026-05-14
### Breaking Changes

- Raised the minimum required Bun version from >=1.3.7 to >=1.3.14

## [14.9.5] - 2026-05-12

### Added

- Added an `isError?: boolean` field on `AgentToolResult` so tools can flag a non-throwing failure (e.g. an aggregator that catches per-entry errors). `coerceToolResult` preserves the flag and the agent loop surfaces it as a tool error on the wire.

## [14.9.3] - 2026-05-10
### Added

- Added `onHarmonyLeak` option on `Agent`/loop config to receive GPT-5 Harmony leak audit callbacks
- Added harmony-leak detection and audit exports to the package index for programmatic leak detection and recovery hooks

### Changed

- Changed OpenAI code provider model runs to detect GPT-5 Harmony protocol leakage during streaming and automatically retry or recover tool calls instead of sending contaminated arguments downstream

### Security

- Hardened tool-call handling against leaked `to=functions.*` protocol tails by truncating or retrying before execution
- Hardened failure handling so repeated GPT-5 Harmony leak mitigation is retried only up to two times before escalating to an explicit error

## [14.9.0] - 2026-05-10
### Added

- Added `Agent#metadata` field forwarded to every API request; callers can set arbitrary provider metadata (e.g. `metadata.user_id`) once and have it applied to all subsequent stream calls without modifying per-call options
- Added `Agent#setMetadataResolver(fn)` for installing a function that resolves request metadata at call time. The `metadata` getter dispatches through the resolver on every read (including the snapshot taken per `prompt()`), so callers reflect mutable external state (e.g. live OAuth account UUID after a token refresh) without manual re-syncs. Plain `agent.metadata = …` continues to set a static value and clears any installed resolver.

### Added

- Added an `onSseEvent` agent option and loop config forwarding path for raw provider SSE diagnostics.

## [14.7.6] - 2026-05-07

### Added

- Added `hideThinkingSummary` option/getter/setter on `Agent` and `AgentLoopConfig`. Forwarded to the underlying stream call so providers can omit reasoning/thinking summaries on demand.
## [14.7.2] - 2026-05-06
### Added

- Added `loadMode` option to `AgentTool` to mark built-in tools as `essential` for initial loading or `discoverable` for search activation
- Added optional `summary` field to `AgentTool` definitions for one-line text used in tool discovery indexes

## [14.7.0] - 2026-05-04
### Breaking Changes

- Changed `Agent` API types so `systemPrompt` is now a list of prompt strings, requiring callers to pass and update system prompts via string arrays

### Changed

- Removed automatic project-context injection into each model call from loop logic

### Removed

- Removed the `projectPrompt` field from agent state/context and the `setProjectPrompt` mutator

## [14.6.2] - 2026-05-03

### Fixed

- Fixed unhandled promise rejection when `getApiKey` or any other async error occurs during `streamAssistantResponse`: agent loop IIFEs now catch and route errors through `EventStream.fail()`, which terminates the `for await` loop and lets `Agent#runLoop`'s catch block create a proper error assistant message instead of crashing

## [14.6.0] - 2026-05-02
### Fixed

- Fixed request cancellation before provider events by emitting an aborted assistant message and ending the stream with `stopReason: "aborted"`

## [14.5.10] - 2026-04-30

### Added

- Added an `onResponse` stream option for observing provider response metadata after response headers arrive.

## [14.2.0] - 2026-04-23

### Changed

- Changed tool dispatch to match model-returned tool calls by either internal tool name or custom wire name, enabling custom OpenAI tool names such as `apply_patch`.

## [14.0.1] - 2026-04-08
### Added

- Added `onAssistantMessageEvent` callback option to inspect assistant streaming events before they are emitted, enabling abort decisions before buffered events continue flowing
- Added `setAssistantMessageEventInterceptor()` method to dynamically set or update the assistant message event interceptor

## [13.13.0] - 2026-03-18

### Added

- Added `startup.checkUpdate` setting, set to `true` by default, can be disabled to skip the update check on agent initialization

## [13.12.7] - 2026-03-16

### Added

- Added overload for `prompt()` method accepting a string input with optional options parameter

### Fixed

- Fixed stale forced toolChoice being passed to provider after tools are refreshed mid-turn

## [13.9.16] - 2026-03-10
### Added

- Added `onPayload` option to `AgentOptions` to inspect or replace provider payloads before they are sent

## [13.9.3] - 2026-03-07

### Added

- Exported `ThinkingLevel` selector constants and types for configuring agent reasoning behavior
- Added `inherit` thinking level option to defer reasoning configuration to higher-level selectors
- Added `serviceTier` option to configure service tier for agent requests

### Changed

- Changed `thinkingLevel` from required string to optional `Effort` type, allowing undefined state
- Updated `setThinkingLevel()` method to accept `Effort | undefined` instead of `ThinkingLevel` string

## [13.4.0] - 2026-03-01
### Added

- Added `getToolChoice` option to dynamically override tool choice per LLM call

## [13.3.8] - 2026-02-28
### Changed

- Changed intent field name from `agent__intent` to `_i` in tool schemas

### Fixed

- Fixed synthetic tool result text formatting so aborted/error tool results no longer emit `Tool execution was aborted.: Request was aborted` style punctuation.
## [13.3.7] - 2026-02-27
### Added

- Added `lenientArgValidation` option to tools to allow graceful handling of argument validation errors by passing raw arguments to execute() instead of returning an error to the LLM

## [13.3.1] - 2026-02-26
### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `AgentOptions` for fine-grained sampling control
- Added getter and setter properties for sampling parameters on the `Agent` class to allow runtime configuration

## [13.1.0] - 2026-02-23

### Changed

- Removed per-tool `agent__intent` field description from injected schema to reduce token usage; intent format is now documented once in the system prompt instead of repeated in every tool definition
## [12.19.0] - 2026-02-22
### Changed

- Updated tool result messages to include error details when tool execution fails

## [12.14.0] - 2026-02-19

### Added

- Added `intentTracing` option to enable intent goal extraction from tool calls, allowing models to specify high-level goals via a required `_intent` field that is automatically injected into tool schemas and stripped from arguments before execution

## [12.11.0] - 2026-02-19

### Added

- Exported `AgentBusyError` exception class for handling concurrent agent operations

### Changed

- Agent now throws `AgentBusyError` instead of generic `Error` when attempting concurrent operations

## [12.8.0] - 2026-02-16

### Added

- Added `transformToolCallArguments` option to `AgentOptions` and `AgentLoopConfig` for transforming tool call arguments before execution (e.g. secret deobfuscation)

## [12.2.0] - 2026-02-13

### Added

- Added `providerSessionState` option to share provider state map for session-scoped transport and session caches
- Added `preferWebsockets` option to hint that websocket transport should be preferred when supported by the provider implementation

## [11.10.0] - 2026-02-10

### Added

- Added `temperature` option to `AgentOptions` to control LLM sampling temperature
- Added `temperature` getter and setter to `Agent` class for runtime configuration

## [11.6.0] - 2026-02-07

### Added

- Added `hasQueuedMessages()` method to check for pending steering/follow-up messages
- Resume queued steering and follow-up messages from `continue()` after auto-compaction

### Changed

- Extracted `dequeueSteeringMessages()` and `dequeueFollowUpMessages()` from inline config callbacks
- Added `skipInitialSteeringPoll` option to `_runLoop()` for correct queue resume ordering

## [11.3.0] - 2026-02-06

### Added

- Added `maxRetryDelayMs` option to AgentOptions to cap server-requested retry delays, allowing higher-level retry logic to handle long waits with user visibility

### Changed

- Updated ThinkingLevel documentation to include support for gpt-5.3 and gpt-5.3-openai-code models with 'xhigh' thinking level

## [11.2.0] - 2026-02-05

### Fixed

- Fixed handling of aborted requests to properly throw abort errors when stream terminates without a terminal event

## [10.5.0] - 2026-02-04

### Added

- Added `concurrency` option to `AgentTool` to control tool scheduling: "shared" (default, runs in parallel) or "exclusive" (runs alone)
- Implemented parallel execution of shared tools within a single agent turn for improved performance

### Changed

- Refactored tool execution to support concurrent scheduling with proper interrupt handling and steering message checks

## [9.2.2] - 2026-01-31

### Added

- Added toolChoice option to AgentPromptOptions for controlling tool selection

## [8.2.0] - 2026-01-24

### Changed

- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json

## [8.0.0] - 2026-01-23

### Added

- Added `nonAbortable` option to tools to ignore abort signals during execution

## [6.8.0] - 2026-01-20

### Changed

- Updated proxy stream processing to use utility function for reading lines

## [6.2.0] - 2026-01-19

### Added

- Enhanced getToolContext to receive tool call batch information including batchId, index, total count, and tool call details

## [5.6.7] - 2026-01-18

### Fixed

- Added proper tool result messages for tool calls that are aborted or error out
- Ensured tool_use/tool_result pairing is maintained when tool execution fails

## [4.6.0] - 2026-01-12

### Changed

- Modified assistant message handling to split messages around tool results for improved readability when using Cursor tools

### Fixed

- Fixed tool result ordering in Cursor mode by buffering results and emitting them at the correct position within assistant messages

## [4.3.0] - 2026-01-11

### Added

- Added `cursorExecHandlers` and `cursorOnToolResult` options for local tool execution with cursor-based streaming
- Added `emitExternalEvent` method to allow external event injection into the agent state

## [4.0.0] - 2026-01-10

### Added

- Added `popLastSteer()` and `popLastFollowUp()` methods to remove and return the last queued message (LIFO) for dequeue operations
- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level
- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`

## [3.33.0] - 2026-01-08

### Fixed

- Ensured aborted assistant responses always include an error message for callers.
- Filtered thinking blocks from Cerebras request context to keep multi-turn prompts compatible.

## [3.21.0] - 2026-01-06

### Changed

- Switched from local `@gajae-code/ai` to upstream `@gajae-code/ai` package

### Added

- Added `sessionId` option for provider caching (e.g., OpenAI code provider session-based prompt caching)
- Added `sessionId` getter/setter on Agent class for runtime session switching

## [3.20.0] - 2026-01-06

### Breaking Changes

- Replaced `queueMessage`/`queueMode` with steering + follow-up queues: use `steer`, `setSteeringMode`, and `getSteeringMode` for mid-run interruptions, and `followUp`, `setFollowUpMode`, and `getFollowUpMode` for post-turn messages
- Agent loop callbacks now use `getSteeringMessages` and `getFollowUpMessages` instead of `getQueuedMessages`

### Added

- Added follow-up message queue support so new user messages can continue a run after the agent would otherwise stop
- Added `RenderResultOptions.spinnerFrame` for animated tool-result rendering

### Changed

- `prompt()` and `continue()` now throw when the agent is already streaming; use steering or follow-up queues instead

## [3.4.1337] - 2026-01-03

### Added

- Added `popMessage()` method to Agent class for removing and retrieving the last message
- Added abort signal checks during response streaming for faster interruption handling

### Fixed

- Fixed abort handling to properly return aborted message state when stream is interrupted mid-response

## [1.341.0] - 2026-01-03

### Added

- Added `interruptMode` option to control when queued messages interrupt tool execution.
- Implemented "immediate" mode (default) to check queue after each tool and interrupt remaining tools.
- Implemented "wait" mode to defer queue processing until the entire turn completes.
- Added getter and setter methods for `interruptMode` on Agent class.

## [1.337.1] - 2026-01-02

### Changed

- Forked to @gajae-code scope with unified versioning across all packages

## [1.337.0] - 2026-01-02

Initial release under @gajae-code scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@gajae-code/ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@gajae-code/pi-agent` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
