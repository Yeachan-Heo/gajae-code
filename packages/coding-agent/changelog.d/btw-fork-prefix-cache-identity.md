# /btw Fork Provider-Bound Prefix for Cache Identity

## Added

- `/btw` side-channel now forks the provider-bound prefix to maintain prompt cache hits. The system prompt, tool definitions, and message prefix are reused byte-identically from the main session so the provider's prompt cache applies.

- Full main-session context (including tool calls and results) is now visible to `/btw` requests, enabling access to the complete conversation history.

- Tool calls in `/btw` responses are rejected and never executed (toolChoice: "none" prevents execution while definitions are included for cache identity).

## Changed

- `/btw` messages are cut atomically at the last complete assistant turn: dangling tool calls without results are excluded from the `/btw` context to maintain safety.

- Tool call arguments are sanitized in `/btw` messages for security while tool definitions and structure are preserved for cache identity.

## Fixed

- `/btw` requests no longer include the instruction in the system prompt, preserving exact byte-identity with the main session's provider request prefix for cache hits.

## Refs

- #6234 (Snowy's request)
