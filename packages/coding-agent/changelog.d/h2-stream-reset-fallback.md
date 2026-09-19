### Fixed

- A server-declared HTTP/2 `REFUSED_STREAM` now falls back to HTTP/1.1 because that protocol error proves the request was never processed. Generic `RST_STREAM`, connection resets, and connection closes preserve their original transport errors instead of replaying a request whose body may already have reached the peer. `HTTP2StreamReset` remains classified as a transport failure so the surfaced message names the failing host (`transport=HTTP2StreamReset url=…`) instead of Bun's context-free hint.
