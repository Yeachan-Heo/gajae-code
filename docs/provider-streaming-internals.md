# Provider streaming internals

This document explains how token/tool streaming is normalized in `@gajae-code/ai`, then propagated through `@gajae-code/agent-core` and `coding-agent` session events.

## End-to-end flow

1. `streamSimple()` (`packages/ai/src/stream.ts`) maps generic options and dispatches to a provider stream function.
2. Provider stream functions translate provider-native stream events into the unified `AssistantMessageEvent` sequence. Current built-ins include Anthropic, OpenAI Responses/Completions/OpenAI code/Azure Responses, Google Gemini/Gemini CLI/Vertex, Bedrock Converse, Ollama, Cursorand GitLab Duo/Kimi wrappers.
3. Each provider pushes events into `AssistantMessageEventStream` (`packages/ai/src/utils/event-stream.ts`), which throttles delta events and exposes:
   - async iteration for incremental updates
   - `result()` for final `AssistantMessage`
4. `agentLoop` (`packages/agent/src/agent-loop.ts`) consumes those events, mutates in-flight assistant state, and emits `message_update` events carrying the raw `assistantMessageEvent`.
5. `AgentSession` (`packages/coding-agent/src/session/agent-session.ts`) subscribes to agent events, persists messages, and applies session behaviors (retry, compaction, TTSR, streaming-edit abort checks).

## Unified stream contract in `@gajae-code/ai`

All providers emit the same shape (`AssistantMessageEvent` in `packages/ai/src/types.ts`):

- `start`
- content block lifecycle triplets:
  - text: `text_start` → `text_delta`\* → `text_end`
  - thinking: `thinking_start` → `thinking_delta`\* → `thinking_end`
  - tool call: `toolcall_start` → `toolcall_delta`\* → `toolcall_end`
- terminal event:
  - `done` with `reason: "stop" | "length" | "toolUse"`
  - or `error` with `reason: "aborted" | "error"`

`AssistantMessageEventStream` guarantees:

- final result is resolved by terminal event (`done` or `error`)
- deltas are batched/throttled (~50ms)
- buffered deltas are flushed before non-delta events and before completion

## Delta throttling and harmonization behavior

`AssistantMessageEventStream` treats `text_delta`, `thinking_delta`, and `toolcall_delta` as mergeable events:

- buffered deltas are merged only when **type + contentIndex** match
- merge keeps the latest `partial` snapshot
- non-delta events force immediate flush

This smooths high-frequency provider streams for TUI/event consumers, but is not provider backpressure: providers still produce at full speed, while the local stream buffers.

## Provider normalization details

## Anthropic (`anthropic-messages`)

Source: `packages/ai/src/providers/anthropic.ts`

Normalization points:

- `message_start` initializes usage (input/output/cache tokens)
- `content_block_start` maps to text/thinking/toolcall starts
- `content_block_delta` maps:
  - `text_delta` → `text_delta`
  - `thinking_delta` → `thinking_delta`
  - `input_json_delta` → `toolcall_delta`
  - `signature_delta` updates `thinkingSignature` only (no event)
- `content_block_stop` emits corresponding `*_end`
- `message_delta.stop_reason` maps via `mapStopReason()`

Tool-call argument streaming:

- each tool block carries internal `partialJson`
- every JSON delta appends to `partialJson`
- `arguments` are reparsed on each delta via `parseStreamingJson()`
- `toolcall_end` reparses once more, then strips `partialJson`

## OpenAI Responses family (`openai-responses`, `openai-code-responses`, `azure-openai-responses`)

Sources: `packages/ai/src/providers/openai-responses.ts`, `openai-code-responses.ts`, and `azure-openai-responses.ts`

Normalization points:

- `response.output_item.added` starts reasoning/text/function-call blocks
- reasoning summary events (`response.reasoning_summary_text.delta`) become `reasoning_summary_delta` and update the message's thinking block
- output/refusal deltas become `text_delta`
- `response.function_call_arguments.delta` becomes `toolcall_delta`
- `response.output_item.done` emits `thinking_end` / `text_end` / `toolcall_end`
- `response.completed` maps status to stop reason and usage

Tool-call argument streaming:

- same `partialJson` accumulation pattern as Anthropic
- providers that send only `response.function_call_arguments.done` still populate final args
- tool call IDs are normalized as `"<call_id>|<item_id>"`

## Google Generative AI (`google-generative-ai`)

Source: `packages/ai/src/providers/google.ts`

Normalization points:

- iterates `candidate.content.parts`
- text parts are split into thinking vs text by `isThinkingPart(part)`
- block transitions close previous block before starting a new one
- `part.functionCall` is treated as a complete tool call (start/delta/end emitted immediately)
- finish reason mapped by `mapStopReason()` from `google-shared.ts`

Tool-call argument streaming:

- function call args arrive as structured object, not incremental JSON text
- implementation emits one synthetic `toolcall_delta` containing `JSON.stringify(arguments)`
- no partial JSON parser needed for Google in this path

## Partial tool-call JSON accumulation and recovery

Shared behavior for Anthropic/OpenAI Responses uses `parseStreamingJson()` (`packages/ai/src/utils/json-parse.ts`):

1. try `JSON.parse`
2. fallback to `partial-json` parser for incomplete fragments
3. if both fail, return `{}`

Implications:

- malformed or truncated argument deltas do not crash stream processing immediately
- in-progress `arguments` may temporarily be `{}`
- later valid deltas can recover structured arguments because parsing is retried on every append
- final `toolcall_end` performs one more parse attempt before emission

## Stop reasons vs transport/runtime errors

Provider stop reasons are mapped to normalized `stopReason`:

