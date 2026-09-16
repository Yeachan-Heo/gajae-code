### Fixed

- Stop a runaway reasoning stream instead of rendering every repeat. When an
  openai-compatible model falls into a decode loop and emits the same line — or
  the same short token run — 12 times in a row on the reasoning channel, the turn
  is now cut short with `stopReason: "error"` and
  `errorCode: "repetition_guard_tripped"` rather than dumping dozens of identical
  lines into the terminal. Tool calls in the same message still stream and
  execute normally, including ones the model emits *after* the repeats.

  The stop is classified as a provider error rather than `aborted`, so the auth
  gateway renders it as HTTP 502 `upstream_error` and telemetry no longer counts
  it as a user cancellation. A genuine caller abort still wins and still reports
  `aborted`. The trip is terminal and is not auto-retried: a decode loop is
  deterministic for the submitted context, so replaying it would re-trip the
  guard and re-bill the full context on every attempt.

  The guard applies to the reasoning channel only. Visible text is opt-in via the
  new `repetitionGuard` option (`{ thinking?: number | false; text?: number |
  false }`), because visible output is a deliverable and intentional repetition
  there — log dumps, fixtures, tables, generated code — must survive byte for
  byte.
- Keep a provider stall or transport error that lands *after* a repetition trip
  classified as what it actually is. The guard drains the stream briefly after
  tripping, and a fault arriving inside that window was being reported as a
  decode loop — discarding the real error message, `errorStatus` and
  `transportFailure`, and marking a retryable provider fault as terminal. The
  guard's own abort is now tracked explicitly, so only it claims the trip.
- Keep the repeated sample out of error payloads. The guard's `errorMessage`
  interpolated the repeated unit, the channel and the repeat count, and the auth
  gateway forwards `errorMessage` to API clients on the streaming path — so raw
  model output was published verbatim, and a repeated `quota` or `forbidden` in
  the sample could steer the HTTP status the gateway picked. The message is now
  a fixed literal at the provider, the gateway substitutes the same bounded
  envelope its non-streaming path already used, and the sample survives only in
  local `logger.debug` diagnostics.
- Strip leaked chat-template tool fences (`<|tool_call_end|>` and friends) from
  rendered thinking, including fences split across streaming chunk boundaries.
  The visible text channel is deliberately untouched, so a fence token the
  assistant mentions in prose still survives as text.
