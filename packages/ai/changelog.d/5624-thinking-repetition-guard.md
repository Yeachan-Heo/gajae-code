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
- Classify a runaway turn whose final repeat arrives without a trailing newline.
  The guard closed a line only on `\n` and a token only on whitespace, so a
  stream that ended mid-unit left the last copy uncounted and the turn reported a
  healthy completion. The guard is now finalized at end of stream — on the
  normal-completion path only, so a stream that threw mid-repeat still keeps its
  own transport facts.
- Bound the post-trip drain on *every* consumed chunk. The drain budget was only
  spent by chunks that carried a usable `choices[0]`; usage-only, keepalive-shaped,
  `choices`-less and malformed frames skipped the check entirely, so a provider
  answering a tripped stream with those frames held the request open with no
  bound at all. The check now runs exactly once per consumed chunk, still after
  that chunk is fully processed so late tool-call frames are never cut mid-flight.
- Make `repetitionGuard` reachable from the public API. The option existed only
  on the openai-completions provider type and was dropped by the
  `streamSimple`/`completeSimple` options mapping, so callers on the normal path
  could neither disable a channel nor change its threshold. It is now part of
  `SimpleStreamOptions` (as the shared `RepetitionGuardOptions` type) and is
  forwarded to the transport; defaults and semantics are unchanged.
- Validate the repetition threshold before it sizes the guard's state. Now that
  `repetitionGuard` is public, a caller could pass `NaN` — which made every
  comparison false and silently disabled detection with no error — or `Infinity`
  or a huge value, which left detection permanently off *and* made the guard's
  token retention unbounded on a long stream. A fractional threshold was also
  never reached exactly by an integer repeat counter. The threshold is now
  normalized at the constructor: non-finite values fall back to the default,
  fractions are floored, and the result is clamped into `[2,
  MAX_REPETITION_THRESHOLD]`, so tracking capacity is finite by construction.
  Bad input normalizes rather than throwing — a failed request would be worse
  than the guard running at its default.
- Stop persisting raw repeated model output in the default logs. The trip
  diagnostic logged the repeated sample, and the default log transport is a
  rotating file that JSON-stringifies metadata verbatim with no redaction, so a
  model that looped on a secret or a private fragment of the prompt wrote it to
  disk and into log rotation, support bundles and backups. The diagnostic now
  carries bounded, derived metadata only (`sampleLength`, a number). The sample
  remains on the in-memory trip object for callers.
- Strip leaked chat-template tool fences (`<|tool_call_end|>` and friends) from
  rendered thinking, including fences split across streaming chunk boundaries.
  The visible text channel is deliberately untouched, so a fence token the
  assistant mentions in prose still survives as text.
