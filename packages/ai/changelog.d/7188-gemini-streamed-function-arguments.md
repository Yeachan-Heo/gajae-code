### Fixed

- Request streamed function-call arguments for native Gemini 3+ providers, assembling nested arguments, chunked strings, IDs, and thought signatures before completing each tool call. Handle valueless terminal `[]`/`{}` container markers without losing populated containers, including empty containers and root objects. Preserve opaque call IDs, signatures, and call/response order across tool-result round trips. Reject truncated or malformed streamed arguments without emitting a completed tool call (#7188).
