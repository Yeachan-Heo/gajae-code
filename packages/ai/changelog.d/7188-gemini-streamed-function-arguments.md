### Fixed

- Request streamed function-call arguments for native Gemini 3+ providers, assembling nested arguments, chunked strings, IDs, and thought signatures before completing each tool call. Reject truncated or malformed streamed arguments without emitting a completed tool call (#7188).
