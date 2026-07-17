# Coding Agent development

This guide describes the supported machine-facing architecture in `packages/coding-agent`. The supported integration boundary is the SDK. The retired RPC mode, bridge client, and unattended protocol are not compatibility surfaces.

## Runtime entrypoints

```text
CLI / daemon session commands / ACP / MCP
                    │
                    ▼
              SDK client + protocol
                    │
                    ▼
        broker and per-session SDK hosts
                    │
                    ▼
              AgentSession runtime
```

- **Interactive and print CLI**: `src/cli.ts` routes ordinary CLI work to `src/main.ts`, which owns local session setup and interactive or one-shot execution.
- **SDK transport client**: `@gajae-code/bridge-client` owns the standalone transport-only v3 `SdkClient` and its associated types. `src/sdk/client/client.ts` and `@gajae-code/coding-agent/sdk` compatibility exports re-export that exact class identity; protocol operations remain registered in `src/sdk/protocol/operation-registry.ts`.

- **Daemon session CLI**: `gjc daemon session ...` is implemented by `src/commands/daemon.ts` and `src/sdk/cli/session-cli.ts`. It discovers the SDK broker/session endpoint and invokes typed SDK `list`, `control`, `query`, or `global` operations; it does not launch a private transport.
- **ACP**: `src/modes/acp/acp-mode.ts` creates the ACP connection and `src/modes/acp/acp-agent.ts` adapts ACP requests to `AcpSdkAdapter` and `SdkClient`. ACP must keep session authority in the SDK.
- **MCP**: `gjc mcp-serve sdk` dispatches to `src/sdk/mcp/server.ts`. `gjc mcp-serve coordinator` (and the `hermes` compatibility alias) dispatches to `src/coordinator-mcp/server.ts`.

## SDK ownership and authority

The SDK host, broker, and session endpoint are the authority boundary:

- `src/sdk/host/` owns session control and query dispatch.
- `src/sdk/broker/` owns broker discovery, identity, transport, lifecycle, and endpoint indexing.
- `src/sdk/bus/` owns supported notification/daemon delivery and its lifecycle.
- `src/sdk/client/` is the only client connection surface used by adapters and coordinators.

Do not add a listener, direct `AgentSession` mutation path, or a second machine protocol to an adapter. Register a protocol operation and route it through the SDK instead.

## Coordinator MCP routing

`src/coordinator-mcp/server.ts` is a coordinator-facing MCP server, not a second session host. It resolves broker or session discovery data, connects through `SdkClient`, and calls SDK `global`, `query`, or `control` operations. Coordinator policy and artifact validation belong in `src/coordinator-mcp/`; session mutation belongs behind the SDK operation registry.

The coordinator may manage its own coordinator records and artifacts, but it must not import or mutate `AgentSession` or SDK host-control internals directly.

## Adding a machine-facing capability

1. Define or extend the operation contract in `src/sdk/protocol/operation-registry.ts`.
2. Implement the operation in the appropriate SDK host control or query handler.
3. Expose it through `SdkClient` and validate adapter input with the protocol validation helpers.
4. Route ACP, SDK MCP, daemon-session CLI, or coordinator MCP through that SDK client API. Do not duplicate the operation in a transport-specific handler.
5. Add focused tests for success, validation failure, authorization/disposition, and lifecycle behavior.

Choose the public surface deliberately:

- Use the **SDK** for programmatic control and queries.
- Use **ACP** for ACP clients; keep it an SDK adapter.
- Use **SDK MCP** for agent-facing SDK tools.
- Use **Coordinator MCP** for coordinator workflow tools; it routes through `SdkClient`.
- Use **daemon session CLI** for operator invocation of SDK operations.

## Removed surfaces

Do not restore or document as active:

- `--mode rpc`, RPC mode source, JSONL RPC clients, or RPC compatibility fixtures.
- Historical `BridgeClient` backend protocol surfaces, including handshake, commands, SSE, and direct host-control bypasses. The standalone `@gajae-code/bridge-client` package exports only the v3 transport `SdkClient` surface.
- Unattended transport imports or protocol clients.


Historical changelog entries, removal documentation, and negative scanner self-tests may mention retired terms only to document their removal.

## Verification

The closure gate is `bun run verify:sdk-canonicalization` from this package. It is part of `bun run check`, so workspace checks and root release/prepublish checks enforce it automatically. The scanner permits only the standalone `@gajae-code/bridge-client` v3 package and root `SdkClient` import; it rejects historical BridgeClient protocol surfaces, retired source trees and exports, bridge/unattended imports, executable RPC compatibility fixtures, direct authority bypasses, and unsupported machine-entrypoint import graphs.

Run focused checks while working on this boundary:

```sh
bun --cwd=packages/coding-agent run verify:sdk-canonicalization
bun --cwd=packages/coding-agent run verify:sdk-canonicalization --self-test
bun --cwd=packages/coding-agent test <focused-test>
```

Use `bun --cwd=packages/coding-agent run check` before handing off a package-wide change. It includes the canonicalization gate and type check.
