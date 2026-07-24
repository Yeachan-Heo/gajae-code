# Changelog

## [Unreleased]

## [0.11.8] - 2026-07-23

## [0.11.0] - 2026-07-15

### Added

- Introduced `@gajae-code/bridge-client`, the standalone SDK v3 transport-only WebSocket client. It provides hello-gated request correlation, typed transport errors, bounded reconnect/deadline handling, stale-socket fencing, and a strict no-replay guarantee for sent requests.

### Changed

- Historical BridgeClient/backend-bridge, RPC ingress, and backend compatibility protocols are not supported by this package and must not be restored. Consumers use the SDK v3 WebSocket transport instead.
