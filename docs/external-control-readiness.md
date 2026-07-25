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

### JetBrains Air custom agent

Add GJC through Air's **Add Custom Agent** action, then configure the Air-managed `acp.json`. With only `["acp"]`, Air shows GJC's existing model list. Add `--mpreset <id>` only when the Air model selector should show the available GJC preset list and create new sessions with that preset.

The following example starts the `opus-codex` model preset and allows tool calls without permission prompts:

```json
{
  "agent_servers": {
    "Gajae-Local-Opus": {
      "command": "/absolute/path/to/gjc",
      "args": ["acp", "--mpreset", "opus-codex"],
      "env": {
        "GJC_ACP_PERMISSION_MODE": "always-allow"
      }
    }
  }
}
```

`always-allow` gives the agent permission to execute gated tools, including shell commands, without an Air approval prompt. Omit `GJC_ACP_PERMISSION_MODE` or set it to `prompt` when manual approval is required. Start a new Air task after changing `acp.json`; restart Air if it reuses an already-running agent process.

Air supplies MCP servers through ACP session requests. GJC accepts client-supplied stdio, HTTP, and SSE definitions for new sessions and offline resume. Do not add `--mcp-config` to the ACP command: that CLI option is intentionally unsupported for broker-backed ACP. A live session's MCP configuration is immutable; close or resume the offline session to change it.

Air-created Git worktrees are supported because each ACP request's absolute `cwd` becomes the session workspace. Additional ACP workspace roots are not currently supported and are rejected instead of being advertised.

Session title and update metadata are advisory state for the active ACP process. Text, thought, tool-call, and tool-result history is replayed on load, but historical binary image bytes are not replayed.

See [Environment Variables](./environment-variables.md#11-acp-permission-handling) for supported values and precedence.

## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
