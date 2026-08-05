# 08 — `gjc_rpc` is only tested against a hand-written fake server, never real gjc

- **Severity:** Medium (test/coverage gap that hides real bugs)
- **Scope:** `python/gjc-rpc/tests/test_client.py` (`FAKE_SERVER`), and the test suite generally
- **Surface:** `gjc_rpc` integration fidelity

## Summary

`test_client.py` drives `RpcClient` against `FAKE_SERVER`, a Python
re-implementation of the protocol embedded as a string. The real
`gjc --mode rpc` binary is never exercised by the client tests. The fake server
defines its own `current_state()`, `model_info()`, event framing, etc., so it
only reflects what the test author believed the protocol to be — not what gjc
actually emits.

This is the root reason the drift in issues 06 and 07 went unnoticed:

- The fake server's state payload was written without `contextUsage`, so the
  client's missing `context_usage` field never failed a test.
- There is no negotiate/handoff/login method to test, so their absence is
  invisible.
- Server-side error behaviors (e.g. id-less `parse` errors from handler
  exceptions, issue 01) are modeled by the fake however the author chose, not
  how gjc behaves.

## Impact

- Client/server contract drift is structurally undetectable: the two sides can
  diverge arbitrarily and the suite stays green.
- The package ships typed bindings whose fidelity to the real binary is unproven.

## Suggested fix

Add at least a thin **real-binary** integration lane that the dogfood harness
already demonstrates is feasible:

- Launch the real CLI (`command=["bun", "packages/coding-agent/src/cli.ts",
  "--mode","rpc", …]` with `--no-session --no-skills --no-rules`) under an env
  guard / marker so it can be skipped where bun is unavailable.
- Cover the no-model-required surface end-to-end: `get_state` (assert
  `contextUsage` round-trips), `set_todos`, `get_available_models`,
  `set_thinking_level`, queue-mode setters, `bash`, `set_host_tools`,
  `set_host_uri_schemes`, `negotiate_unattended`, and `workflow_gate_response`.
- Keep the fast `FAKE_SERVER` unit tests, but treat the real-binary lane as the
  contract guard.

Reference harness used for these findings: `/tmp/gjcdf/harness.py`.

## Resolution

**Resolved on current `dev`.** An environment-gated real-binary integration lane now exercises the typed client against the live RPC surface while retaining fast fake-server unit tests.
