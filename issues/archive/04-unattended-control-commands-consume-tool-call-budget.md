# 04 — Read-only RPC commands consume the `max_tool_calls` budget and abort the run

- **Severity:** High
- **Scope:** `packages/coding-agent/src/modes/shared/agent-wire/unattended-session.ts:117-127` (`preflightCommand`), `packages/coding-agent/src/modes/shared/agent-wire/unattended-run-controller.ts:287-293` (`preflightToolCall`)
- **Surface:** Unattended control plane (budget accounting)

## Summary

When a session is in unattended mode, `dispatchRpcCommand` calls
`unattendedControlPlane.preflightCommand(command)` before **every** command.
`preflightCommand` unconditionally calls `controller.preflightToolCall(...)`,
which reserves one unit of the `max_tool_calls` budget:

```ts
// unattended-session.ts
preflightCommand(command: RpcCommand): void {
  if (!this.#controller) return;
  this.#controller.preflightToolCall(`${command.type} preflight`); // <-- charges EVERY command
  // …scope/action checks
}

// unattended-run-controller.ts
preflightToolCall(phase = "tool-call preflight"): void {
  this.checkWallTime(phase);
  if (this.usage.toolCalls + 1 > this.budget.max_tool_calls) {
    this.breach("tool_calls", this.budget.max_tool_calls, this.usage.toolCalls + 1, phase);
  }
  this.usage.toolCalls += 1;
}
```

So host control-plane commands — including pure reads like `get_state`,
`get_session_stats`, `get_messages` — are counted as agent tool calls. Exhausting
`max_tool_calls` triggers `breach()` → `fireAbort()`, which runs every abort hook
(abort model stream, abort bash, cancel host tools/URIs, stop workflow) and
terminates the unattended run.

## Reproduction (real `gjc --mode rpc`)

```
-> negotiate_unattended { budget.max_tool_calls: 2, scopes:["message:read"], action_allowlist:["command.message_read"] }
-> get_state   => ok
-> get_state   => ok
-> get_state   => ERR {"code":"budget_exceeded","metric":"tool_calls","limit":2,"observed":3,"phase":"get_state preflight", ... ,"abort_status":"aborting"}
-> get_state   => ERR budget_exceeded (run is now aborted; every further command re-breaches)
```

The third **read** breaches the tool-call budget and aborts the run.

## Impact

- A monitoring/orchestration host that polls `get_state` (the normal way to
  observe `isStreaming`, `contextUsage`, `queuedMessageCount`) will burn the
  budget and **abort the run** purely by observing it.
- `max_tool_calls` no longer means "the agent's tool calls"; it conflates
  host control traffic with agent work, so the budget is unusable for its stated
  purpose.
- Because the abort is fired from the synchronous breach path, the run is
  irrecoverable for the session.

## Suggested fix

Only charge the tool-call budget for operations that are actually agent tool
calls. Options:

1. Drop `preflightToolCall` from `preflightCommand` entirely and reserve the
   tool-call unit at the real tool-execution boundary (agent loop / `bash`
   command path), keeping `preflightCommand` to wall-time + scope/action checks.
2. Or, charge `preflightToolCall` only for the small set of side-effecting
   command classes (e.g. `command.bash`, `command.prompt`) and never for
   `message:read` / `control` reads.

Either way, read-only control-plane traffic must not consume — and must not be
able to abort via — the agent tool-call budget.

## Resolution

**Resolved on current `dev`.** Read-only and control-plane commands no longer consume the unattended `max_tool_calls` budget; wall-time enforcement remains active.
