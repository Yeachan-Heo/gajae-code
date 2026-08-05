# 06 — `gjc_rpc` `SessionState` drops `contextUsage`

- **Severity:** Medium
- **Scope:** `python/gjc-rpc/src/gjc_rpc/protocol.py:681-699` (`SessionState`), `:1181-1214` (`parse_session_state`)
- **Surface:** `gjc_rpc` typed client

## Summary

The server's `get_state` payload includes `contextUsage` (documented in
`docs/rpc.md` and emitted by `dispatchRpcCommand`'s `get_state` handler via
`session.getContextUsage()`):

```json
"contextUsage": { "tokens": 0, "contextWindow": 200000, "percent": 0 }
```

But the Python `SessionState` dataclass has no field for it and
`parse_session_state` never reads `payload["contextUsage"]`. The data is
silently discarded.

## Reproduction

Against real `gjc --mode rpc`:

```python
st = client.get_state()
st.context_usage          # AttributeError: 'SessionState' object has no attribute 'context_usage'
```

Raw server frame (same session) **does** carry it:

```json
{ "command":"get_state","success":true,"data":{ … ,"contextUsage":{"tokens":0,"contextWindow":200000,"percent":0}}}
```

## Impact

- A Python host cannot read context pressure (token usage / percent of context
  window) through the typed client — exactly the signal an orchestrator needs to
  decide when to compact or hand off. The only field surfaced is whether
  `auto_compaction_enabled` is set.
- This is a silent client/server drift: the field exists on the wire and in the
  docs but is invisible to client code.

## Suggested fix

Add a typed `ContextUsage` model and field:

```python
@dataclass(slots=True, frozen=True)
class ContextUsage:
    tokens: int
    context_window: int
    percent: float

@dataclass(slots=True, frozen=True)
class SessionState:
    # …existing fields…
    context_usage: ContextUsage | None = None
```

and parse it in `parse_session_state`:

```python
cu = payload.get("contextUsage")
context_usage = ContextUsage(
    tokens=int(cu.get("tokens", 0)),
    context_window=int(cu.get("contextWindow", 0)),
    percent=float(cu.get("percent", 0)),
) if isinstance(cu, dict) else None
```

This drift was only observed because the client was driven against real gjc
rather than the fake test server — see issue 08.

## Resolution

**Resolved on current `dev`.** The Python RPC client exposes typed `SessionState.context_usage` parsing for the wire-level `contextUsage` payload.
