# GPT-5.6 Codex preset benchmark

This report records descriptive local exact-edit evidence and the product judgments used to assign GPT-5.6 Sol, Terra, and Luna to GJC's built-in Codex-related model profiles.

## Decision summary

Built-in role assignments are product judgments. The selected TypeScript edit evidence below directly compares only bounded executor-style edits; it does not establish superiority, statistical significance, production reliability, or stability for any role.

- **Eco**: `terra:low` default, `luna:low` executor, `luna:high` planner, `terra:xhigh` critic, and `terra:high` architect.
- **Medium**: `sol:low` default, `terra:low` executor, `terra:high` planner, `sol:xhigh` critic, and `sol:high` architect.
- **Pro**: `sol:medium` default, `terra:medium` executor, `sol:high` planner, `sol:max` critic, and `sol:xhigh` architect.
- **Combos**: `opus-codex` uses the Medium Codex executor, critic, and architect roles, with the durable `anthropic/claude-sonnet-5` planner override; `codex-opencodego` uses Medium Codex default and architect roles; and `fable-opus-codex` uses Pro Codex executor and architect roles with `anthropic/claude-opus-4-8:medium` as planner.

The edit benchmark does not measure default-agent interpretation, orchestration, explanation, or routing, and it does not measure planner, architect, or critic work. Those non-executor assignments are product judgments, not benchmark findings.

## Environment

- Date: 2026-07-11
- GJC provider: local `layofflabs` OpenAI Responses-compatible endpoint
- Models: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`
- Benchmark: `packages/typescript-edit-benchmark`
- Verification: exact expected-file comparison after formatting normalization
- Required tools: at least one `read` and one `edit` call per successful sample
- Guided edits: disabled
- Attempts: one per sample

The local provider recorded zero cost. The amounts below are non-billing list-price estimates calculated from the listed rates; they are not provider charges or production-cost predictions.

| Model | Input / 1M | Output / 1M |
|---|---:|---:|
| Luna | $1.00 | $6.00 |
| Terra | $2.50 | $15.00 |
| Sol | $5.00 | $30.00 |

## Initial broad sample

The first pass used eight mutation tasks with one run per task:

- multi-location identifier replacement
- call-argument swap
- early-return removal
- `if`/`else` structural swap
- named-import swap
- duplicate-line disambiguation
- off-by-one literal correction
- optional-chain removal

| Setup | Tasks passed | Avg time/run | Input tokens | Output tokens | Est. cost |
|---|---:|---:|---:|---:|---:|
| Luna high | 6/8 | 54.8s | 2.86M | 10.8K | $2.92 |
| Luna xhigh | 7/8 | 31.2s | 784K | 6.6K | $0.82 |
| Terra high | 7/8 | 51.1s | 1.13M | 5.9K | $2.92 |
| Terra xhigh | 8/8 | 50.9s | 820K | 5.9K | $2.14 |
| Sol medium | 6/8 | 30.1s | 376K | 4.3K | $2.01 |

In this eight-task, one-attempt-per-task sample, Terra xhigh recorded 8/8 verified edits. Luna xhigh recorded 7/8; one run per task does not establish stability.

## Repeated selected-task sample

The selected pass ran four discriminating TypeScript edit tasks three times each, scheduling 12 samples per setup:

1. Remove the intended early return from a file containing several similar returns.
2. Swap the intended `if`/`else` branches without changing nearby equivalent logic.
3. Correct one specific off-by-one value among several plausible candidates.
4. Remove the intended optional chain without modifying similar occurrences.

The confirmation command shape was:

```sh
bun --cwd=packages/typescript-edit-benchmark run start \
  --model "layofflabs/<model>" \
  --thinking "<effort>" \
  --runs 3 \
  --task-concurrency 2 \
  --timeout 180000 \
  --max-turns 40 \
  --tasks "structural-remove-early-return-003,structural-swap-if-else-004,literal-off-by-one-003,access-remove-optional-chain-004" \
  --require-read-tool-call \
  --require-edit-tool-call \
  --format json
