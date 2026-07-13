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
One ACP connection may manage sessions from multiple absolute working directories. The SDK broker remains the canonical lifecycle authority, while the ACP adapter keeps a connection-local session-to-CWD binding for methods such as close and delete that do not carry a CWD. If the broker exposes the same session ID under conflicting workspaces, that ID becomes non-authorizing for the rest of the connection and lifecycle operations fail closed.

## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
