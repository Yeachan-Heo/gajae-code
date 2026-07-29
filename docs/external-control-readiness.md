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

#### Evidence promotion policy

Ordinary CI runs publish an **ephemeral** report under `$RUNNER_TEMP` and upload it as a
build artifact with bounded retention; those runs never rewrite tracked evidence.
`artifacts/acp-core-v1-conformance-baseline.json` is a **deliberately promoted** release
baseline: it is refreshed only from a successful pinned run for a release candidate, so a
tracked change to it is an explicit act rather than per-run churn.

The conformance workspace passed via `--cwd` must be a real path, not one reached through
a symlink (on macOS `/tmp` links to `/private/tmp`): the ACP client enforces its session
cwd root against the resolved path, so a symlinked workspace fails the client-authority
cases. The wrapper rejects such a `--cwd` up front.

## JetBrains Air custom agent

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

Air supplies MCP servers through ACP session requests. GJC accepts client-supplied stdio, HTTP, and SSE definitions for new sessions and offline resume. Do not add `--mcp-config` to the ACP command: that CLI option is intentionally unsupported for broker-backed ACP. A live session's MCP configuration is immutable; reconnect declarations from Air attach to the existing configuration instead of attempting to replace it. Close or resume the offline session to change its MCP configuration.
Air clients that advertise form elicitation receive `AskUserQuestion` selections and free-text prompts through ACP; declining or cancelling the form leaves the ask unanswered.

For local development, `bun run restart:sdk-broker` asks the published broker to shut down over its authenticated loopback channel, waits for that broker identity to disappear, and starts a replacement. A broker that predates the `broker.shutdown` operation answers `unknown_operation`; the restart then falls back to a `SIGTERM` sent only when the published pid still carries the published process incarnation. Use `--agent-dir <path>` when testing an isolated agent directory.

Restarting the broker alone leaves the session-host processes it spawned running, so ACP clients keep reattaching to sessions that still execute the previous source. Pass `--close-session-hosts` to close those sessions through the live broker first; only sessions served by a `sdk session-host-internal` process are selected, so interactive sessions publishing their own endpoint are never closed.

Air-created Git worktrees are supported because each ACP request's absolute `cwd` becomes the session workspace. Additional ACP workspace roots are not currently supported and are rejected instead of being advertised.

Session title and update metadata are advisory state for the active ACP process. Text, thought, tool-call, and tool-result history is replayed on load, but historical binary image bytes are not replayed.

See [Environment Variables](./environment-variables.md#11-acp-permission-handling) for supported values and precedence.

## ACP conformance and Air release gates

CI runs every `required_cases` entry in the pinned external `acpx@0.13.0` `acp-core-v1` corpus at upstream
commit `47dc1c56b20da3c248a4a1b5c5106f52e65e6594` against `gjc --mode acp`
through `bun run conformance:run`. The corpus is checked out outside this
repository; it is not vendored.
The `acp_conformance` CI job publishes its JSON report and blocks the aggregate
test status on failure.

JetBrains Air remains a versioned human-only compatibility gate. Before an Air
release claim, complete [`artifacts/acp-jetbrains-air-smoke.md`](../artifacts/acp-jetbrains-air-smoke.md)
for the tested Air and GJC builds, attach only redacted logs, and record the
result with the release evidence. This checklist must not be auto-filled by CI.
## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
