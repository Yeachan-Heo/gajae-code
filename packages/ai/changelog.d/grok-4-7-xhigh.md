### Fixed

- Direct `xai/grok-4.7` now advertises `reasoning_effort=xhigh`. xAI documents `xhigh` for grok-4.6 and later, but the thinking policy treated only grok-4.6 as xhigh-capable and clamped grok-4.7 to high, so the model picker could not select it.
