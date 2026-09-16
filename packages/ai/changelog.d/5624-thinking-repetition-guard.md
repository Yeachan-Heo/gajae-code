### Fixed

- Stop a runaway thinking/text stream instead of rendering every repeat. When an
  openai-compatible model falls into a decode loop and emits the same line — or
  the same short token run — 12 times in a row, the turn is now cut short with
  `stopReason: "aborted"` and `errorCode: "repetition_guard_tripped"` rather than
  dumping dozens of identical lines into the terminal. Tool calls in the same
  message still stream and execute normally.
- Strip leaked chat-template tool fences (`<|tool_call_end|>` and friends) from
  rendered thinking, including fences split across streaming chunk boundaries.
  The visible text channel is deliberately untouched, so a fence token the
  assistant mentions in prose still survives as text.
