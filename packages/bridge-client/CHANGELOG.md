# Changelog

## [Unreleased]

## [0.4.0] - 2026-06-06

### Added

- Added typed `workflow_gate` receive and respond helpers so a client can detect a gate frame and answer it from its own memory via a callback (#322).
- The SDK is now published to npm as part of the public release set.

## [0.3.1] - 2026-06-05

### Added

- Added the initial `@gajae-code/bridge-client` TypeScript SDK for the GJC backend bridge, including authenticated handshake/command/event helpers, controller/UI/host callback APIs, idempotency-key helpers, and a minimal reference consumer renderer.
- Documented that the SDK is experimental and tracks `BRIDGE_PROTOCOL_VERSION` 1: `command()` and the typed command helpers return `Promise<unknown>` (callers narrow responses themselves), and the package intentionally does not import `@gajae-code/coding-agent` internal `rpc-types` to preserve the package boundary. Stable shared protocol response types are tracked as follow-up work.

### Fixed

- Refuse bearer-token bridge clients over non-HTTPS URLs by default, with an explicit localhost-only opt-in for local/test harnesses.
