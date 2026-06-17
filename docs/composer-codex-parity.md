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
