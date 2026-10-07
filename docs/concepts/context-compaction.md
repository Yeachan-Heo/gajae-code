# Context Compaction

GJC compacts conversation context when the current context token count crosses the configured compaction threshold. By default, adaptive compaction is off and the reserve-based auto-compaction threshold is capped at 300,000 tokens; an active opt-in context promotion uses the promoted model's uncapped reserve-based threshold.

## Static Threshold Tuning

Use `compaction.thresholdPercent` to compact earlier or later:

```bash
gjc config set compaction.thresholdPercent 70
```

Or set the same value in `config.yml`:

```yaml
compaction:
  thresholdPercent: 70
```

`compaction.thresholdTokens` takes priority over percentage settings when it is greater than zero. With adaptive mode disabled, the default percentage sentinel `-1` uses a reserve-based auto-compaction threshold capped at 300,000 tokens: `min(contextWindow - max(15% of contextWindow, compaction.reserveTokens), 300,000)`. Automatic compaction does not reserve a separate model max-output budget. While opt-in context promotion is active, the promoted model instead uses its uncapped reserve-based threshold to benefit from the larger context window. Explicit token and percentage thresholds are not capped. With adaptive mode enabled, `compaction.adaptive.baseThresholdPercent` is the adaptive base, including when `thresholdPercent` remains at its `-1` sentinel; the adaptive base is then lowered only when its context and call-rate conditions are met and is not capped at 300,000 tokens.

## Adaptive Compaction

Adaptive compaction lowers the effective threshold when context is already large and many calls happen in a short window. This targets long sessions where a 150K-230K context can otherwise be resent many times before hitting the static threshold.

Recommended local starting point for long, tool-heavy sessions:

```yaml
compaction:
  adaptive:
    enabled: true
    baseThresholdPercent: 75
    aggression: 0.2
    turnWindow: 15
    minThresholdPercent: 50
```

The adaptive threshold uses both context fill and call rate. When context is in the high band and recent calls are dense, `aggression` lowers the threshold toward `minThresholdPercent`. The policy is applied at post-turn, pre-prompt, and cooperative mid-run maintenance boundaries. The call window is a bounded tumbling window, and successful automatic or manual compaction resets it. Immediately after a compaction, the threshold returns to the base level for three turns to avoid repeated re-compaction.

Leave `compaction.adaptive.enabled` as `false` for exact legacy behavior. The shipped default remains off for backward compatibility.
