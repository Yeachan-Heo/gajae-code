# Cursor Composer profile tiers

This note records the evidence used to update GJC's `cursor-eco`, `cursor-medium`, and `cursor-pro` profiles. The previous profiles all selected Composer 1.5 and differed only by effort suffixes that the Cursor RPC could not transport. The measurements below are descriptive single attempts, not statistically significant rankings.

## Decision summary

| Role | Eco | Medium | Pro |
|---|---|---|---|
| Default | `composer-2.5` | `composer-2.5` | `composer-2.5-fast` |
| Executor | `composer-2.5` | `composer-2.5-fast` | `composer-2.5-fast` |
| Planner | `composer-2.5` | `composer-2.5` | `composer-2.5-fast` |
| Critic | `composer-2.5` | `composer-2.5-fast` | `composer-2.5-fast` |
| Architect | `composer-2.5` | `composer-2.5-fast` | `composer-2.5-fast` |

Eco minimizes token price. Medium retains the standard model for ordinary and planning turns while spending the Fast premium on implementation and terminal review/design roles. Pro selects Fast everywhere for users who prioritize latency over cost.

## Environment and live observation

- Date: 2026-08-02
- GJC: 0.12.8 installed binary
- Provider: Cursor authenticated `GetUsableModels` catalog and `cursor-agent` RPC
- Attempts: one per model on the same no-tools TypeScript review fixture
- Fixture requirements: concurrent start, first success, aggregate all failures, abort only losers after success, empty-input handling, and no unhandled rejections

| Model | Wall time | Review result |
|---|---:|---|
| Composer 2.5 | 41.3s | Found the specified race, aggregation, abort, empty-input, and rejection-handling defects |
| Composer 2.5 Fast | 21.9s | Found the same five primary defects; its proposed correction still aborted the successful task's own controller |

This single fixture supports the Fast model's lower observed latency, not a broad quality difference. It is enough to justify treating Fast as a latency/cost tier rather than pretending that unsupported effort suffixes create reasoning tiers.

## Pricing trade-off

Cursor documents Composer 2.5 at $0.50 input and $2.50 output per million tokens. Composer 2.5 Fast is $3 input and $15 output, a 6x token-price premium. This is why the recommended Medium profile keeps standard Composer for default and planning work instead of making Fast universal.

## Reasoning transport contract

Cursor's protobuf currently defines `ThinkingDetails` as an empty message. GJC's request construction sends `modelId`, `displayModelId`, and `displayName`; there is no strength value to populate. Authenticated discovery also exposes Composer 2.5 and Composer 2.5 Fast as non-reasoning models.

Therefore the profiles use the two exact server model IDs and remove `:minimal` through `:xhigh` suffixes. This keeps the profile preview aligned with what the RPC actually sends.

## Reproduction shape

```sh
gjc -p --model cursor/composer-2.5 --no-tools --no-skills --no-rules --no-session "<review fixture>"
gjc -p --model cursor/composer-2.5-fast --no-tools --no-skills --no-rules --no-session "<review fixture>"
```

Raw authenticated event streams are not committed because they contain account-scoped session metadata and local paths. The aggregate timings and observed defects above preserve the evidence used for the mapping.

## Limitations

- One attempt per model cannot estimate reliability or variance.
- A bounded review fixture does not directly measure long-horizon implementation, planning, or architecture quality.
- Cursor can change account-specific model availability and server aliases after publication.
- Cursor telemetry reported zero direct token cost for these subscription-routed calls, so pricing comes from Cursor's published model page.

## Sources

- [Cursor Composer 2.5 documentation](https://cursor.com/docs/models/cursor-composer-2-5)
- Cursor authenticated `GetUsableModels` response, observed through `gjc --list-models cursor` on 2026-08-02
- GJC Cursor protobuf and request construction in `packages/ai/src/providers/cursor/`
