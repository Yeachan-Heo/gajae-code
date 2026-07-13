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
One ACP connection may manage sessions from multiple absolute working directories. The SDK broker issues a realpath-equivalent workspace scope, a per-boot owner identity, exact live-endpoint generation/incarnation, and full saved-transcript file identity. ACP carries those capabilities through live attach/close and saved delete/resume/fork, and scopes lifecycle idempotency to the same endpoint or transcript incarnation. Missing or changed broker ownership, conflicting workspaces, duplicate live observations, successor generations, or recreated transcripts synchronously invalidate the session authority and reverse capabilities before asynchronous adapter teardown.

## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
