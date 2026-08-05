# 01 — RPC handler exceptions lose request `id` and mislabel the command as `parse`

- **Severity:** High
- **Scope:** `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts` (`dispatchRpcCommand`), `packages/coding-agent/src/modes/rpc/rpc-mode.ts:541-576` (input loop catch)
- **Surface:** RPC control plane (request/response correlation)

## Summary

`dispatchRpcCommand` runs almost every command handler with **no per-command
try/catch**. When the underlying `session.*` call throws (missing/invalid
payload, not-found, in-memory session, etc.), the exception propagates out of
`dispatchRpcCommand`, is caught by the generic input-loop catch in `rpc-mode.ts`,
and is emitted as:

```json
{ "type": "response", "command": "parse", "success": false,
  "error": "Failed to parse command: <message>" }
```

with **`id: undefined`**. The caller's request `id` is dropped and the real
command name is replaced by `"parse"`. A host using id correlation cannot match
the failure to its request, and cannot tell which command failed.

Only 6 of ~40 handlers guard their errors and return a correlated
`rpcError(id, command.type, …)`: `set_host_uri_schemes`, `set_model`,
`set_session_name`, `login`, `negotiate_unattended`, `workflow_gate_response`.
Everything else throws raw.

## Reproduction (real `gjc --mode rpc`)

Each command below carries an `id`, but the error comes back with `NO-ID` and
`command: "parse"`:

```
{id:"c6", type:"bash"}                                   -> NO-ID | parse | "Missing field `command`"
{id:"c7", type:"set_todos"}                              -> NO-ID | parse | "undefined is not an object (evaluating 'phases.map')"
{id:"sw1",type:"switch_session",sessionPath:"/no.jsonl"} -> NO-ID | parse | "File not found: /no.jsonl"
{id:"br1",type:"branch",entryId:"x"}                     -> NO-ID | parse | "Invalid entry ID for branching"
{id:"exp1",type:"export_html",outputPath:"/o.html"}      -> NO-ID | parse | "Cannot export in-memory session to HTML"
{id:"n1", type:"set_session_name"}                       -> NO-ID | parse | "undefined is not an object (evaluating 'command.name.trim')"
{id:"ht2",type:"set_host_tools",tools:[{name:""}]}       -> NO-ID | parse | "Host tool at index 0 must provide a non-empty name"
{id:"ht3",type:"set_host_tools",tools:[{name:"read"}]}   -> NO-ID | parse | "RPC host tool \"read\" conflicts with an existing tool"
```

Contrast with the guarded handlers, which correlate correctly:

```
{id:"c5", type:"set_model", provider:"anthropic", modelId:"nope"} -> c5 | set_model | "Model not found: anthropic/nope"
{id:"hu3",type:"set_host_uri_schemes",schemes:[{scheme:"a b"}]}   -> hu3 | set_host_uri_schemes | "...invalid characters: a b"
```

## Impact

- **Broken correlation.** Any host that pipelines commands (multiple in flight)
  cannot route the failure. The `gjc_rpc` Python client only survives this
  because it is single-flight and falls back to "if exactly one request is
  pending and command==parse, resolve it"
  (`client.py:_deliver_correlated_error_response`) — but even then it surfaces
  `RpcCommandError(command="parse")`, hiding which command failed.
- **`set_host_tools` is inconsistent with `set_host_uri_schemes`** (its sibling
  handler), which already does this correctly.
- Routine, recoverable validation errors are reported as if the JSON itself
  failed to parse, which is misleading for operators.

## Root cause

`dispatchRpcCommand` lets handler exceptions escape; the only safety net is the
input-loop catch that has no access to the originating `id`/command:

```ts
// rpc-mode.ts
} catch (err) {
  output(error(undefined, "parse", `Failed to parse command: ${decodeError(err)}`));
}
```

## Suggested fix

Wrap the dispatch body so any escaping error is returned as a correlated,
correctly-labeled failure, e.g. in `dispatchRpcCommand`:

```ts
const id = command.id;
try {
  switch (command.type) { /* … */ }
} catch (err) {
  return rpcError(id, command.type, serializeRpcDispatchError(err));
}
```

Keep the input-loop catch only for genuine pre-dispatch failures (it already
handles `JSON.parse`). This makes every routable command return
`{ id, command: <type>, success: false, error }` and removes the special-case
guards now scattered across individual handlers.

## Resolution

**Resolved on current `dev`.** Dispatch exceptions now produce correlated command-specific RPC errors, and the real-binary RPC integration lane covers the behavior.
