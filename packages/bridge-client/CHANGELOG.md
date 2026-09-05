# Changelog

## [Unreleased]

## [0.16.4] - 2026-09-05

## [0.16.3] - 2026-09-04

## [0.16.2] - 2026-09-04

## [0.16.1] - 2026-09-03

## [0.16.0] - 2026-09-02

## [0.15.6] - 2026-08-30

## [0.15.5] - 2026-08-29

## [0.15.4] - 2026-08-29

## [0.15.3] - 2026-08-27

## [0.15.2] - 2026-08-25

## [0.15.1] - 2026-08-25

## [0.15.0] - 2026-08-22

## [0.14.2] - 2026-08-20

## [0.14.1] - 2026-08-18

## [0.14.0] - 2026-08-17

- **Retired:** This package was retired in the SDK-owned session lifecycle refactor. There is no public replacement transport; use `gjc sdk session` or managed adapters.

## [0.13.3] - 2026-08-15

## [0.13.2] - 2026-08-13

## [0.13.1] - 2026-08-11
### Changed

- Renamed the create-connect-submit API contract to durable client-side orchestration. The create key and submission reference remain durable in their existing authorities, and recovery reconciles their composite outcome after restart; the SDK does not promise a single-authority transactional atomic outcome across process failure. `SdkDurableLookupIdentity` carries no create replay material — no `create` or `createRedacted` field — so no potentially secret-bearing MCP server definition (HTTP/SSE URL userinfo/query tokens, stdio args, env, headers) can leak into the public recovery identity. The full create is supplied separately by the caller via `SdkDurableReconcileOptions.create` when replay is needed during reconciliation.

### Added

- Added `SdkClient.createConnectSubscribeSubmit()` and `reconcileCreateConnectSubmit()`. The TypeScript SDK retains caller-provided create and submission identities, fences the one ordered write to a replay-validated socket incarnation, and reports explicit recovery uncertainty without retrying ordered work.

## [0.12.21] - 2026-08-09

## [0.12.20] - 2026-08-09
### Fixed

- `SdkClient` request-timeout errors now expose `SdkRequestTimeoutDetails`, including whether `WebSocket.send()` returned. A sent request remains execution-uncertain; ordered prompt and skill callers must reconcile through their existing `clientRef` rather than retry.

## [0.12.19] - 2026-08-08

## [0.12.18] - 2026-08-08

## [0.12.17] - 2026-08-08

## [0.12.16] - 2026-08-08

### Added

- `SdkClientOptions.reconnectMaxBackoffMs` caps each exponential reconnect sleep (default 2s). A client configured with a long reconnect budget now keeps probing every couple of seconds instead of sleeping for tens of seconds on its final attempts. The `reconnectAttempts`/`reconnectBackoffMs` defaults (3 attempts, 25ms base, 100ms maximum sleep) are unchanged and stay below the new cap, so no existing caller changes behavior.
- Lifecycle requests now retain a normalized reconciliation fingerprint after an uncertain send. Callers can use `lookupLifecycle` to distinguish the durable accepted/terminal outcome without resending ordered work.
- Added `SdkClient.createConnectSubscribeSubmit()` and `reconcileCreateConnectSubmit()`. The TypeScript SDK retains caller-provided create and submission identities, fences the one ordered write to a replay-validated socket incarnation, and reports explicit recovery uncertainty without retrying ordered work.

## [0.12.15] - 2026-08-06

## [0.12.14] - 2026-08-06

## [0.12.13] - 2026-08-06

## [0.12.12] - 2026-08-05

## [0.12.11] - 2026-08-03

## [0.12.10] - 2026-08-03

## [0.12.8] - 2026-08-02

## [0.12.7] - 2026-07-31

## [0.12.6] - 2026-07-31

## [0.12.5] - 2026-07-30

## [0.12.4] - 2026-07-30

## [0.12.3] - 2026-07-30

## [0.12.2] - 2026-07-30

## [0.12.1] - 2026-07-29

## [0.12.0] - 2026-07-28
### Fixed

- `SdkClient` no longer drops a `server_hello`/`hello` frame that arrives while the transport is still in the `opening` phase. Early hellos are buffered and applied when the open handler advances to `hello`, preventing load-raced `protocol_error` / failed query connects (CI AD-L-G02 flake).

## [0.11.0] - 2026-07-15

### Added

- Introduced `@gajae-code/bridge-client`, the standalone SDK v3 transport-only WebSocket client. It provides hello-gated request correlation, typed transport errors, bounded reconnect/deadline handling, stale-socket fencing, and a strict no-replay guarantee for sent requests.

### Changed

- Historical BridgeClient/backend-bridge, RPC ingress, and backend compatibility protocols are not supported by this package and must not be restored. Consumers use the SDK v3 WebSocket transport instead.
