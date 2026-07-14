# External control readiness

The Gajae-Code SDK WebSocket protocol is the **only** external machine-control interface. See [SDK machine interfaces](./sdk.md) for the endpoint, authentication, events, state, and action contracts.

## Supported surfaces

| Surface | Entrypoint | Use it when |
| --- | --- | --- |
| SDK WebSocket | A running GJC session's loopback SDK endpoint | A program needs session state, events, actions, or workflow-gate replies. |
| Coordinator MCP | `gjc mcp-serve coordinator` | A controller needs multi-session orchestration, durable reports, or worktree-scoped lifecycle operations. |
| ACP | `gjc --mode acp` or `gjc acp` | An editor or ACP-compatible client supplies the session frontend. |

`--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed. Their JSONL, socket, and HTTPS protocols are not supported compatibility interfaces.

## SDK readiness

The SDK endpoint is loopback-only and is created with the session. It provides the machine interface for state reads, event subscriptions, action resolution, workflow-gate replies, and controlled session operations. Review [docs/sdk.md](./sdk.md) before building an integration.

## ACP readiness

ACP remains a stdio editor protocol. Its session control uses the SDK adapter internally; it is not a replacement external bot-control protocol.
One ACP connection may manage sessions from multiple absolute working directories. A scoped broker listing issues a current-boot owner proof and an opaque workspace grant that retains the opened directory object; every workspace lifecycle mutation must return that grant, and the broker revalidates the same object through preparation, child startup, readiness, and final publication. Live attachment is bound to exact endpoint generation/incarnation and is revalidated after adapter/provider setup immediately before publication. Saved authority includes the transcript's full stat tuple and SHA-256 content digest; resume/fork keep source, destination, workspace, process, and endpoint witnesses through readiness, while subsequent persistence reopens only the descriptor-bound destination inode. Verified ACP deletion overwrites the authorized transcript object with a canonical `session_deleted` tombstone through its retained descriptor instead of unlinking a mutable pathname. Scoped authority publication is all-or-nothing, and ambiguity, reused IDs, changed broker ownership, duplicate observations, successor endpoints, recreated transcripts, or workspace drift permanently revoke the affected connection capabilities before asynchronous teardown. Broker owner and workspace-grant tokens authenticate the current boot but are excluded from durable semantic idempotency hashes, so a new owner can safely replay an `accepted` result while `effect_started` or `awaiting_ready` restarts fail closed as `terminal_uncertain`.

## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