- Anthropic: `end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`toolUse`, safety/refusal cases→`error`
- OpenAI Responses: `completed`→`stop`, `incomplete`→`length`, `failed/cancelled`→`error`
- Google: `STOP`→`stop`, `MAX_TOKENS`→`length`, safety/prohibited/malformed-function-call classes→`error`

Error semantics are split in two stages:

1. **Model completion semantics** (provider reported finish reason/status)
2. **Transport/runtime failure** (network/client/parser/abort exceptions)

If provider stream throws or signals failure, each provider wrapper catches and emits terminal `error` event with:

- `stopReason = "aborted"` when abort signal is set
- otherwise `stopReason = "error"`
- `errorMessage = formatErrorMessageWithRetryAfter(error)`

## Malformed chunk / SSE parse failure behavior

For these provider paths, chunk/SSE framing is handled by vendor SDK streams (Anthropic SDK, OpenAI SDK, Google SDK). This code does not implement a custom SSE decoder here.

Observed behavior in current implementation:

- malformed chunk/SSE parsing at SDK level surfaces as an exception or stream `error` event
- provider wrapper converts that into unified terminal `error` event
- no provider-specific resume/retry inside the stream function itself
- higher-level retries are handled in `AgentSession` auto-retry logic (message-level retry, not stream-chunk replay)

## Cancellation boundaries

Cancellation is layered:

- AI provider request: `options.signal` is passed into provider client stream call.
- Provider wrapper: after stream loop, aborted signal forces error path (`"Request was aborted"`).
- Agent loop: checks `signal.aborted` before handling each provider event and can synthesize an aborted assistant message from the latest partial.
- Session/agent controls: `AgentSession.abort()` -> `agent.abort()` -> shared abort controller cancellation.

Tool execution cancellation is separate from model stream cancellation:

- tool runners use `AbortSignal.any([agentSignal, steeringAbortSignal])`
- steering interrupts can abort remaining tool execution while preserving already-produced tool results

## Backpressure boundaries

There is no hard backpressure mechanism between provider SDK stream and downstream consumers:

- `EventStream` uses in-memory queues with no max size
- throttling reduces UI update rate but does not slow provider intake
- if consumers lag significantly, queued events can grow until completion

Current design favors responsiveness and simple ordering over bounded-buffer flow control.

## How stream events surface as agent/session events

`agentLoop.streamAssistantResponse()` bridges `AssistantMessageEvent` to `AgentEvent`:

- on `start`: pushes placeholder assistant message and emits `message_start`
- on block events (`text_*`, `thinking_*`, `reasoning_summary_*`, `toolcall_*`): updates last assistant message, emits `message_update` with raw `assistantMessageEvent`
- on terminal (`done`/`error`): resolves final message from `response.result()`, emits `message_end`

For ordinary unmanaged turns, the first content event publishes the provisional
nonterminal lifecycle, including reasoning-only and tool-only streams. Subsequent
updates are delivered live without waiting for text, response completion, or an
interrupt. This is presentation, not tool acceptance: terminal validation and the
consumer drain still precede execution. A legacy guarded call that has already
been published receives an explicit rejection instead of silently disappearing
through same-turn resampling; unpublished terminal-only attempts can still retry.
Managed fallback attempts retain atomic publication/discard semantics and do not
use this unmanaged early-publication path.

`AgentSession` then consumes those events for session-level behaviors:

- TTSR watches `message_update.assistantMessageEvent` for `text_delta`, `thinking_delta`, and `toolcall_delta`
- streaming edit guard inspects `toolcall_delta`/`toolcall_end` on `edit` calls and can abort early
- persistence writes finalized messages at `message_end`
- auto-retry examines assistant `stopReason === "error"` plus `errorMessage` heuristics

## Unified vs provider-specific responsibilities

Unified (common contract):

- event shape (`AssistantMessageEvent`)
- final result extraction (`done`/`error`)
- delta throttling + merge rules
- agent/session event propagation model

Provider-specific (not fully abstracted):

- upstream event taxonomies and mapping logic
- stop-reason translation tables
- tool-call ID conventions
- reasoning/thinking block semantics and signatures
- usage token semantics and availability timing
- message conversion constraints per API

## Implementation files

- [`../../ai/src/stream.ts`](../packages/ai/src/stream.ts) — provider dispatch, option mapping, API key/session plumbing, custom API dispatch, and provider-specific credential handling.
- [`../../ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts) — generic stream queue + assistant delta throttling.
- [`../../ai/src/utils/json-parse.ts`](../packages/ai/src/utils/json-parse.ts) — partial JSON parsing for streamed tool arguments.
- [`../../ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts) — Anthropic event translation and tool JSON delta accumulation.
- [`../../ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts), [`openai-code-responses.ts`](../packages/ai/src/providers/openai-code-responses.ts), [`azure-openai-responses.ts`](../packages/ai/src/providers/azure-openai-responses.ts) — Responses-family event translation and status mapping.
- [`../../ai/src/providers/google.ts`](../packages/ai/src/providers/google.ts), [`google-gemini-cli.ts`](../packages/ai/src/providers/google-gemini-cli.ts), [`google-vertex.ts`](../packages/ai/src/providers/google-vertex.ts) — Gemini stream chunk-to-block translation variants.
- [`../../ai/src/providers/google-shared.ts`](../packages/ai/src/providers/google-shared.ts) — Gemini finish-reason mapping and shared conversion rules.
- [`../../ai/src/providers/amazon-bedrock.ts`](../packages/ai/src/providers/amazon-bedrock.ts), [`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts), [`ollama.ts`](../packages/ai/src/providers/ollama.ts), [`cursor.ts`](../packages/ai/src/providers/cursor.ts) — additional built-in stream adapters using the same event contract.
- [`../../agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts) — provider stream consumption and `message_update` bridging.
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level handling of streaming updates, abort, retry, and persistence.
