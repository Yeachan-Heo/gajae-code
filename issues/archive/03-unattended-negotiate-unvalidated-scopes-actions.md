# 03 — `negotiate_unattended` accepts unknown/misspelled scopes and action classes

- **Severity:** High (security-relevant fail-open)
- **Scope:** `packages/coding-agent/src/modes/shared/agent-wire/unattended-run-controller.ts:169-198` (`UnattendedRunController.negotiate`)
- **Surface:** Unattended control plane (`negotiate_unattended`)

## Summary

`negotiate()` validates the *types* of `scopes` and `action_allowlist` (must be
`string[]`) but not their *membership*. Unknown or misspelled scope strings and
action classes are accepted and stored verbatim in the granted sets:

```ts
if (!Array.isArray(d.scopes) || !d.scopes.every(s => typeof s === "string")) { /* refuse */ }
if (!Array.isArray(d.action_allowlist) || !d.action_allowlist.every(s => typeof s === "string")) { /* refuse */ }
// …no check that entries are in BRIDGE_COMMAND_SCOPES / RpcUnattendedActionClass
this.scopes = new Set(declaration.scopes);
this.actionAllowlist = new Set(declaration.action_allowlist);
```

The contract defines a refusal code `invalid_unattended_declaration` and a fixed
taxonomy (`BRIDGE_COMMAND_SCOPES` in `scopes.ts`, `RpcUnattendedActionClass` in
`rpc-types.ts`), but membership is never enforced.

## Reproduction (real `gjc --mode rpc`)

```
-> {id:"u2", type:"negotiate_unattended", declaration:{
     actor:"x",
     budget:{max_tokens:1000,max_tool_calls:10,max_wall_time_ms:60000,max_cost_usd:1},
     scopes:["not-a-real-scope"],
     action_allowlist:["bogus.action"]
   }}
<= u2 | negotiate_unattended | ok=true
   data.scopes = ["not-a-real-scope"], data.action_allowlist = ["bogus.action"]
```

The run is accepted and the audit trail records a grant for capabilities that do
not exist in the taxonomy.

## Impact

- **Fail-open declaration.** A host that typos `"message:read"` as
  `"messages:read"`, or `"bash.readonly"` as `"bash:readonly"`, gets a
  `success` negotiation. The mistyped scope then never matches any command
  (`authorizeScope` compares against the real `scopeForRpcCommand` values), so
  the host is silently *under*-authorized — or, for action classes, silently
  believes it granted something it did not.
- The accepted envelope and audit log advertise a capability set that does not
  correspond to anything the enforcer recognizes, undermining auditability of a
  zero-human run.
- It is inconsistent with the otherwise fail-closed posture of this subsystem
  (budget is strictly validated; provider token/cost capability is required).

## Suggested fix

In `negotiate()`, reject declarations whose scope or action entries are not in
the known taxonomies, surfacing `invalid_unattended_declaration`:

```ts
const unknownScopes = d.scopes.filter(s => !BRIDGE_COMMAND_SCOPES.includes(s as BridgeCommandScope));
if (unknownScopes.length) {
  throw new UnattendedNegotiationError("invalid_unattended_declaration", `unknown scopes: ${unknownScopes.join(", ")}`);
}
const unknownActions = d.action_allowlist.filter(a => !RPC_UNATTENDED_ACTION_CLASSES.includes(a));
if (unknownActions.length) {
  throw new UnattendedNegotiationError("invalid_unattended_declaration", `unknown action classes: ${unknownActions.join(", ")}`);
}
```

(Export a runtime `RPC_UNATTENDED_ACTION_CLASSES` array alongside the
`RpcUnattendedActionClass` type for the membership check.)

## Resolution

**Resolved on current `dev`.** Unrecognized unattended scopes and action classes are rejected during negotiation with `invalid_unattended_declaration`.
