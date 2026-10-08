# Managed empty-stop continuation: local verification

Card: t_4fe07272. Existing PR: https://github.com/Yeachan-Heo/gajae-code/pull/6493

Source tested: `1112a48e7b6e58b01fb3a94dc0e41f66c591a3e9`, identical to the PR head and `origin/t-4fe07272-empty-stop-followup` at inspection. Continuation branch: `t-4fe07272-empty-stop-followup-r7`. This report changes no production code, test, expected value, or skip.

## Classification

The existing stack addresses production SDK/session replay accounting, not an incorrect provider model expectation:

- The host SDK `agent_start` observer previously marked an attempt as having executed user work. The internal observer tag preserves clean replay authority; actual user handlers and context handlers still invalidate it.
- Bundled Grok provider hooks are filtered by provider before admission, so an irrelevant adapter cannot consume another provider's replay authority.
- Successful billed empty stops previously entered the legacy near-zero overflow heuristic. Session-owned overflow policy keeps those stops terminal, while zero-token typed/untyped empty stops remain explicit errors.

Local integration executes production session and SDK observer bodies over actual loopback HTTP/SSE. It verifies primary-to-fallback requests, server classification, one accepted assistant lifecycle, persisted accepted-only transcript, and single-primary nonzero usage both with and without a configured fallback tail. It does not initialize SDK WebSocket transport and is not connected-verifier evidence.

## Environment and commands

Host: Linux CLI checkout (not remote tank). Bun: 1.4.0.

Every shell command exported:

```sh
export PORT_BASE=52440
export COMPOSE_PROJECT_NAME=t-4fe07272-empty-stop-followup-r7
```

Test commands also used:

```sh
export TMPDIR="$PWD/artifacts/t-4fe07272-r7/tmp"
```

The local HTTP fixture uses port 0 (ephemeral), as permitted by task isolation. No containers, watchers, external provider calls, browser tests, cluster tests, or connected scenarios were started. Test-owned servers are stopped in test finally blocks.

| Command | Observed result |
| --- | --- |
| `bun run dev:doctor -- --worktree` before setup | Exit 1: node_modules absent, native addon unavailable |
| `bun run setup:worktree` | Exit 0: dependencies installed and Linux modern native addon built |
| `bun test packages/coding-agent/test/managed-empty-stop-local.test.ts packages/coding-agent/test/managed-empty-stop-harness.test.ts packages/coding-agent/test/sdk-lifecycle-replay-safety.test.ts packages/coding-agent/test/extensions-runner.test.ts` | Exit 0: 87 pass, 0 fail, 346 assertions, 26.32s |
| `bun test packages/coding-agent/test/agent-session-fallback-attempt-transaction.test.ts packages/coding-agent/test/agent-session-fallback-attempt-accounting.test.ts packages/agent/test/agent-loop.test.ts` | Exit 0: 89 pass, 0 fail, 415 assertions, 21.23s |
| `bun test packages/coding-agent/test/agent-session-retry-fallback.test.ts` | Exit 0: 38 pass, 0 fail, 224 assertions, 30.01s |
| `bun --cwd=packages/coding-agent run lint` | Exit 0: one file-size warning for agent-session.ts |
| `bun run lint:ts` | Exit 0: workspace lint completed; warnings retained in log |
| `bun --cwd=packages/coding-agent run check:types` | Exit 0: generated docs index and package typecheck |

Raw local logs are under `artifacts/t-4fe07272-r7/`: `focused.log`, `regression.log`, `retry-fallback.log`, `lint.log`, `lint-ts.log`. Artifacts are intentionally untracked. Native build metadata/declaration changes were generated setup output, not task fixes, and are excluded from this continuation.

The retry-fallback failures described in the existing PR body were not reproduced in this separate-file local run. This does not explain the earlier timeouts or establish that every broader combined invocation passes.

## CI and review inspection

Read PR body, comments, reviews, and check rollup before setup. The sole visible comment reported the automation rebase onto dev. There were no reviews. No failed check was present in either observed rollup; the later rollup still had Linux native-build/state-addon and RSS jobs in progress. Windows daemon safety, Darwin tab-worker smoke, public surfaces, planning/relevance, and Telegram generation guard were successful. Pending CI is not claimed passing.

The existing PR body was preserved unchanged. No push, new PR, merge, or approval was performed.

## Acceptance and tester handoff

- AC-1: local typed/untyped zero-token explicit-error and agent-loop regression checks pass.
- AC-2: local actual fallback model, replay classification, accepted-only session lifecycle and disk transcript checks pass. SDK WebSocket publication remains unverified.
- AC-3: invalid-scenario and empty argument child processes exit 1 with executed 0 in local harness tests. Local nonzero usage produces one primary and no fallback with a usable tail. The default connected five-scenario exit 0 remains unverified.

The final user scope explicitly prohibits e2e. Therefore `bun packages/coding-agent/scripts/verify-managed-empty-stop.ts` was NOT run. Do not interpret the local tests as its five-scenario PASS.

Follow-up tester work: use the tested source above (or this evidence-only continuation), export the isolation variables above, run the default connected verifier and all five individual selections, then invalid-scenario and empty-string selections. Require default executed 5/exit 0, valid individual executed 1/exit 0, and invalid/empty executed 0/nonzero exit. Preserve real SDK WebSocket plus loopback HTTP/SSE, unchanged assertions, request model sequences, lifecycle and durable transcript evidence. This is a handoff specification, not a claim that an external tester card was created.

## Self-review and assumptions

The continuation-relative diff was empty before this evidence file. Production changes and relevant acceptance tests in the existing dev-relative stack were inspected; no further local root-cause failure justified modifying them. Final continuation diff is evidence only, with no unused code, debug print, empty branch, temporary workaround, test edit, or expectation change.

Assumptions: the final local-unit/integration/lint-only instruction supersedes the earlier request to execute the connected verifier. GitHub read-only inspection and dependency/native setup are permitted prerequisites. The already-fixed stack should not receive speculative code changes solely to produce a commit. A tester handoff is recorded locally because no card-management interface or destination was specified.

## 우회: 없음

No connected acceptance was replaced or claimed passing using mocks. Existing mock-stream unit regressions were run in addition to actual HTTP/SSE integration, not as a replacement for the prohibited connected verifier.
