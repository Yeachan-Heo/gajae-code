### Changed

- **Breaking (SDK):** Documented the `MapReduceInput` field rename that shipped in 0.19.0 (#7109) without a migration note. On the type exported from `@gajae-code/coding-agent/commit/map-reduce`, `smolModel` is now `secondaryModel`, `smolApiKey` is now `secondaryApiKey`, and `smolThinkingLevel` is now `secondaryThinkingLevel`. The old names are not accepted as aliases; callers of `runMapReduceAnalysis` must pass the new field names.
