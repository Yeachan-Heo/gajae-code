# 02 — Mode/level setters accept invalid values and silently corrupt session state

- **Severity:** High
- **Scope:** `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts:246-272`
- **Surface:** RPC control plane (`set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`)

## Summary

The dispatcher forwards `command.level` / `command.mode` straight to the session
setters with **no validation**, and the setters do not validate either. Bogus
values are accepted with `success: true` and overwrite the live session state.
A subsequent `get_state` returns the garbage value, and any consumer that
branches on these enums (queue dequeue policy, interrupt timing, thinking
budget) sees an out-of-contract value.

```ts
case "set_thinking_level": { session.setThinkingLevel(command.level); return rpcSuccess(id, "set_thinking_level"); }
case "set_steering_mode":  { session.setSteeringMode(command.mode);   return rpcSuccess(id, "set_steering_mode"); }
case "set_follow_up_mode": { session.setFollowUpMode(command.mode);   return rpcSuccess(id, "set_follow_up_mode"); }
case "set_interrupt_mode": { session.setInterruptMode(command.mode);  return rpcSuccess(id, "set_interrupt_mode"); }
```

## Reproduction (real `gjc --mode rpc`)

```
-> {id:"s1", type:"set_thinking_level", level:"BOGUS-LEVEL"}   => ok=true
-> {id:"s2", type:"set_steering_mode",  mode:"BOGUS-MODE"}     => ok=true
-> {id:"s3", type:"set_follow_up_mode", mode:""}               => ok=true
-> {id:"s4", type:"set_interrupt_mode", mode:12345}            => ok=true
-> {id:"chk",type:"get_state"}

get_state.data:
  thinkingLevel  => undefined        (was "high")
  steeringMode   => "BOGUS-MODE"
  followUpMode   => ""
  interruptMode  => 12345
```

The thinking level is now `undefined`, the queue modes hold arbitrary
strings/numbers, and `interruptMode` is a number. None of these are members of
their declared unions (`ThinkingLevel`, `"all" | "one-at-a-time"`,
`"immediate" | "wait"`).

## Impact

- State corruption with a success response — the host has no signal anything
  went wrong.
- Downstream code that switches on these enums hits unhandled values; e.g. an
  `interruptMode` of `12345` is neither `"immediate"` nor `"wait"`.
- The control plane advertises typed enums (`rpc-types.ts`) but does not enforce
  them at the boundary.

## Suggested fix

Validate against the known sets in the dispatcher (or the session setters) and
return a correlated `rpcError` on a miss, mirroring how `set_model` rejects an
unknown model:

```ts
const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh"] as const;
if (!THINKING_LEVELS.includes(command.level)) {
  return rpcError(id, "set_thinking_level", `Invalid thinking level: ${String(command.level)}`);
}
```

Apply the same guard for `steeringMode`/`followUpMode` (`all` | `one-at-a-time`)
and `interruptMode` (`immediate` | `wait`).

## Resolution

**Resolved on current `dev`.** The RPC dispatcher validates thinking, steering, follow-up, and interrupt mode values before applying them.
