### Fixed

- A server-declared HTTP/2 `REFUSED_STREAM` now falls back to HTTP/1.1 because that protocol error proves the request was never processed. Generic `RST_STREAM`, connection resets, and connection closes preserve their original transport errors instead of replaying a request whose body may already have reached the peer. `HTTP2StreamReset` and `HTTP2RefusedStream` remain classified as transport failures so surfaced messages name the failing host (`transport=<code> url=…`) instead of Bun's context-free hint.
- Mutable `ArrayBuffer`/view, `FormData`, and `URLSearchParams` bodies fail closed rather than being replayed after an asynchronous refusal, and effective request headers are snapshotted before the HTTP/2 attempt so a caller mutation cannot change the HTTP/1.1 retry.
