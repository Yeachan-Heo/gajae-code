# @gajae-code/bridge-client

`@gajae-code/bridge-client` is the standalone SDK v3 WebSocket transport client for Gajae Code. It exports `SdkClient`, `SdkClientError`, and the associated frame, request, reconnect, and options types.

```ts
import { SdkClient } from "@gajae-code/bridge-client";

const client = await SdkClient.connect(endpoint.url, endpoint.token);
try {
	const metadata = await client.query("session.metadata");
	console.log(metadata);
} finally {
	await client.close();
}
```

## Transport contract

The client adds the endpoint token as a WebSocket query parameter, waits for a server `hello` frame before requests are sent, and correlates responses by request ID. A server error response rejects with `SdkClientError`, whose `code`, `message`, and `details` preserve the wire error. It bounds open, hello, retry, and request work with the configured timeout and optional absolute deadline.

A request that has been sent is never replayed after reconnect. Callers that need retry semantics must decide whether retrying their operation is safe and provide their own idempotency protocol where appropriate.

## Scope and compatibility

This package is transport-only. It does not import, instantiate, dispatch to, or otherwise own `AgentSession`, broker lifecycle, backend process management, or application operation handlers.

It is SDK v3 only. The historical BridgeClient/backend-bridge protocol, RPC ingress, and compatibility behavior are intentionally unsupported and must not be restored. Use the documented SDK v3 WebSocket endpoint and frames instead.

`@gajae-code/coding-agent/sdk` re-exports this package for compatibility; both entrypoints expose the same `SdkClient` class identity.
