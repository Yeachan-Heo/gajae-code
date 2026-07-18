# ADR: Multi-session dashboard discovery and control

## Decision

Ship a read-only top-level sessions dashboard. It discovers sessions with `SessionManager.listAll()` (`packages/coding-agent/src/session/session-manager.ts:6070-6079`), which scans `<agentDir>/sessions/*/*.jsonl` and returns parsed `SessionInfo`; the current-project picker uses `SessionManager.list()` and is intentionally narrower. The dashboard displays `SessionInfo.cwd`, title (falling back to `firstMessage`), modification time, message count, and opt-in presence status.

Use an **opt-in presence file** for liveness: a publisher writes an adjacent `<session>.jsonl.presence.json` containing an `expiresAt` timestamp. A future expiry is `active`, an expired valid record is `stale`, and absent or malformed data is `unknown`. The dashboard only reads that sidecar and never treats transcript mtime as liveness.

**M5.2 decision: descope dashboard-initiated dispatch and reply.** This is a deliberate product and authorization-scope decision, not a claim that no authenticated harness or coordinator transport exists. No dashboard dispatch command, transport registration, or launcher is added.

## Drivers

- `SessionManager.listAll()` is the established global storage inventory. It is a read-only scan; `listForResumePickerReadOnly()` is the scoped no-maintenance-write alternative for pickers that require strict read-only behavior.
- Harness children receive `GJC_SESSION_ID` and `GJC_LIFECYCLE_REQUEST_ID` (`packages/coding-agent/src/harness-control-plane/sdk-transport.ts:376-379`), and `SessionManager` adopts the preallocated ID into the transcript header (`packages/coding-agent/src/session/session-manager.ts:592-597`, `3762-3768`). That is a real identity binding for harness-spawned sessions.
- Harness resolves the session SDK endpoint and authenticates with its URL and token (`packages/coding-agent/src/harness-control-plane/sdk-transport.ts:135-177`). Root resolution fail-closes on a workspace mismatch (`packages/coding-agent/src/harness-control-plane/storage.ts:347-393`). That is a real authenticated transport for that harness lifecycle scope.
- Coordinator mutations are gated: its contract exposes register, start, send, and stop (`packages/coding-agent/src/coordinator/contract.ts:4-23`); policy applies gating (`packages/coding-agent/src/coordinator-mcp/policy.ts:186-189`); and the server binds identity to an incarnation (`packages/coding-agent/src/coordinator-mcp/server.ts:2144+`). The `readOnly` field in `commands/coordinator.ts` is hardcoded and is not an authoritative statement that mutations do not exist.

## Alternatives

1. **Dashboard-to-harness dispatch — rejected for now.** The authenticated, transcript-bound transport is limited to sessions spawned by the harness. A global dashboard row may describe an arbitrary persisted session and has no authorization or consent UX that lets a user deliberately grant dashboard control over that runtime.
2. **Dashboard-to-coordinator dispatch — rejected for now.** Coordinator mutations exist behind policy and incarnation-bound identity, but the dashboard has no product-level authorization/consent handoff or stable mapping from every listed transcript to an authorized coordinator runtime.
3. **PID liveness with a staleness window — rejected.** `SessionHeader` and `SessionInfo` do not persist a PID. A PID inferred from unrelated state can be recycled and is not authenticated.
4. **Opt-in presence file — chosen.** It is explicit, bounded by expiry, and can be read without asserting ownership. A presence protocol remains necessary for non-harness sessions; missing presence correctly remains `unknown`.

## Consequences

The dashboard is an observation surface only and must make zero writes to foreign session directories. `/sessions` and the unbound `app.session.dashboard` action open the overlay; `/resume` remains the explicit mutation-capable transition. Presence publication is a future opt-in producer contract, not part of M5.1. M5.2 remains descope until the dashboard provides an explicit authorization/consent UX, a safe binding for the selected row to a target runtime beyond the harness lifecycle scope, and presence support for non-harness sessions.
