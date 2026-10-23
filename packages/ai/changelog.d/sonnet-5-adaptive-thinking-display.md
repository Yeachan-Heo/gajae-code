### Fixed

- Anthropic Sonnet 5 and later now send adaptive `thinking.display: "summarized"`, matching Opus 4.7+, Fable and Haiku 5+. They default `display` to `"omitted"`, so without the opt-in thinking tokens were billed but no thinking content streamed back.
