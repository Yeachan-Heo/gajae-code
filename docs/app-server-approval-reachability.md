# App-server approval reachability

## Adapter boundary

Faithful preimage and unified-diff construction is owned upstream at the permission seam. The adapter resolves a top-level `toolCall.fileChanges` map before raw-input maps, validates every member with `isFileChange`, and rejects malformed or empty maps with `missing_approval_field` (`packages/coding-agent/src/app-server/server-requests/permission-adapter.ts:220-250`). Raw mutation arguments without faithful evidence still fail closed; the only raw fallback is a move with both endpoints (`packages/coding-agent/src/app-server/server-requests/permission-adapter.ts:252-268`).

This makes the adapter boundary honest, but it does not connect that boundary to a shipped app-server process.

## Transport gap

No shipped transport attaches a `threadStartAdapter` or a `PermissionAdapter`:

- Stdio constructs the runtime at `packages/coding-agent/src/app-server/cli/runtime.ts:124`.
- WebSocket constructs the runtime at `packages/coding-agent/src/commands/app-server.ts:159`.
- Unix-socket WebSocket constructs the runtime at `packages/coding-agent/src/commands/app-server.ts:227`.

Each call passes admission and frame-codec options only; none supplies the optional runtime `threadStartAdapter` slot. A repository search also finds no production `childCreate` anywhere in the tree, so there is no production child factory to establish the permission reverse-request path.

Therefore server-request approvals remain unreachable end to end and MUST NOT be claimed as working against a real client. Closing this gap requires a production child factory plus transport wiring that supplies the child/thread-start bridge and permission adapter to the shipped stdio, WebSocket, and Unix transports.
