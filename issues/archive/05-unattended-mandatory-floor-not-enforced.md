# 05 — `MANDATORY_FLOOR_COMMAND_SCOPES` is documented/tested but never enforced

- **Severity:** Medium
- **Scope:** `packages/coding-agent/src/modes/shared/agent-wire/scopes.ts:83` (definition), `packages/coding-agent/src/modes/shared/agent-wire/unattended-run-controller.ts:155-198` (`negotiate` / constructor)
- **Surface:** Unattended control plane (scope authorization)

## Summary

`scopes.ts` declares a mandatory compliance floor:

```ts
export const MANDATORY_FLOOR_COMMAND_SCOPES: readonly BridgeCommandScope[] = ["prompt"];
```

It is asserted by unit tests (`agent-wire-scopes.test.ts`,
`bridge-conformance.test.ts`) and referenced by docs ("compliance floor remains
events + prompt"). But the runtime **never applies it**: the controller's
granted scope set is exactly the declaration, with no floor merged in:

```ts
// unattended-run-controller.ts constructor
this.scopes = new Set(declaration.scopes);   // floor is not added
```

A search shows `MANDATORY_FLOOR_COMMAND_SCOPES` is referenced only in `scopes.ts`
and two test files — never in `negotiate`, the dispatcher, or bridge mode.

## Reproduction (real `gjc --mode rpc`)

Negotiate **without** `prompt` in scopes, then try to answer a workflow gate
(`workflow_gate_response` maps to scope `prompt`):

```
-> negotiate_unattended { scopes:["message:read","control"], action_allowlist:[…] }  => ok
-> {id:"g1", type:"workflow_gate_response", gate_id:"does-not-exist", answer:true}
<= g1 | workflow_gate_response | ERR {"code":"scope_denied","scope":"prompt", ...}
```

The same host is also denied `prompt` / `steer` / `follow_up`. If the "floor"
were enforced, `prompt`-scoped commands would always be permitted.

## Impact

- A host that negotiates a deliberately narrow scope set (e.g. read + control
  for a monitoring lane) **locks itself out of answering workflow gates and
  prompting**, even though the documented contract says the prompt floor is
  always available.
- The constant + tests give a false impression that the floor is enforced; it is
  effectively dead code. This is exactly the kind of gap that makes the control
  plane "feel weak": the documented guarantee and the runtime disagree.

## Suggested fix

Decide and align on one behavior:

- **If the floor is real:** merge it during negotiation so prompt-class commands
  are always allowed:
  ```ts
  this.scopes = new Set([...declaration.scopes, ...MANDATORY_FLOOR_COMMAND_SCOPES]);
  ```
  and reflect the merged set in the returned `RpcUnattendedAccepted.scopes`.
- **If it is not real:** remove the constant + its tests + doc claims so nothing
  advertises an unenforced floor.

Cross-reference: see issue 03 (negotiation validation) — both stem from
`negotiate()` not reconciling the declaration against the scope contract.

## Resolution

**Resolved on current `dev`.** Negotiation merges the mandatory prompt scope and `command.prompt` action floor into accepted unattended declarations.
