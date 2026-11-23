### Fixed

- IRC-sourced steering exchanges are now deferred to the next natural tool boundary instead of immediately interrupting tool execution, allowing sibling tools to complete naturally without being skipped.
- Skip result messages now correctly identify the source of steering: for IRC exchanges, the peer name is included (e.g., "Skipped due to incoming IRC message from <peer>"), and for real user interrupts, "user message" is used.
