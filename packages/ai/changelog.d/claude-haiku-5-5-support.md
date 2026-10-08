### Features

- Add Claude Haiku 5.5 to the Anthropic catalog and expose its five supported Bedrock Converse inference-profile selectors
- Haiku 5.5 features: 1M token context window, 128K max output tokens, adaptive thinking with medium default effort, vision support (text+image input)
- Pricing: $0.10/MTok input (up to 100k tokens), $0.50/MTok output, $0.01/MTok cache reads, and $0.125/MTok cache writes; prompts over 100k tokens use 5x rates
- Update autorouting fast tier default from Haiku 4.5 to Haiku 5.5
- Update web search provider default model from Haiku 4.5 to Haiku 5.5

### Fixes

- Update Claude Sonnet 5.5 cache read price from $0.20/MTok to $0.10/MTok across all providers (anthropic, amazon-bedrock, and regional variants) per Anthropic's price halving
- Align Bedrock Converse with Haiku 5.5 adaptive effort support, omit rejected sampling parameters, and exclude its Mantle-only bare model ID
- Price Anthropic 5-minute and 1-hour cache writes from reported TTL usage, including Haiku 5.5's 5x long-context rates
