### Fixed

- Fixed Gemini and Vertex `MALFORMED_RESPONSE` finishes showing as "Unhandled stop reason" and dropping that turn's token usage; RPC prompt errors now report them as retryable (#7919).
