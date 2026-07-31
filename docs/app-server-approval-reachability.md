# App-server approval reachability

## Adapter boundary

Faithful preimage and unified-diff construction is owned upstream at the permission seam. The adapter resolves a top-level `toolCall.fileChanges` map before raw-input maps, validates every member with `isFileChange`, and rejects malformed or empty maps with `missing_approval_field` (`packages/coding-agent/src/app-server/server-requests/permission-adapter.ts:220-250`). Raw mutation arguments without faithful evidence still fail closed; the only raw fallback is a move with both endpoints (`packages/coding-agent/src/app-server/server-requests/permission-adapter.ts:252-268`).

The adapter boundary remains honest, but the shipped transports now attach a production child bridge. `packages/coding-agent/src/app-server/thread-runtime/production-child.ts` creates a real in-process `AgentSession`, translates control/query operations through the existing SDK dispatch vocabulary, and forwards the session event stream to the app-server turn controller.

All shipped transports attach this adapter:

- Stdio: `packages/coding-agent/src/app-server/cli/runtime.ts:123-128`.
- WebSocket: `packages/coding-agent/src/commands/app-server.ts:158-163`.
- Unix-socket WebSocket: `packages/coding-agent/src/commands/app-server.ts:225-228`.

This makes `thread/start`, turn prompting, projection operations, and lifecycle frame delivery reachable against a real GJC session. The production bridge deliberately does not yet attach the permission reverse-request adapter, so server-request approval remains unreachable end to end and MUST NOT be claimed as working against a real client. `--listen off` remains transport-free and does not construct a runtime.