```

| Setup | Verified edits / recorded runs | Rate | Avg time | Input tokens | Output tokens | Est. list-price cost | Est. cost / verified edit |
|---|---:|---:|---:|---:|---:|---:|---:|
| Luna high | 8/12 | 66.7% | 75.2s | 3.61M | 18.9K | $3.73 | $0.47 |
| Luna xhigh | 9/12 | 75.0% | 80.5s | 6.60M | 25.0K | $6.75 | $0.75 |
| Terra high | 6/11 | 54.5% | 58.9s | 572K | 10.0K | $1.58 | $0.26 |
| Terra xhigh | 9/12 | 75.0% | 57.3s | 1.86M | 14.2K | $4.86 | $0.54 |
| Sol medium | 4/12 | 33.3% | 46.3s | 558K | 10.1K | $3.09 | $0.77 |

Terra high had one transport/ghost failure, so it has 11 recorded runs rather than 12 scheduled samples; its rate and cost per verified edit use those recorded results.

## Findings

### Terra xhigh's selected-task executor result

Across these four selected TypeScript edit tasks under the documented local setup, Terra xhigh and Luna xhigh each recorded 9/12 verified edits. Terra xhigh's reported totals were 72% fewer input tokens, 43% fewer output tokens, 28% less estimated list-price cost, and 29% less time than Luna xhigh. These descriptive results inform, but do not prove, the Terra xhigh executor assignment.

### Luna remains useful, but not as the premium executor

Luna xhigh recorded 7/8 in the broad sample and 9/12 in the selected-task sample. Luna high remains the Eco executor as a product judgment for that preset's lower-priced-family-member trade-off; these local runs do not establish a capability ceiling or production behavior.

### Terra high's product assignment

Terra high recorded 6/11 verified edits after one transport/ghost failure in the selected-task sample. Its planning and lower-stakes critic assignments are product judgments; this edit benchmark does not measure those roles.

### Sol medium's product assignment

Sol medium recorded 4/12 verified edits in the selected-task sample and was faster with fewer reported input tokens than the other listed xhigh setups. Its `codex-medium` default-agent assignment and the Sol-family architecture assignments are product judgments because the benchmark does not measure those broader roles.

### Higher effort is not automatically cheaper

The selected-task data show that Luna xhigh used more reported tokens than Luna high in this local setup. They do not establish a general cost rule for thinking effort; effort selection remains a product decision informed by model tier and role shape.

## Resulting built-in profiles

| Profile | Default | Executor | Planner | Critic | Architect |
|---|---|---|---|---|---|
| `codex-eco` | `openai-codex/gpt-5.6-terra:low` | `openai-codex/gpt-5.6-luna:low` | `openai-codex/gpt-5.6-luna:high` | `openai-codex/gpt-5.6-terra:xhigh` | `openai-codex/gpt-5.6-terra:high` |
| `codex-medium` | `openai-codex/gpt-5.6-sol:low` | `openai-codex/gpt-5.6-terra:low` | `openai-codex/gpt-5.6-terra:high` | `openai-codex/gpt-5.6-sol:xhigh` | `openai-codex/gpt-5.6-sol:high` |
| `codex-pro` | `openai-codex/gpt-5.6-sol:medium` | `openai-codex/gpt-5.6-terra:medium` | `openai-codex/gpt-5.6-sol:high` | `openai-codex/gpt-5.6-sol:max` | `openai-codex/gpt-5.6-sol:xhigh` |
| `opus-codex` | `anthropic/claude-opus-4-8:xhigh` | `openai-codex/gpt-5.6-terra:low` | `anthropic/claude-sonnet-5` | `openai-codex/gpt-5.6-sol:xhigh` | `openai-codex/gpt-5.6-sol:high` |
| `codex-opencodego` | `openai-codex/gpt-5.6-sol:low` | `opencode-go/deepseek-v4-pro` | `opencode-go/kimi-k2.6` | `opencode-go/mimo-v2.5-pro` | `openai-codex/gpt-5.6-sol:high` |
| `fable-opus-codex` | `anthropic/claude-fable-5:high` | `openai-codex/gpt-5.6-terra:medium` | `anthropic/claude-opus-4-8:medium` | `anthropic/claude-opus-4-8:high` | `openai-codex/gpt-5.6-sol:xhigh` |

## Limitations

- The benchmark measures four selected precise TypeScript source mutations in the repeated sample, not full-session planning, architecture, criticism, or default-agent quality.
- The corpus is small and intentionally adversarial; the results are descriptive, not statistically significant or a proof of general superiority, production reliability, or stability.
- Samples used a local OpenAI-compatible provider rather than OpenAI's production endpoint.
- Terra high has 11 recorded runs because one of 12 scheduled samples ended in a transport/ghost failure.
- Token accounting reflects the local transport and benchmark context construction. The provider recorded zero cost; displayed costs are rounded list-price estimates, not billing predictions.
- Model behavior can change as provider snapshots are updated.

The raw JSON reports and conversation dumps were generated under `runs/gpt-5.6-local-2026-07-11/` and `runs/gpt-5.6-confirmation-2026-07-11/`, but are not committed. The committed tables support the displayed denominators and rounded comparisons, not reconstruction of unrounded token totals or list-price estimates.
