# Changelog

## [Unreleased]

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
