### Breaking Changes

- Migration note for the `MapReduceInput` type exported from `@gajae-code/coding-agent/commit/map-reduce`: since 0.19.0 (#7109) its fields are renamed from `smolModel` to `secondaryModel`, `smolApiKey` to `secondaryApiKey`, and `smolThinkingLevel` to `secondaryThinkingLevel`. The old names are not accepted as aliases; callers of `runMapReduceAnalysis` must pass the new field names.
