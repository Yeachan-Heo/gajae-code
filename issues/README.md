# RPC Control-Plane Dogfood Findings

These issues were found by **operating real `gjc --mode rpc` through the `gjc_rpc`
Python client** (and a raw JSONL probe) and exercising the full control-plane
command surface and sub-protocols. Each issue is scoped to the primary source
file(s) that own the defect.

Repro harness: `/tmp/gjcdf/harness.py` (Python `gjc_rpc` → real bun CLI) plus a
raw JSONL Bun probe. All findings below were verified both empirically against a
live RPC process and against the source.

## Resolution status (ralplan → ultragoal pass, on origin/dev)

Landed + verified (consensus: Architect REQUEST CHANGES → revision → Critic OKAY; `bun run check:ts` green; targeted `bun test` green; re-dogfooded on the real binary):

- **01** fixed — `dispatchRpcCommand` switch wrapped in try/catch → correlated `rpcError(id, command.type, …)`.
- **02** fixed — enum validation for thinking/steering/follow-up/interrupt setters.
- **03** fixed — `negotiate()` rejects unknown scopes/action classes (`invalid_unattended_declaration`).
- **04** fixed — read-only/control commands no longer charge `max_tool_calls` (wall-time still enforced).
- **05** fixed — mandatory floor (`prompt` scope + `command.prompt` action) merged in `negotiate()`.
- **06** fixed — `gjc_rpc` `SessionState.context_usage` (`ContextUsage` model + parse).
- **07** fixed — `gjc_rpc` typed `negotiate_unattended`/`handoff`/`login`/`get_login_providers` + models.
- **11** fixed — `docs/rpc.md` workflow-gate section reconciled to `RpcWorkflowGate`.
- **13** fixed — RPC stdin loop de-serialized: ordered commands run through a serial chain (causal order preserved) while `abort`/`abort_bash`/`abort_retry` run on an immediate fast lane; `abort_bash` now cancels a running `bash`; shutdown drains in-flight commands (bounded).
- **08** fixed — added an env-gated (`GJC_RPC_REAL_BINARY=1`) real-binary integration lane that drives actual `gjc --mode rpc` and checks the typed client against the live protocol (`context_usage`, correlated errors, negotiate floor, unknown-scope rejection); skips by default.
- **12** already fixed on dev (`$pickenv("GJC_RPC_EMIT_TITLE","PI_RPC_EMIT_TITLE")`).

Deferred (designed; tracked as follow-ups, NOT claimed fixed):

- **09** persistent/detached session, **10** session registry — architectural (own follow-up PR).

Plan + consensus artifacts: `.gjc/plans/ralplan/2026-06-13-1236-71f5/` (`pending-approval.md`).

## Cross-cutting field reports

- [2026-07-20 — RECOVA Ralplan 제어면 결함](field-reports/2026-07-20-recova-ralplan-control-plane-failures.md): `ask` provider-visible schema 불일치, 프로젝트 wrapper의 workflow 관리 명령 파손, Ralplan persistence timeout·fallback·receipt 복구 문제를 실제 작업 타임라인과 함께 기록한다.


| # | Severity | Scope (primary file) | Summary |
|---|----------|----------------------|---------|
| [01](01-command-dispatch-handler-exceptions-lose-id.md) | High | `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts` | Handler exceptions escape to the generic input-loop catch → `id` dropped, command mislabeled `parse`. Breaks request/response correlation for many commands. |
| [13](13-rpc-serial-input-loop-head-of-line-blocking.md) | High | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Input loop is strictly serial: a blocking command (`bash`, `compact`, `handoff`, `login`) head-of-line-blocks everything, so `abort_bash` cannot cancel a running bash and `login` can wedge the session forever. |
| [02](02-command-dispatch-missing-enum-validation.md) | High | `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts` | No validation for `set_thinking_level` / `set_steering_mode` / `set_follow_up_mode` / `set_interrupt_mode`; bogus values accepted with `success:true` and corrupt session state. |
| [03](03-unattended-negotiate-unvalidated-scopes-actions.md) | High | `packages/coding-agent/src/modes/shared/agent-wire/unattended-run-controller.ts` | `negotiate_unattended` accepts unknown/misspelled scopes and action classes (fail-open declaration). |
| [04](04-unattended-control-commands-consume-tool-call-budget.md) | High | `packages/coding-agent/src/modes/shared/agent-wire/unattended-session.ts` | Every RPC command (incl. read-only `get_state`) consumes the `max_tool_calls` budget; polling aborts the unattended run. |
| [05](05-unattended-mandatory-floor-not-enforced.md) | Medium | `packages/coding-agent/src/modes/shared/agent-wire/scopes.ts` | `MANDATORY_FLOOR_COMMAND_SCOPES` is defined/tested/documented but never applied in `negotiate()`; hosts omitting `prompt` scope are locked out of prompting and gate answers. |
| [06](06-gjcrpc-sessionstate-missing-contextusage.md) | Medium | `python/gjc-rpc/src/gjc_rpc/protocol.py` | `SessionState` drops `contextUsage`; the typed client gives hosts no access to context pressure. |
| [07](07-gjcrpc-missing-unattended-handoff-login-methods.md) | High | `python/gjc-rpc/src/gjc_rpc/client.py` | No typed methods for `negotiate_unattended`, `handoff`, `login`, `get_login_providers`; the unattended control plane is unreachable from the public client API. |
| [08](08-gjcrpc-tested-only-against-fake-server.md) | Medium | `python/gjc-rpc/tests/test_client.py` | The client is only tested against a hand-written fake server; real-gjc drift (06/07 etc.) goes uncaught. |
| [09](09-rpc-no-persistent-detached-session.md) | High | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` + `python/gjc-rpc/src/gjc_rpc/client.py` | No persistent/detached session: gjc exits on stdin EOF and `gjc_rpc` runs a foreground child that dies with the client. No daemon/reattach. |
| [10](10-rpc-no-session-registry.md) | High | `python/gjc-rpc/src/gjc_rpc/client.py` (new module) | No session registry to enumerate/discover/reattach running RPC sessions. |
| [11](11-docs-rpc-workflow-gate-stale-contradictory.md) | Low | `docs/rpc.md` | The first "Workflow Gate Sub-Protocol" section contradicts the source-of-truth `RpcWorkflowGate` type and the later doc section (options shape, context fields, `gate_id` format). |
| [12](12-rpc-emit-title-env-var-mismatch.md) | Low | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Code reads `PI_RPC_EMIT_TITLE`; docs document `GJC_RPC_EMIT_TITLE`. The documented variable has no effect. |
