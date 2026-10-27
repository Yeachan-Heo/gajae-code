### Fixed

- Fix OpenRouter long-context pricing discovery: extract `pricing.overrides` from OpenRouter's `/api/v1/models` response and map to model long-context tier, preserving discovered rates through model normalization. Remove hard-coded `OPENROUTER_BATCH_PRICING` table that disagreed with OpenRouter's actual pricing.
