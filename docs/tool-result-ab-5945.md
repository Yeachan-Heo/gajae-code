# Live tool-result A/B (#5945)

Issue #5945 measured 4.17B characters of tool results across 15,936 sessions: `read` produced 63.9% and `search` 21.8%, and 21% of reads named a bare path. It asked for a live A/B (not fixture replay) of the inline-result candidates, with the acceptance rule **lower tool-result chars per task, unchanged task success**.

## Harness

`bun run bench:tool-results:live` (`packages/orchestration-token-benchmark/src/tool-result-ab-live.ts`) runs real model turns through the same in-process `createAgentSession` path the CLI uses. It is manual and NON-CI because it spends provider tokens.

- Corpus (`tool-result-ab-corpus.ts`): 8 generated ~27 KB TypeScript modules and a 400-line TOML config, with five planted facts. The traffic shape matches the issue: bare-path reads larger than the 10 KB receipt budget, plus identifiers repeated across files that invite wide search fan-out.
- Each task/repeat runs the baseline and candidate arms back to back in fresh temp workspaces with `read`, `search`, `find`, and `bash` enabled. Settings overrides apply per arm through `Settings.override`, and unknown keys are rejected before any tokens are spent.
- Measurement (`tool-result-ab.ts`): the sum of `toolResult` text characters the model received, per tool. Success means the final answer contains the planted value as a standalone token. A provider-errored run makes the verdict `inconclusive`, so it can never count as a zero-char win.

```sh
bun run bench:tool-results:live -- --model <pattern> --baseline '{"tools.maxInlineResultBytes":0}' \
  --candidate '{"tools.maxInlineResultBytes":12}' --repeats 3 --out /tmp/ab
```

Pin the baseline explicitly. Arms that resolve to identical settings are rejected, because any delta between them is sampling noise.

## Results (2026-09-25, 5 tasks × 3 repeats per arm)

Baseline is current `dev` defaults (`tools.maxInlineResultBytes = 0`).

| Candidate | Model | Success (base → cand) | Tool-result chars/task | Reduction |
| --- | --- | --- | ---: | ---: |
| `tools.maxInlineResultBytes = 12` | claude-haiku-4-5 | 15/15 → 15/15 | 5,001 → 3,297 | 34.1% |
| `tools.maxInlineResultBytes = 12` | gpt-5.5 | 15/15 → 15/15 | 7,398 → 3,218 | 56.5% |
| `tools.maxInlineResultBytes = 12` | gpt-5.6-luna | 15/15 → 15/15 | 13,124 → 6,551 | 50.1% |
| `tools.maxInlineResultBytes = 8` | claude-haiku-4-5 (two runs) | 15/15 → 15/15 | 5,814 → 3,008; 5,000 → 2,583 | 48.3%; 48.4% |
| `tools.maxInlineResultBytes = 8` | gpt-5.5 | 15/15 → 15/15 | 7,398 → 2,479 | 66.5% |
| `tools.maxInlineResultBytes = 8` | gpt-5.6-luna | 15/15 → 15/15 | 12,903 → 4,829 | 62.6% |
| `tools.maxInlineResultBytes = 8` | claude-sonnet-4-6 | 15/15 → 15/15 | 871 → 871 | 0% (already uses selectors) |
| `read.summaryMaxBytes = 8` / `12` | claude-haiku-4-5 | 15/15 → 15/15 | 5,003 → 3,339 / 5,110 → 3,370 | 33% / 34% |
| `read.summaryMaxBytes = 12` | gpt-5.5 | 15/15 → 15/15 | 8,773 → 8,229 | 6.2% |
| `read.summaryMaxBytes = 12` | claude-sonnet-4-6 | 15/15 → 15/15 | 871 → 871 | 0% |
| `search.contextBefore = 0`, `search.contextAfter = 1` | claude-haiku-4-5 / claude-sonnet-4-6 | 15/15 → 15/15 | 5,001 → 6,526 / 871 → 887 | −30.5% / −1.8% |
| `read.receiptBudgetLines = 30`, `read.receiptBudgetBytes = 5` | claude-haiku-4-5 | 15/15 → 15/15 | 5,001 → 4,881 | 2.4% |

## Decision

- **Applied:** `tools.maxInlineResultBytes` default `0 → 12` KB. It cut tool-result chars per task by 34–57% on three models from two providers, with no lost task (45/45 → 45/45). On a model that already reads with selectors it changes nothing. The backstop keeps head and tail inline and saves the full text as an `artifact://` reference, so nothing becomes unrecoverable. 12 KB sits just above the 10 KB bare-read receipt budget, so ordinary receipts pass through untouched.
- **Not applied:** tighter search context. Trimming match context made models issue more follow-up reads and increased total tool-result volume.
- **Not applied:** tighter bare-read receipt budgets. The saving was within run-to-run noise.
- **Not applied:** `read.summaryMaxBytes`. Its effect overlaps the inline cap and was model-dependent (6% on gpt-5.5).
- `tools.readArtifactSpillThreshold` is unchanged. It only covers explicit selector reads above 256 KB, which the inline cap already bounds.
