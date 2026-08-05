# 13 — RPC input loop is strictly serial: a blocking command head-of-line-blocks everything (incl. aborts)

- **Severity:** High (arguably the core "control plane feels weak" defect)
- **Scope:** `packages/coding-agent/src/modes/rpc/rpc-mode.ts:529-577` (input loop `await handleCommand`), `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts` (handlers that `await`)
- **Surface:** RPC control-plane concurrency / cancellation

## Summary

The RPC input loop reads and dispatches commands **strictly one at a time**,
awaiting each handler before reading the next line:

```ts
// rpc-mode.ts
for await (const line of readLines(Bun.stdin.stream())) {
  // …parse…
  const response = await handleCommand(command);   // <-- fully awaited
  output(response);
}
```

Most handlers in `dispatchRpcCommand` are themselves `await`ed
(`bash`, `compact`, `handoff`, `login`, `steer`, `follow_up`, `branch`,
`switch_session`, `export_html`, `new_session`, …). Therefore **any command that
blocks freezes the entire control plane** — no later command is even read off
stdin, including control/cancellation commands.

The one escape hatch is that `prompt` / `abort_and_prompt` are fire-and-forget
(they kick off `session.prompt(...)` and return immediately), which is why
`abort` works *during a prompt*. But `abort_bash` does **not** get the same
treatment, so it cannot cancel a running `bash`.

## Reproduction (real `gjc --mode rpc`) — timestamped

Send `bash sleep 4`, then `abort_bash`, then `get_state`:

```
+4054ms  slow_bash (bash)        <- sleep 4 ran to completion: {cancelled:false, exitCode:0}
+4054ms  abort_it (abort_bash)   <- not processed until bash finished
+4055ms  quick (get_state)       <- also blocked for the full 4s
```

All three responses arrive together at ~4s. The `abort_bash` was useless:
`slow_bash` returned `cancelled:false`.

Other blocking cases observed:

- `login` waits forever for an OAuth callback (`onPrompt` returns a never-resolving
  promise after emitting `open_url`), so a single `login` command **permanently
  wedges** the control plane — every subsequent command (including `abort`) is
  never read. In one probe, `login` followed by `compact`/`handoff` produced
  responses **only** for `login`'s side effects; the later commands never ran.

## Impact

- **Cancellation is broken for the bash path.** `abort_bash` can never interrupt
  an in-progress `bash` — the canonical reason you'd want a cancel command.
- **A slow model call (`compact`, `handoff`) stalls the whole plane**, so a host
  cannot poll `get_state`, steer, or abort while it runs.
- **`login` can deadlock the session forever** in headless RPC use.
- This single-threaded design is the root reason the control plane "feels weak":
  the host cannot observe or steer the agent while any awaited command is in
  flight.

## Suggested fix

Decouple command intake from command execution so control/cancel commands are
never blocked:

1. Keep reading stdin while handlers run — don't `await handleCommand` inside the
   read loop; dispatch concurrently and serialize only where a command truly
   needs ordering.
2. Route fast control/cancel commands (`abort`, `abort_bash`, `abort_retry`,
   `get_state`, the mode setters) on a path that is processed even while a
   long-running command is outstanding (mirroring how `prompt`/`abort` already
   interleave).
3. Make long-running handlers (`bash`, `compact`, `handoff`) cancellable so
   `abort_bash`/`abort` actually reach them, and make `login` fail fast / be
   abortable in RPC mode instead of awaiting an interactive callback forever.

## Resolution

**Obsolete on current `dev`.** The RPC mode implementation described by this finding was retired. No new fix should target the removed stdio RPC loop; replacement control-plane behavior belongs to the current SDK surface.
