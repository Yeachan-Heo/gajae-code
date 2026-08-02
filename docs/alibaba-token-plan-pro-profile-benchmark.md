# Alibaba Token Plan Pro profile benchmark

This note records the evidence used to add GJC's opt-in `alibaba-token-plan-pro` profile while preserving `alibaba-token-plan-balanced`. It combines provider documentation, upstream model cards, and small live GJC agent-loop probes. The measurements are descriptive, not statistically significant.

## Decision summary

| Role | Model and effort | Rationale |
|---|---|---|
| Default | `qwen3.8-max-preview:medium` | Native Responses transport and tool-loop compatibility |
| Executor | `deepseek-v4-flash-0731:max` | Strongest official agent/coding results of the three candidates and clean live edit loop |
| Planner | `glm-5.2:high` | 1M context and a distinct model family for planning |
| Critic | `glm-5.2:xhigh` | Fastest correct defect-selection probe and cross-family review of DeepSeek output |
| Architect | `qwen3.8-max-preview:xhigh` | Responses transport and 1M context for high-budget design work |

The Pro profile assigns three model families by role and raises only the high-value delegated budgets; it does not replace the provider's recommended Balanced profile.

## Environment

- Date: 2026-08-02
- GJC: 0.12.7 installed binary
- Provider: Alibaba Cloud Model Studio Token Plan Personal Edition, Singapore endpoint
- Models: `qwen3.8-max-preview`, `deepseek-v4-flash-0731`, `glm-5.2`
- Execution path: GJC CLI only; no direct provider batch script
- Attempts: one per model and task
- Coding fixture: the same Python Hamilton allocator implementation task, followed by five public and three hidden tests
- Critic fixture: the same six-candidate defect-selection prompt

## Live GJC observations

| Probe | Qwen 3.8 Max Preview | DeepSeek V4 Flash 0731 | GLM 5.2 |
|---|---:|---:|---:|
| Exact-output completion | 3.015s total, 2.511s TTFT | 1.326s total, 0.872s TTFT | 1.314s total, 1.234s TTFT |
| Read/edit allocator task | 47.901s, 6/6 tool calls, 8/8 tests | 46.614s, 6/6 tool calls, 8/8 tests | 42.063s, 7/8 initial tool calls, one recovery, 8/8 tests |
| Defect selection | Correct, 26.280s | Correct, 20.059s | Correct, 17.180s |

All three models solved the bounded coding and critic fixtures. These runs therefore support role fit and transport viability, not a broad claim that one model is universally better.

Three exploratory long-form critic runs reached an external 184-second benchmark-shell limit. That limit was not GJC's prompt deadline and was not a provider error, so those observations are not counted as model failures. GJC allows a substantially longer prompt window; high-budget delegated roles should not be downgraded solely from that shell cap.

## External evidence

DeepSeek's official V4 Flash 0731 model card reports the following agent evaluations against GLM 5.2:

| Evaluation | DeepSeek V4 Flash 0731 | GLM 5.2 |
|---|---:|---:|
| DeepSWE | 54.4 | 46.2 |
| Toolathlon-Verified | 70.3 | 59.9 |
| Agents' Last Exam | 25.2 | 23.8 |

The card's best agent configuration uses `reasoning_effort=max`, which is why the executor binding exposes and selects `max` rather than a lower alias. GLM 5.2's official card reports a 1M context window and SWE-bench Pro 62.1; the live defect-selection probe supports using it as the independent critic family.

## Transport and catalog contract

- `qwen3.8-max-preview` uses `openai-responses`.
- `deepseek-v4-flash-0731` and `glm-5.2` use `openai-completions`.
- DeepSeek V4 Flash 0731 is bundled with a 1M context window, 384K output limit, and the discrete `low`, `high`, and `max` effort set.
- Qwen 3.8 is a preview model. Its availability and behavior can change, so this assignment should be revisited if Alibaba replaces or retires the selector.

## Reproduction shape

Use normal GJC provider authentication, then select each model through GJC rather than calling the provider directly:

```sh
gjc --model alibaba-token-plan/qwen3.8-max-preview --thinking medium --no-tools -p "<exact-output prompt>"
gjc --model alibaba-token-plan/deepseek-v4-flash-0731 --thinking max --tools read,edit -p "<allocator fixture prompt>"
gjc --model alibaba-token-plan/glm-5.2 --thinking xhigh --no-tools -p "<critic fixture prompt>"
```

The raw authenticated transcripts are intentionally not committed. They may contain local paths and account-scoped runtime metadata. The table above preserves the aggregate timing, tool-call, and test outcomes used for the profile decision.

## Limitations

- One attempt per model and task is not enough to estimate reliability or statistical significance.
- The allocator and defect-selection probes do not directly measure long-horizon planning or architecture quality.
- Token Plan credit consumption was not available in GJC telemetry, so this note does not compare per-role credit cost.
- Preview selectors and provider-side model snapshots can change after publication.
- The 184-second observations are censored by the benchmark shell and do not reveal eventual completion time.

## Sources

- [Alibaba Cloud Model Studio model list](https://www.alibabacloud.com/help/en/model-studio/models)
- [Token Plan overview](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview)
- [Token Plan Personal Edition overview](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview)
- [DeepSeek V4 Flash 0731 official model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731)
- [GLM 5.2 official model card](https://huggingface.co/zai-org/GLM-5.2)
- [OpenCode Qwen/DeepSeek comparison](https://opencode.ai/data/compare/alibaba/qwen3-8-max-preview/deepseek/deepseek-v4-flash)
- [Artificial Analysis DeepSeek/GLM comparison](https://artificialanalysis.ai/models/comparisons/deepseek-v4-flash-vs-glm-5-2-non-reasoning) (different reasoning settings; directional only)
