# 19 — RPC --listen duplicate refusal surfaces as an uncaught exception; socket-alive probe collapses all connect errors to "not alive"

- **Severity:** Low (functionally correct; presentation + probe-hardening gaps)
- **Scope:** `packages/coding-agent/src/modes/rpc/rpc-mode.ts:715-721` (thrown refusal), `packages/coding-agent/src/main.ts:980-981` (no clean boundary), `packages/coding-agent/src/modes/rpc/rpc-mode.ts:177-186` (`isUnixSocketAlive` catch-all)
- **Surface:** RPC `--listen` UDS startup guard (PR #613 / commit 679ab5ba)
- **Found by:** post-0.5.1 dogfood (G004), architect `3-ArchG004-RpcDeepInterview`

## Summary

PR #613's socket guard works: a second `gjc --mode rpc --listen <sock>` on a
live socket is refused and the first server's socket is not clobbered
(dogfood-confirmed live). Two residual gaps:

1. **Uncaught-exception presentation.** The refusal is a `throw new Error(...)`
   inside `runRpcMode` that propagates through `main` without a clean boundary,
   so the operator sees:
   `[Uncaught Exception] Error: RPC --listen refused: a live server is already listening on ...`
   instead of a deliberate stderr diagnostic + non-zero exit.

2. **Over-broad liveness probe.** `isUnixSocketAlive` returns `false` for *every*
   `Bun.connect` failure. That is correct for `ENOENT`/`ECONNREFUSED` (stale /
   no listener), but an unexpected error (e.g. `EPERM`/`EACCES`/transient) on a
   *live* socket would also be classified "not alive" → the path would be
   unlinked. The normal accepting-listener case is protected; the edge is not
   strictly fail-closed.

## Impact

Low. Functional protection (refuse + preserve live socket) holds for the normal
case. Issue 1 is operator UX / automation classification; issue 2 is a narrow
fail-closed gap for unexpected probe errors.

## Suggested fix

1. Handle the expected duplicate-listen refusal at the RPC launch boundary:
   print the message to stderr, dispose session resources, exit non-zero.
2. In `isUnixSocketAlive`, return `false` only for known stale/missing codes
   (`ENOENT`/`ECONNREFUSED`); refuse or surface unexpected probe errors before
   unlinking. Add platform-aware tests.

## Resolution

**Obsolete on current `dev`.** The RPC mode surface described by this finding has been retired; `docs/environment-variables.md` states that `--mode rpc`, `--mode rpc-ui`, and `--mode bridge` were removed. No product fix should be made against the retired path.
