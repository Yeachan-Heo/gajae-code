### Fixed

- Bundled `openai/gpt-image-2.6-sunburst` and `openai/gpt-image-2.6-flare` image generation posts to `/v1/images/generations`. Those model pages do not support `v1/responses`, so the previous Responses request produced no image. The Codex route is unchanged.
