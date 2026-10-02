### Changed

- GLM Coding Plan (`glm-zcode`) GLM-5.3 and GLM-5.3-Flash now expose the `max` thinking level on top of the existing `minimal`–`xhigh` budget ladder. These models ride the Anthropic Messages-compatible endpoint where thinking is a token budget, and the generic anthropic-messages fallback capped non-Anthropic models at `xhigh` (32768 tokens). The endpoint accepts budgets up to 65536 and reasoning volume scales with the budget, so the previous ceiling silently limited the GLM-5.3 generation.
