# OpenClaw / Hermes RPC integration notes

GJC's supported integration boundary for OpenClaw- or Hermes-style hosts is the RPC mode, not direct imports from the runtime MCP implementation.

## Recommended boundary

Use `@gajae-code/coding-agent/modes`:

- `RpcClient` to spawn and drive `gjc --mode rpc`
- `defineRpcClientTool()` and `RpcClientOptions.customTools` to expose host-owned tools
- `RpcClient#setCustomTools()` to refresh the host tool list after the host reloads capabilities

OpenClaw/Hermes should map their own tools, MCP servers, and skills into RPC host tools. From GJC's point of view those are just host-owned tools; the host remains responsible for policy, credentials, approvals, and process lifetime.

```ts
import { RpcClient, defineRpcClientTool } from "@gajae-code/coding-agent/modes";

const client = new RpcClient({
  cwd: repoPath,
  customTools: [
    defineRpcClientTool({
      name: "openclaw_skill_search",
      description: "Search OpenClaw skills visible to this session",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(args, context) {
        context.sendUpdate("Searching OpenClaw skill registry…");
        return await searchOpenClawSkills(String(args.query));
      },
    }),
  ],
});

await client.start();
await client.promptAndWait("Use the host skill search when it helps.");
```

## MCP and skills mapping

Treat MCP as a host implementation detail:

1. OpenClaw/Hermes discovers its MCP servers and skills.
2. The host converts selected capabilities into RPC `customTools`.
3. GJC calls those tools through `host_tool_call` frames.
4. The host executes the real MCP/skill operation and returns `host_tool_result`.

This avoids leaking host credentials or policy decisions into GJC and lets OpenClaw keep its own approval, sandbox, and skill-loading rules.

## What not to import

Do not import these package paths from integrations:

- `@gajae-code/coding-agent/runtime-mcp`
- `@gajae-code/coding-agent/mcp`
- `@gajae-code/coding-agent/capability/mcp`
- `@gajae-code/coding-agent/config/mcp-schema`
- `@gajae-code/coding-agent/discovery/mcp-json`

Those paths are intentionally quarantined in `packages/coding-agent/package.json` and enforced by `scripts/verify-g002-gates.ts`. If an integration needs MCP functionality, expose it as a host-owned RPC tool instead of depending on those internals.

## Practical host-tool shape

Good first OpenClaw/Hermes bridge tools are small and policy-preserving:

- `openclaw_skill_search({ query })`
- `openclaw_skill_read({ name })`
- `openclaw_mcp_call({ server, tool, input })`
- `hermes_route_message({ target, message })`

Keep destructive or external-write actions behind the host's own approval flow. When a host tool starts long-running work, stream progress with `context.sendUpdate(...)` so GJC can surface the state without polling the host directly.

## Verification checklist

Before claiming an integration works:

1. `gjc --help` or `bun packages/coding-agent/src/cli.ts --help` starts without native/package resolution errors.
2. A host tool can be registered with `RpcClient#setCustomTools()`.
3. GJC emits `host_tool_call` for that tool.
4. The host returns `host_tool_result` and GJC emits `tool_execution_end`.
5. Direct imports from quarantined MCP paths still fail.

`packages/coding-agent/test/rpc-host-tools.test.ts` covers the host-tool RPC flow and is the reference test for OpenClaw/Hermes bridge work.
