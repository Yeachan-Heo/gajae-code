### Fixed

- Claude Sonnet 5.5 cache reads on the direct Anthropic API and Bedrock are priced at 0.05x input ($0.10/MTok, $0.11 for the regional premium) instead of Sonnet 5's $0.20, so usage cost totals no longer overstate Sonnet 5.5.
