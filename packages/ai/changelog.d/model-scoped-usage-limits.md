### Fixed

- A usage limit that is scoped to one model (an explicit `scope.modelId`, or a model-family tier such as Claude's `opus`/`sonnet`) no longer takes the whole credential out of rotation. The block is recorded for that model only, ranking ignores limits scoped to other models, and callers that do not know the requested model keep the previous conservative behaviour. Plan and quota tiers (`Codex`/`Copilot` plans, Gemini quota tiers) still apply to every model.
