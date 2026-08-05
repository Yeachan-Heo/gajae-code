# 07 — `gjc_rpc` exposes no typed method for the unattended control plane (and `handoff`/`login`)

- **Severity:** High
- **Scope:** `python/gjc-rpc/src/gjc_rpc/client.py`
- **Surface:** `gjc_rpc` typed client API

## Summary

The protocol supports `negotiate_unattended`, `handoff`, `login`, and
`get_login_providers`, but the public `RpcClient` has **no typed methods** for
any of them. A search of `python/gjc-rpc/src/gjc_rpc` for `negotiate`,
`def handoff`, `def login`, `get_login_providers` returns **no matches**.

The most important gap is `negotiate_unattended`: it is the single entry point to
the entire budget/scope/action-authorization control plane (issues 03–05), yet a
Python host can only reach it by calling the **private** `_request(...)` and
hand-rolling the declaration and the typed `RpcUnattendedAccepted` /
`scope_denied` / `action_denied` / `budget_exceeded` payloads itself.

The client otherwise has good coverage (`set_steering_mode`,
`set_interrupt_mode`, `compact`, `branch`, `switch_session`, `respond_gate`,
`run_workflow_gate_policy`, etc.), which makes the missing unattended surface
conspicuous.

## Impact

- The headline "fail-closed unattended operation" feature is effectively
  unreachable from the supported client API. Hosts must depend on a private
  method and untyped dicts, defeating the purpose of a typed binding.
- No typed models are surfaced for the negotiation result or the typed
  refusal/denial/budget payloads, so even the raw `_request` path gives the host
  no typed handling of `scope_denied` / `action_denied` / `budget_exceeded`.
- `handoff` and `login` / `get_login_providers` are likewise unreachable as
  typed calls.

## Suggested fix

Add typed methods + models:

```python
def negotiate_unattended(self, declaration: UnattendedDeclaration) -> UnattendedAccepted: ...
def handoff(self, custom_instructions: str | None = None) -> HandoffResult | None: ...
def get_login_providers(self) -> tuple[LoginProvider, ...]: ...
def login(self, provider_id: str) -> str: ...
```

with dataclasses for `UnattendedDeclaration` / `UnattendedBudget` /
`UnattendedAccepted`, and typed exceptions (or result variants) for
`scope_denied`, `action_denied`, and `budget_exceeded` so hosts can react to the
control-plane refusals programmatically.

## Resolution

**Resolved on current `dev`.** The typed Python client now exposes unattended negotiation, handoff, login, and login-provider methods with corresponding models.
