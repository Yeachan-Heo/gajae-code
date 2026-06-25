# Composer 2.5 Fast parity repro

This document records the one-command repros for the Composer 2.5 Fast stability work. Scope is GJC-local only: no OpenClaw reference, no Cursor live e2e, no upstream xAI/server change, and no Codex refactor. Codex is the baseline/report model only.

## Focused discipline regression

```sh
bun test packages/ai/test/composer-discipline.test.ts
```

Expected contract:

- `grok-build/grok-composer-2.5-fast` and other composer ids receive `COMPOSER_EDIT_DISCIPLINE_PROMPT` ahead of host/default system prompts on the `openai-completions`, `openai-responses`, and Cursor RPC prompt paths.
- Non-composer models keep their system prompt payload unchanged.
- The prompt explicitly covers adversarial shell file discovery, shell file reads, out-of-band shell writes, fabricated/stale anchors, malformed tool arguments, and contaminated bash command strings.

## V3 mock P1 gate

```sh
bun packages/agent/bench/composer-stability-v3.ts --mock --seed 42 -n 5 --model grok-build/grok-composer-2.5-fast --baseline-model openai-codex/gpt-5.5:low
```

Equivalent package script:

```sh
bun run bench:composer-stability-v3
```

P1 passes when `candidateFailureCount <= baselineFailureCount` over the same deterministic scenario matrix. Mock mode is a smoke gate, not live parity proof.

## V3 trace-backed gate

```sh
bun packages/agent/bench/composer-stability-v3.ts --trace --trace-file packages/agent/test/fixtures/composer-stability-v3/traces/parity.json
```

Equivalent package script:

```sh
bun run bench:composer-stability-v3:trace
```

Trace files can be JSON, JSON arrays, JSON `{ "records": [...] }`, or JSONL. Each record declares `scenarioId`, `modelRole` (`candidate` or `baseline`), `model`, `trial`, optional `expected`, and `events`. The classifier maps recorded tool behavior to failure classes:

- `shell-read`
- `shell-file-discovery`
- `shell-write`
- `contaminated-command`
- `bad-anchor-unrecovered`
- `malformed-tool-args-unrecovered`
- `sanitize-replay-regression`
- `wrong-file-edit`
- `missing-tool-turn`
- `timeout`

Trace P1 is applicable only when both candidate and baseline records exist, and it can pass only with at least three comparable candidate/baseline scenario ids so a one-scenario smoke cannot fake parity. It reports `candidateFailureCount`, `baselineFailureCount`, `parityDelta`, per-scenario counts, and the trace artifact paths that were scored.

Trace replay is frozen-artifact evidence. It can support an L2 claim only when the generated evidence report has `l2Eligible=true`; it must not be described as live K>=3 proof or L3 evidence. Historical A/B output is a point estimate with `comparison_kind="historical-frozen-trace"` and should be worded as frozen-trace comparison, not current live head-to-head parity.

## Optional live smoke

```sh
bun packages/agent/bench/composer-stability-v3.ts --live -n 3 --model grok-build/grok-composer-2.5-fast --baseline-model openai-codex/gpt-5.5:low
```

Live smoke is informational. Without `GROK_CLI_OAUTH_TOKEN` and Codex/OpenAI credentials, or without trace artifacts from a real capture, `--live` exits successfully with an explicit skip record and `p1.applicable=false`; it does not fake a P1 pass. Pass `--live --trace-dir <captured-traces>` to score real captured runs through the same trace classifier. Cursor live e2e is intentionally out of scope.

## Broader local verification

```sh
bun test packages/agent/test/composer-stability-v3.test.ts packages/coding-agent/test/grok-cli-sanitize.test.ts packages/coding-agent/test/grok-build-stream.test.ts
bun test packages/agent packages/ai
bun scripts/verify-g002-gates.ts
```

Use `mise x bun@1.3.14 -- <command>` when `bun` is not on `PATH`.

## Evidence ladder and claim gates

- `MIN_COMPARABLE_TRACE_SCENARIOS` = 3 — P1 anti-fake-pass for trace scoring.
- `L2_MIN_SCENARIO_COVERAGE` = 10 — public **L2** claim requires `l2Eligible=true` on `evidence-report.json`, with P1 applicable and passing.
- `L3_MIN_TRIALS_PER_ARM` = 3 — public **L3** claim requires `l3Eligible=true`, `min_k_per_scenario_role >= 3`, full planned/captured parity, bound trace+manifest hashes, stable single model id per role, and no `l3RefusalReasons`.
- Scenarios + frozen prompts: `packages/agent/bench/composer-scenarios.ts` (`COMPOSER_SCENARIOS_VERSION=v2`, 18 scenarios). Historical v1 replay artifacts remain scoped to the 13-scenario v1 subset through `composerScenariosForVersion("v1")`.

Claim wording rules:

- P1 is a deterministic or trace-backed parity gate, not public parity proof by itself.
- L2 wording is allowed only from the emitted fields: `ladderMaxClaim` is `L2` or higher, `l2Eligible=true`, scenario coverage satisfies the report's versioned denominator, and `parityDelta <= 0`.
- L3 wording is allowed only when `l3Eligible=true` and `l3RefusalReasons` is empty. Any `trace_replay_not_l3`, `k_lt_3`, `partial_capture`, `mixed_model_ids`, or `manifest_linter_failed` reason blocks an L3 claim.
- `capture_mode="trace-replay"` and `comparison_kind="historical-frozen-trace"` must be called frozen replay evidence. They cannot be called live A/B, K>=3 live evidence, or Codex GPT-5.5-level parity proof.
- Synthetic reports are schema/mechanics proofs only; they are not live Composer-vs-Codex evidence even when they are L3-eligible.
- Changes that alter Composer prompt injection or live-provider behavior should be reported as `OWNER_CONFIRMATION_REQUIRED` after technical gates pass; do not call those PRs `MERGE_READY` without owner confirmation.

```sh
bun packages/agent/bench/capture-composer-v3-live.ts --dry-run
bun packages/agent/bench/capture-composer-v3-live.ts --run --k 3 --out .gjc/ultragoal/artifacts/composer-evidence-<run-id>
bun packages/agent/bench/composer-evidence-report.ts --trace-file packages/agent/test/fixtures/composer-stability-v3/traces/parity.json --out /tmp/evidence-report.json
bun test packages/agent/test/composer-evidence.test.ts
```
